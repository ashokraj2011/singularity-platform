#!/usr/bin/env python3
"""Guard Context Fabric profile capability evidence.

Agent-profile execution must leave enough durable evidence to prove the exact
effective capability set that shaped a run. This check keeps the call-log
schema, execute persistence paths, receipt envelope, docs, and tests aligned.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CALL_LOG = ROOT / "context-fabric/services/context_api_service/app/call_log.py"
EXECUTE = ROOT / "context-fabric/services/context_api_service/app/execute.py"
RECEIPTS = ROOT / "context-fabric/services/context_api_service/app/receipts.py"
TEST = ROOT / "context-fabric/tests/test_profile_snapshot_receipts.py"
HANDBOOK = ROOT / "docs/platform-handbook.md"
TRACE_SPINE = ROOT / "bin/test-trace-spine.sh"


def fail(message: str) -> None:
    print(f"FAIL {message}", file=sys.stderr)
    raise SystemExit(1)


def ok(message: str) -> None:
    print(f"OK {message}")


def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except Exception as exc:
        fail(f"could not read {path.relative_to(ROOT)}: {exc}")


def call_log_audit_keys(source: str) -> set[str]:
    tree = ast.parse(source, filename=str(CALL_LOG))
    for node in tree.body:
        if isinstance(node, ast.Assign):
            names = {target.id for target in node.targets if isinstance(target, ast.Name)}
            if "_CAPABILITY_AUDIT_KEYS" in names:
                try:
                    value = ast.literal_eval(node.value)
                except Exception as exc:
                    fail(f"_CAPABILITY_AUDIT_KEYS must be literal: {exc}")
                if not isinstance(value, tuple):
                    fail("_CAPABILITY_AUDIT_KEYS must be a tuple")
                return {str(item) for item in value}
    fail("missing _CAPABILITY_AUDIT_KEYS in call_log.py")


def main() -> int:
    call_log = read(CALL_LOG)
    execute = read(EXECUTE)
    receipts = read(RECEIPTS)
    test = read(TEST)
    handbook = read(HANDBOOK)
    trace_spine = read(TRACE_SPINE)

    for column in (
        "profile_snapshot_hash",
        "profile_provider_resolutions_json",
        "profile_effective_capabilities_json",
    ):
        if column not in call_log:
            fail(f"call_log.py missing {column}")
    ok("call_log schema includes profile evidence columns")

    if "_compact_effective_capabilities" not in call_log:
        fail("call_log.py missing compact effective-capability persistence")
    audit_keys = call_log_audit_keys(call_log)
    for key in (
        "id",
        "sourceType",
        "sourceRef",
        "permissions",
        "readOnly",
        "providerLocked",
        "providerManifestDigest",
        "providerManifestSignatureKeyId",
        "providerManifestSigned",
    ):
        if key not in audit_keys:
            fail(f"_CAPABILITY_AUDIT_KEYS missing {key}")
    forbidden = audit_keys & {"schema", "inputSchema", "outputSchema", "invocationEndpoint", "endpointUrl", "endpoint_url"}
    if forbidden:
        fail("durable capability audit keys include runtime-only/leaky field(s): " + ", ".join(sorted(forbidden)))
    ok("call_log compact snapshot keeps provenance/permissions and excludes runtime endpoints")

    if call_log.count("profile_effective_capabilities_json") < 4:
        fail("call_log.py does not hydrate/insert profile_effective_capabilities_json consistently")
    if "json.dumps(_compact_effective_capabilities(record.get(\"profile_effective_capabilities\")))" not in call_log:
        fail("call_log.insert does not persist compact profile_effective_capabilities")
    ok("call_log insert/hydration contract covers profile effective capabilities")

    if "effective_capabilities: list[dict[str, Any]]" not in execute:
        fail("RunContext does not expose effective_capabilities")
    if execute.count('"profile_effective_capabilities"') < 3:
        fail("execute.py does not persist profile_effective_capabilities on all call-log paths")
    if '"profileProviderResolutions": profile_provider_resolutions' not in execute:
        fail("execute.py does not forward provider resolution evidence")
    ok("Context Fabric execute paths preserve profile evidence")

    for marker in (
        "profileEffectiveCapabilities",
        "profileProviderResolutions",
        "profile_effective_capability_summary",
    ):
        if marker not in receipts:
            fail(f"receipts.py missing {marker}")
    ok("receipts expose profile capability evidence and summary")

    for marker in (
        "schema\" not in row[\"profile_effective_capabilities\"]",
        "invocationEndpoint\" not in row[\"profile_effective_capabilities\"]",
        "profile_effective_capability_summary",
    ):
        if marker not in test:
            fail(f"profile snapshot receipt test missing assertion marker: {marker}")
    ok("profile snapshot receipt regression test covers compaction")

    if "profileEffectiveCapabilities" not in handbook or "compact" not in handbook:
        fail("platform handbook does not document compact profileEffectiveCapabilities receipt evidence")
    ok("platform handbook documents compact profile capability evidence")

    for column in (
        "profile_snapshot_hash",
        "profile_provider_resolutions_json",
        "profile_effective_capabilities_json",
    ):
        if column not in trace_spine:
            fail(f"trace spine smoke does not verify live {column}")
    ok("trace spine smoke checks live profile evidence columns")

    print("OK Context Fabric profile evidence contract passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
