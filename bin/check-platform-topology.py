#!/usr/bin/env python3
"""Explain and validate the active Singularity Docker topology.

This is intentionally broader than check-agent-tools-topology.sh. It answers the
operator question "what containers are part of the default platform now?" while
also failing on accidental mixed topologies, such as running legacy frontend
containers next to platform-web or split agent/tool services next to
platform-core.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]
TOPOLOGY_CONTRACT = ROOT / "docs/platform-topology.json"


def load_topology_contract() -> dict:
    with TOPOLOGY_CONTRACT.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if data.get("version") != 1:
        raise RuntimeError(f"unsupported topology contract version in {TOPOLOGY_CONTRACT}")
    return data


@dataclass(frozen=True)
class ComposeService:
    service: str
    state: str
    status: str
    health: str
    ports: str

    @property
    def running(self) -> bool:
        return self.state == "running"

    @property
    def completed(self) -> bool:
        return self.state == "exited" and "Exited (0)" in self.status


def run_compose_ps() -> list[ComposeService]:
    proc = subprocess.run(
        ["docker", "compose", "ps", "--all", "--format", "json"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        message = (proc.stderr or proc.stdout or "docker compose ps failed").strip()
        raise RuntimeError(message)

    services: list[ComposeService] = []
    for line in proc.stdout.splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        services.append(
            ComposeService(
                service=str(row.get("Service") or ""),
                state=str(row.get("State") or ""),
                status=str(row.get("Status") or ""),
                health=str(row.get("Health") or ""),
                ports=str(row.get("Ports") or ""),
            )
        )
    return sorted(services, key=lambda item: item.service)


def names(items: Iterable[ComposeService]) -> set[str]:
    return {item.service for item in items}


def print_group(title: str, rows: list[tuple[str, str, str]]) -> None:
    print(f"\n{title}")
    if not rows:
        print("  none")
        return
    width = max(len(name) for name, _, _ in rows)
    for name, state, note in rows:
        print(f"  {name:<{width}}  {state:<10}  {note}")


def state_label(service: str, by_name: dict[str, ComposeService]) -> str:
    item = by_name.get(service)
    if item is None:
        return "missing"
    if item.health:
        return f"{item.state}/{item.health}"
    return item.state


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="emit machine-readable topology summary")
    parser.add_argument(
        "--strict-core",
        action="store_true",
        help="also fail if optional local runtime containers are running",
    )
    args = parser.parse_args()

    try:
        contract = load_topology_contract()
        services = run_compose_ps()
    except Exception as exc:  # pragma: no cover - defensive CLI path
        print(f"FAIL topology: {exc}", file=sys.stderr)
        return 1

    core_running: dict[str, str] = contract["defaultCore"]["requiredRunning"]
    one_shot_completed: dict[str, str] = contract["defaultCore"]["oneShotCompleted"]
    split_agent_tools = set(contract["agentTools"]["splitDebugServices"])
    legacy_frontends = set(contract["legacyFrontends"])
    optional_runtime: dict[str, str] = contract["optionalRuntime"]
    agent_tools_ports: dict[str, int] = contract["agentTools"]["apiPorts"]

    by_name = {item.service: item for item in services}
    running = [item for item in services if item.running]
    running_names = names(running)
    all_names = names(services)

    missing_core = sorted(set(core_running) - running_names)
    completed_one_shots = sorted(name for name in one_shot_completed if by_name.get(name) and by_name[name].completed)
    incomplete_one_shots = sorted(name for name in one_shot_completed if name in all_names and name not in completed_one_shots)
    running_split = sorted(split_agent_tools & running_names)
    running_legacy = sorted(legacy_frontends & running_names)
    running_optional = sorted(set(optional_runtime) & running_names)
    stopped_legacy = sorted(name for name in legacy_frontends if name in all_names and name not in running_names)

    failures: list[str] = []
    warnings: list[str] = []

    if missing_core:
        failures.append(f"missing core service(s): {', '.join(missing_core)}")
    if "platform-core" in running_names and running_split:
        failures.append(f"platform-core is mixed with split agent/tools service(s): {', '.join(running_split)}")
    elif running_split and len(running_split) != len(split_agent_tools):
        failures.append(f"partial split agent/tools topology: {len(running_split)}/{len(split_agent_tools)} running ({', '.join(running_split)})")
    if running_legacy:
        failures.append(f"legacy frontend container(s) running next to platform-web: {', '.join(running_legacy)}")
    if incomplete_one_shots:
        failures.append(f"one-shot bootstrap did not complete cleanly: {', '.join(incomplete_one_shots)}")
    if args.strict_core and running_optional:
        failures.append(f"optional runtime container(s) running in strict core mode: {', '.join(running_optional)}")
    elif running_optional:
        warnings.append(f"optional local runtime container(s) running: {', '.join(running_optional)}")
    if stopped_legacy:
        warnings.append(f"legacy/debug frontend remnants exist but are stopped: {', '.join(stopped_legacy)}")

    summary = {
        "runningContainerCount": len(running),
        "coreRequiredCount": len(core_running),
        "topologyContract": str(TOPOLOGY_CONTRACT.relative_to(ROOT)),
        "missingCore": missing_core,
        "completedOneShots": completed_one_shots,
        "runningOptionalRuntime": running_optional,
        "runningLegacyFrontends": running_legacy,
        "stoppedLegacyFrontends": stopped_legacy,
        "runningSplitAgentTools": running_split,
        "failures": failures,
        "warnings": warnings,
    }

    if args.json:
        print(json.dumps(summary, indent=2, sort_keys=True))
    else:
        print("Singularity platform topology")
        print(f"  running containers: {len(running)}")
        print("  default UI containers: 1 (platform-web)")
        print("  default agent/tools backend containers: 1 (platform-core)")
        print("  LLM Gateway and MCP are optional/remote-capable, not required local core containers.")

        print_group(
            "Core product containers",
            [(name, state_label(name, by_name), core_running[name]) for name in sorted(core_running)],
        )
        print_group(
            "One-shot containers",
            [(name, state_label(name, by_name), one_shot_completed[name]) for name in sorted(one_shot_completed)],
        )
        print_group(
            "Agent/tools API ports served by platform-core",
            [
                (name, str(port), "served inside platform-core")
                for name, port in agent_tools_ports.items()
            ],
        )
        print_group(
            "Optional local runtime containers",
            [(name, state_label(name, by_name), optional_runtime[name]) for name in sorted(optional_runtime) if name in all_names],
        )
        if stopped_legacy or running_legacy:
            print_group(
                "Legacy/debug frontend containers",
                [(name, state_label(name, by_name), "frontend-legacy/deprecated only") for name in sorted(legacy_frontends & all_names)],
            )

        for warning in warnings:
            print(f"WARN {warning}")
        for failure in failures:
            print(f"FAIL {failure}", file=sys.stderr)
        if not failures:
            print("OK platform topology check passed")

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
