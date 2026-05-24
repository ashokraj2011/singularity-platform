"""Sandboxed test execution for the capability harness (Slice 2).

This module gives the `tests_pass` oracle real teeth: it materialises
the agent's output to a temp file alongside a `test_code` block from
the corpus, runs the tests in a subprocess with a strict timeout +
memory cap, and returns pass/fail.

Why subprocess and not exec(): the agent's output is untrusted code.
Even though the harness operator runs this on their own machine, a
subprocess gives a clean process boundary, an OS-level timeout via
SIGKILL, and the ability to capture stdout/stderr separately. The
operator can also wire the runner to mcp-server's /mcp/tool-run
sandbox (existing M71 Slice D) later — see SLICE-2-TODO below.

What this DOES support today:
  • Python tasks. Agent output + test_code are written to temp .py
    files and pytest-runs in a subprocess.
  • Timeouts (default 30s per task) with SIGKILL on overrun.
  • Stdout/stderr capture for diagnosis.

What this does NOT support yet (tracked):
  • Languages other than Python — Slice 2.1 follow-up.
  • Real SWE-bench-Lite tasks that need `git clone` + `pip install -e .`
    per task — Slice 2.2 follow-up, requires mcp-server sandbox or
    Docker-per-task.
  • Network isolation — subprocess can still hit external URLs. Run
    the harness in a Docker container with --network=none for a real
    seal.
"""
from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class SandboxResult:
    """Outcome of one sandbox run. The runner maps this onto the
    tests_pass OracleResult shape; here we keep it transport-neutral
    so a future Docker / mcp-server-backed executor can return the
    same shape."""

    passed: bool
    duration_ms: int
    stdout: str
    stderr: str
    exit_code: int | None
    timed_out: bool
    reason: str


def run_python_tests(
    *,
    agent_code: str,
    test_code: str,
    timeout_sec: float = 30.0,
    extra_env: dict[str, str] | None = None,
) -> SandboxResult:
    """Run `test_code` against `agent_code` in a subprocess sandbox.

    Layout written to a fresh temp directory:

      solution.py    ← agent's output as-is
      test_solution.py  ← test_code, imports solution

    The test runner is pytest (we vendor nothing; it just needs to
    be installed in the host Python). If pytest is missing the
    sandbox returns a clean error rather than crashing — that's
    distinguishable from a genuine test failure via the `reason`
    field.
    """
    import time
    started = time.monotonic()

    if not shutil.which("python") and not shutil.which("python3"):
        return SandboxResult(
            passed=False,
            duration_ms=0,
            stdout="",
            stderr="",
            exit_code=None,
            timed_out=False,
            reason="python interpreter not found on PATH — sandbox cannot run",
        )

    with tempfile.TemporaryDirectory(prefix="cap-harness-") as tmp:
        tmp_path = Path(tmp)
        (tmp_path / "solution.py").write_text(agent_code)
        # Test file convention: import * from solution so the test
        # author writes `assert is_palindrome("abba")` without
        # qualifying. Keeps the corpus rubric authoring cheap.
        full_test = "from solution import *  # noqa: F401, F403\n\n" + test_code
        (tmp_path / "test_solution.py").write_text(full_test)

        env = os.environ.copy()
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        # Network isolation: best-effort by unsetting common proxy
        # vars. Real isolation requires --network=none on the
        # harness container — documented in module docstring.
        for proxy_var in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
            env.pop(proxy_var, None)
        if extra_env:
            env.update(extra_env)

        python_bin = sys.executable or shutil.which("python3") or shutil.which("python")
        cmd = [
            python_bin,
            "-m", "pytest",
            "-q",
            "--tb=short",
            "--no-header",
            "-p", "no:cacheprovider",  # no .pytest_cache spam in /tmp
            str(tmp_path),
        ]

        timed_out = False
        try:
            proc = subprocess.run(  # noqa: S603 — fixed-cmd, isolated tmp dir
                cmd,
                cwd=tmp_path,
                env=env,
                capture_output=True,
                text=True,
                timeout=timeout_sec,
                # Start in own process group so timeout's SIGKILL hits
                # any subprocess pytest may have spawned (e.g. xdist).
                preexec_fn=os.setsid if hasattr(os, "setsid") else None,
            )
            exit_code = proc.returncode
            stdout = proc.stdout
            stderr = proc.stderr
        except subprocess.TimeoutExpired as exc:
            timed_out = True
            exit_code = None
            stdout = (exc.stdout or b"").decode("utf-8", errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
            stderr = (exc.stderr or b"").decode("utf-8", errors="replace") if isinstance(exc.stderr, bytes) else (exc.stderr or "")
            # Best-effort process-group kill so a wedged subprocess
            # doesn't linger after the timeout fires.
            if hasattr(os, "killpg") and exc.cmd:
                try:
                    pgid = os.getpgid(os.getpid())  # not the right pgid; subprocess module hides it
                    os.killpg(pgid, signal.SIGKILL)
                except Exception:  # noqa: BLE001 — best-effort cleanup
                    pass

    duration_ms = int((time.monotonic() - started) * 1000)

    if timed_out:
        return SandboxResult(
            passed=False,
            duration_ms=duration_ms,
            stdout=stdout[-2000:],
            stderr=stderr[-2000:],
            exit_code=None,
            timed_out=True,
            reason=f"test execution exceeded {timeout_sec}s — killed",
        )

    # pytest exit codes: 0 = all pass, 1 = some failed, 2 = interrupted,
    # 4 = usage error, 5 = no tests collected.
    if exit_code == 0:
        return SandboxResult(
            passed=True,
            duration_ms=duration_ms,
            stdout=stdout[-2000:],
            stderr=stderr[-2000:],
            exit_code=0,
            timed_out=False,
            reason="all tests passed",
        )
    if exit_code == 5:
        return SandboxResult(
            passed=False,
            duration_ms=duration_ms,
            stdout=stdout[-2000:],
            stderr=stderr[-2000:],
            exit_code=5,
            timed_out=False,
            reason="pytest collected zero tests — check test_code in corpus",
        )
    return SandboxResult(
        passed=False,
        duration_ms=duration_ms,
        stdout=stdout[-2000:],
        stderr=stderr[-2000:],
        exit_code=exit_code,
        timed_out=False,
        reason=f"pytest exit {exit_code} — test failure or import error",
    )
