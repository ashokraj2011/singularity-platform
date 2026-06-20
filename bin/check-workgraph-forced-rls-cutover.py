#!/usr/bin/env python3
"""Non-mutating contract check for the Workgraph forced-RLS cutover script."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import os
import sys
import tempfile
from pathlib import Path
from types import ModuleType, SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "bin/enable-workgraph-forced-rls.py"


def load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("enable_workgraph_forced_rls", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Patch:
    def __init__(self, obj: object, name: str, value: object) -> None:
        self.obj = obj
        self.name = name
        self.value = value
        self.original = getattr(obj, name)

    def __enter__(self) -> None:
        setattr(self.obj, self.name, self.value)

    def __exit__(self, *_exc: object) -> None:
        setattr(self.obj, self.name, self.original)


class EnvPatch:
    def __init__(self, values: dict[str, str | None]) -> None:
        self.values = values
        self.originals: dict[str, str | None] = {}

    def __enter__(self) -> None:
        for key, value in self.values.items():
            self.originals[key] = os.environ.get(key)
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def __exit__(self, *_exc: object) -> None:
        for key, value in self.originals.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def run_main(module: ModuleType, args: list[str], *, checker_code: int = 0) -> tuple[int | str, str, list[list[str]], list[bool]]:
    psql_calls: list[list[str]] = []
    checker_calls: list[bool] = []

    def fake_resolve_database_url(_explicit: str | None) -> str:
        return "postgresql://workgraph.example/workgraph"

    def fake_run_checker(_database_url: str, require_rls: bool) -> int:
        checker_calls.append(require_rls)
        print(f"checker require_rls={require_rls}")
        return checker_code

    def fake_psql(database_url: str, psql_args: list[str]) -> SimpleNamespace:
        psql_args = [database_url, *psql_args]
        psql_calls.append(psql_args)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    with tempfile.TemporaryDirectory() as tmp:
        checker = Path(tmp) / "check-workgraph-db-tenant-isolation.py"
        scaffold = Path(tmp) / "tenant_rls.sql"
        checker.write_text("#!/usr/bin/env python3\n")
        scaffold.write_text("-- scaffold\n")

        buffer = io.StringIO()
        with (
            Patch(module, "CHECKER", checker),
            Patch(module, "RLS_SCAFFOLD", scaffold),
            Patch(module, "resolve_database_url", fake_resolve_database_url),
            Patch(module, "run_checker", fake_run_checker),
            Patch(module, "psql", fake_psql),
            Patch(sys, "argv", ["enable-workgraph-forced-rls.py", *args]),
            contextlib.redirect_stdout(buffer),
            contextlib.redirect_stderr(buffer),
        ):
            try:
                result = module.main()
            except SystemExit as exc:
                result = exc.code
        return result, buffer.getvalue(), psql_calls, checker_calls


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    if not SCRIPT.exists():
        print(f"FAIL missing cutover script: {SCRIPT.relative_to(ROOT)}", file=sys.stderr)
        return 1

    module = load_script()
    failures: list[str] = []

    try:
        sql = module.enable_sql()
        for table in module.TENANT_TABLES:
            assert_true(
                f'ALTER TABLE public."{table}" ENABLE ROW LEVEL SECURITY;' in sql,
                f"missing ENABLE RLS statement for {table}",
            )
            assert_true(
                f'ALTER TABLE public."{table}" FORCE ROW LEVEL SECURITY;' in sql,
                f"missing FORCE RLS statement for {table}",
            )
        print(f"OK forced-RLS SQL covers {len(module.TENANT_TABLES)} tenant-sensitive tables")
    except Exception as exc:
        failures.append(str(exc))

    try:
        with EnvPatch({"TENANT_ISOLATION_MODE": None, "REQUIRE_TENANT_ID": None}):
            result, output, psql_calls, checker_calls = run_main(module, [])
        assert_true(result == 0, f"dry-run returned {result}")
        assert_true(psql_calls == [], "dry-run should not execute psql mutations")
        assert_true(checker_calls == [False], "dry-run should run one non-RLS preflight check")
        assert_true("dry-run only" in output, "dry-run output must explain how to apply")
        print("OK dry-run is non-mutating and preflighted")
    except Exception as exc:
        failures.append(str(exc))

    try:
        with EnvPatch({"TENANT_ISOLATION_MODE": None, "REQUIRE_TENANT_ID": None}):
            result, output, psql_calls, _checker_calls = run_main(module, ["--apply"])
        assert_true(isinstance(result, str) and "refusing to force RLS" in result, "apply without strict confirmation must fail closed")
        assert_true(psql_calls == [], "failed apply must not execute psql")
        assert_true("preflight" not in output, "strict-runtime refusal should happen before DB preflight")
        print("OK apply refuses without strict-runtime confirmation")
    except Exception as exc:
        failures.append(str(exc))

    try:
        with EnvPatch({"TENANT_ISOLATION_MODE": "strict", "REQUIRE_TENANT_ID": "true"}):
            result, _output, psql_calls, checker_calls = run_main(module, [
                "--database-url",
                "postgresql://app.example/workgraph",
                "--admin-database-url",
                "postgresql://admin.example/workgraph",
                "--apply",
            ])
        assert_true(result == 0, f"strict env apply returned {result}")
        assert_true(len(psql_calls) == 2, f"apply should run scaffold and forced-RLS SQL, saw {len(psql_calls)} psql calls")
        assert_true(
            all(call[0] == "postgresql://admin.example/workgraph" for call in psql_calls),
            "RLS scaffold and ALTER TABLE statements must run with the admin database URL",
        )
        assert_true(checker_calls == [False, True], "apply must run preflight and postflight require-RLS checks")
        print("OK strict env apply path runs scaffold, RLS SQL, and postflight")
    except Exception as exc:
        failures.append(str(exc))

    try:
        with EnvPatch({"TENANT_ISOLATION_MODE": "strict", "REQUIRE_TENANT_ID": "true"}):
            result, _output, psql_calls, checker_calls = run_main(module, ["--apply"], checker_code=1)
        assert_true(result == 1, f"failed preflight returned {result}")
        assert_true(psql_calls == [], "failed preflight must not execute psql")
        assert_true(checker_calls == [False], "failed preflight should stop before postflight")
        print("OK failed preflight blocks forced-RLS mutation")
    except Exception as exc:
        failures.append(str(exc))

    if failures:
        for failure in failures:
            print(f"FAIL {failure}", file=sys.stderr)
        return 1
    print("OK Workgraph forced-RLS cutover contract passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
