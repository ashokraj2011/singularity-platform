#!/usr/bin/env python3
"""Validate the canonical Platform topology contract.

`docs/platform-topology.json` is the machine-readable source for the default
Docker core, optional runtime inventory, legacy frontend set, and selected
profile invariants. This check keeps compose, docs, and topology scripts from
silently growing separate service inventories.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PATH = ROOT / "docs/platform-topology.json"


def fail(message: str) -> None:
    print(f"FAIL {message}", file=sys.stderr)
    raise SystemExit(1)


def ok(message: str) -> None:
    print(f"OK {message}")


def compose_services(profile: str | None = None) -> set[str]:
    p = profile or os.environ.get("COMPOSE_PROFILES") or "core"
    env = {**os.environ, "COMPOSE_PROFILES": p}
    proc = subprocess.run(
        ["docker", "compose", "config", "--services"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
        env=env,
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "docker compose config failed").strip().splitlines()[0]
        fail(f"compose config failed for profile={profile or 'default'}: {detail}")
    return {line.strip() for line in proc.stdout.splitlines() if line.strip()}


def read_contract() -> dict:
    try:
        data = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    except Exception as exc:
        fail(f"could not parse {CONTRACT_PATH.relative_to(ROOT)}: {exc}")
    if data.get("version") != 1:
        fail("topology contract version must be 1")
    return data


def main() -> int:
    contract = read_contract()
    required_running = set(contract["defaultCore"]["requiredRunning"])
    one_shots = set(contract["defaultCore"]["oneShotCompleted"])
    split = set(contract["agentTools"]["splitDebugServices"])
    legacy = set(contract["legacyFrontends"])

    default_services = compose_services()
    missing_default = sorted((required_running | one_shots) - default_services)
    if missing_default:
        fail(f"default compose is missing topology contract service(s): {', '.join(missing_default)}")
    ok("default compose includes all core and bootstrap services from topology contract")

    unexpected_default = sorted((split | legacy) & default_services)
    if unexpected_default:
        fail(f"default compose unexpectedly includes split/legacy service(s): {', '.join(unexpected_default)}")
    ok("default compose excludes split agent/tools and legacy frontend services")

    if len(required_running) != 8:
        fail(f"default core requiredRunning count is {len(required_running)}; expected 8")
    ok("default core count is 8")

    for profile, rules in contract.get("profiles", {}).items():
        services = compose_services(profile)
        missing = sorted(set(rules.get("mustInclude", [])) - services)
        present = sorted(set(rules.get("mustExclude", [])) & services)
        if missing:
            fail(f"profile {profile} missing required service(s): {', '.join(missing)}")
        if present:
            fail(f"profile {profile} includes forbidden service(s): {', '.join(present)}")
        ok(f"profile {profile} matches topology contract")

    topology_guard = (ROOT / "bin/check-platform-topology.py").read_text(encoding="utf-8")
    if "docs/platform-topology.json" not in topology_guard:
        fail("check-platform-topology.py does not load docs/platform-topology.json")
    ok("platform topology guard reads topology contract")

    docs_to_check = [
        ROOT / "README.md",
        ROOT / "docs/platform-handbook.md",
    ]
    for path in docs_to_check:
        text = path.read_text(encoding="utf-8")
        missing_names = sorted(name for name in required_running if name not in text)
        if missing_names:
            fail(f"{path.relative_to(ROOT)} does not mention core service(s): {', '.join(missing_names)}")
        if "docs/platform-topology.json" not in text:
            fail(f"{path.relative_to(ROOT)} does not point operators at docs/platform-topology.json")
        ok(f"{path.relative_to(ROOT)} references topology contract and core services")

    print("OK platform topology contract passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
