#!/usr/bin/env python3
"""Explain code changes between two dates using local git history.

The output is deterministic and offline: commits, changed files, category
rollups, risk signals, and suggested verification are derived from git only.
Use it for release notes, audit evidence, and "what changed since <date>?"
operator questions.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
FIELD_SEP = "\x1f"
RECORD_SEP = "\x1e"


@dataclass(frozen=True)
class Commit:
    sha: str
    short: str
    date: str
    author: str
    subject: str
    files: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class FileStat:
    path: str
    additions: int
    deletions: int
    binary: bool = False

    @property
    def churn(self) -> int:
        return self.additions + self.deletions


@dataclass(frozen=True)
class CategorySummary:
    name: str
    commit_count: int
    file_count: int
    additions: int
    deletions: int
    subjects: list[str]
    files: list[str]


def run_git(repo: Path, args: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        text=True,
        capture_output=True,
        check=check,
    )


def normalize_date(raw: str, *, end_of_day: bool) -> str:
    value = raw.strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return f"{value} {'23:59:59' if end_of_day else '00:00:00'}"
    return value


def load_commits(
    repo: Path,
    since: str,
    until: str,
    paths: list[str],
    author: str | None,
    no_merges: bool,
    max_commits: int,
) -> list[Commit]:
    command = [
        "log",
        "--reverse",
        f"--since={since}",
        f"--until={until}",
        "--date=iso-strict",
        f"--max-count={max_commits}",
        f"--pretty=format:%H{FIELD_SEP}%h{FIELD_SEP}%ad{FIELD_SEP}%an{FIELD_SEP}%s{RECORD_SEP}",
    ]
    if author:
        command.append(f"--author={author}")
    if no_merges:
        command.append("--no-merges")
    if paths:
        command.extend(["--", *paths])

    proc = run_git(repo, command)
    commits: list[Commit] = []
    for record in proc.stdout.split(RECORD_SEP):
        record = record.strip()
        if not record:
            continue
        parts = record.split(FIELD_SEP)
        if len(parts) != 5:
            continue
        sha, short, date, commit_author, subject = parts
        commits.append(Commit(sha=sha, short=short, date=date, author=commit_author, subject=subject, files=[]))

    return [Commit(**{**asdict(commit), "files": load_commit_files(repo, commit.sha, paths)}) for commit in commits]


def load_commit_files(repo: Path, sha: str, paths: list[str]) -> list[str]:
    command = ["show", "--pretty=format:", "--name-only", "--diff-filter=ACMRTUXB", sha]
    if paths:
        command.extend(["--", *paths])
    proc = run_git(repo, command, check=False)
    if proc.returncode != 0:
        return []
    return sorted({line.strip() for line in proc.stdout.splitlines() if line.strip()})


def first_parent_or_empty_tree(repo: Path, sha: str) -> str:
    proc = run_git(repo, ["rev-parse", f"{sha}^"], check=False)
    if proc.returncode == 0 and proc.stdout.strip():
        return proc.stdout.strip()
    return EMPTY_TREE


def load_file_stats(repo: Path, commits: list[Commit], paths: list[str]) -> list[FileStat]:
    if not commits:
        return []
    base = first_parent_or_empty_tree(repo, commits[0].sha)
    head = commits[-1].sha
    command = ["diff", "--numstat", "--find-renames", base, head]
    if paths:
        command.extend(["--", *paths])
    proc = run_git(repo, command)
    stats: list[FileStat] = []
    for line in proc.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        additions_raw, deletions_raw, path = parts[0], parts[1], "\t".join(parts[2:])
        binary = additions_raw == "-" or deletions_raw == "-"
        additions = 0 if binary else int(additions_raw)
        deletions = 0 if binary else int(deletions_raw)
        stats.append(FileStat(path=normalize_rename_path(path), additions=additions, deletions=deletions, binary=binary))
    return sorted(stats, key=lambda item: (-item.churn, item.path))


def normalize_rename_path(path: str) -> str:
    # Git numstat reports renames as "old => new" or "{old => new}/file".
    if " => " not in path:
        return path
    if path.startswith("{") and "}" in path:
        return path
    return path.split(" => ", 1)[-1]


def category_for_path(path: str) -> str:
    lower = path.lower()
    if lower.startswith("agent-and-tools/web/") or lower.startswith("workgraph-studio/apps/web/") or lower.startswith("workgraph-studio/apps/blueprint-workbench/"):
        return "Frontend / Platform Web"
    if lower.startswith("workgraph-studio/") or "/workflow" in lower or "/planner" in lower:
        return "Workflow / Workgraph"
    if lower.startswith("agent-and-tools/apps/agent-runtime/") or lower.startswith("agent-and-tools/apps/agent-service/") or lower.startswith("agent-and-tools/apps/tool-service/"):
        return "Agent Runtime / Tools"
    if lower.startswith("context-fabric/") or lower.startswith("mcp-server/") or lower.startswith("llm-gateway/") or "runtime-bridge" in lower:
        return "Context Fabric / MCP / LLM"
    if lower.startswith("singularity-iam-service/") or lower.startswith("audit-governance-service/") or "/identity/" in lower or "governance" in lower:
        return "Identity / Governance / Audit"
    if lower.startswith("bin/") or "docker" in lower or "compose" in lower or lower.endswith(".sh") or lower.endswith("dockerfile") or "nginx" in lower:
        return "Deployment / Scripts / Docker"
    if lower.startswith("docs/") or lower.endswith(".md") or lower.endswith(".html"):
        return "Docs"
    if "test" in lower or "spec" in lower or lower.startswith("tests/"):
        return "Tests / Verification"
    if "prisma" in lower or "migration" in lower or "seed" in lower or lower.endswith(".sql"):
        return "Data / Migrations / Seeds"
    return "Other"


def build_categories(commits: list[Commit], stats: list[FileStat]) -> list[CategorySummary]:
    stats_by_path = {item.path: item for item in stats}
    commits_by_category: dict[str, list[Commit]] = defaultdict(list)
    files_by_category: dict[str, set[str]] = defaultdict(set)

    for commit in commits:
        categories = {category_for_path(path) for path in commit.files} or {"Other"}
        for category in categories:
            commits_by_category[category].append(commit)
        for path in commit.files:
            files_by_category[category_for_path(path)].add(path)

    summaries: list[CategorySummary] = []
    for category, category_commits in commits_by_category.items():
        files = sorted(files_by_category[category])
        additions = sum(stats_by_path.get(path, FileStat(path, 0, 0)).additions for path in files)
        deletions = sum(stats_by_path.get(path, FileStat(path, 0, 0)).deletions for path in files)
        top_files = sorted(files, key=lambda path: (-(stats_by_path.get(path, FileStat(path, 0, 0)).churn), path))[:8]
        subjects = []
        seen_subjects = set()
        for commit in reversed(category_commits):
            if commit.subject not in seen_subjects:
                subjects.append(commit.subject)
                seen_subjects.add(commit.subject)
            if len(subjects) >= 5:
                break
        summaries.append(
            CategorySummary(
                name=category,
                commit_count=len({commit.sha for commit in category_commits}),
                file_count=len(files),
                additions=additions,
                deletions=deletions,
                subjects=subjects,
                files=top_files,
            )
        )
    return sorted(summaries, key=lambda item: (-item.commit_count, -item.file_count, item.name))


def risk_signals(commits: list[Commit], stats: list[FileStat]) -> list[str]:
    subjects = " ".join(commit.subject.lower() for commit in commits)
    paths = [item.path for item in stats]
    lower_paths = " ".join(path.lower() for path in paths)
    signals: list[str] = []
    if re.search(r"\b(auth|jwt|token|secret|permission|tenant|rls)\b", subjects + " " + lower_paths):
        signals.append("Security/auth/tenant-sensitive files or commit messages changed.")
    if re.search(r"\b(migration|prisma|schema|seed|\.sql)\b", lower_paths):
        signals.append("Database schema, migration, seed, or Prisma files changed.")
    if re.search(r"\b(docker|compose|nginx|bare-metal|setup|doctor|deploy)\b", subjects + " " + lower_paths):
        signals.append("Deployment, container, or operator script behavior changed.")
    if re.search(r"\b(context-fabric|runtime-bridge|mcp|llm|gateway)\b", subjects + " " + lower_paths):
        signals.append("Runtime fabric, MCP, or LLM routing changed.")
    if any(item.deletions > item.additions * 3 and item.deletions > 120 for item in stats):
        signals.append("Large deletion-heavy file changes exist; review for removed behavior or route loss.")
    if not signals:
        signals.append("No high-risk signals detected from paths or commit subjects.")
    return signals


def suggested_verification(categories: Iterable[CategorySummary]) -> list[str]:
    names = {category.name for category in categories}
    checks: list[str] = []
    if "Frontend / Platform Web" in names:
        checks.extend(["cd agent-and-tools/web && npm run build", "cd agent-and-tools/web && npm run test:routes"])
    if "Workflow / Workgraph" in names:
        checks.append("Run Workgraph API tests or at minimum open /workflows, /workflows/start, and /runs in Platform Web.")
    if "Context Fabric / MCP / LLM" in names:
        checks.append("Run Context Fabric/MCP runtime bridge smoke with X-Service-Token on /api/runtime-bridge/status, then test one tool-run/model-run path.")
    if "Agent Runtime / Tools" in names:
        checks.append("Run agent profile/tool lifecycle smoke checks and verify /agents/studio.")
    if "Deployment / Scripts / Docker" in names:
        checks.append("Run bin/doctor.sh plus the relevant docker/bare-metal smoke command.")
    if "Data / Migrations / Seeds" in names:
        checks.append("Apply migrations/seeds in a disposable clone or database before release.")
    if "Identity / Governance / Audit" in names:
        checks.append("Verify IAM login/token minting and audit-governance health.")
    if not checks:
        checks.append("Review changed files and run the nearest service/unit tests for touched areas.")
    return checks


def markdown_report(
    repo: Path,
    since: str,
    until: str,
    commits: list[Commit],
    stats: list[FileStat],
    categories: list[CategorySummary],
    risks: list[str],
    checks: list[str],
    paths: list[str],
) -> str:
    additions = sum(item.additions for item in stats)
    deletions = sum(item.deletions for item in stats)
    authors = Counter(commit.author for commit in commits)
    dominant = ", ".join(category.name for category in categories[:3]) or "none"
    scope = ", ".join(paths) if paths else "entire repository"

    lines = [
        "# Git History Change Explanation",
        "",
        f"- Repository: `{repo}`",
        f"- Date range: `{since}` → `{until}`",
        f"- Scope: `{scope}`",
        f"- Commits: `{len(commits)}`",
        f"- Files changed: `{len(stats)}`",
        f"- Line churn: `+{additions} / -{deletions}`",
        "",
        "## Executive Summary",
        "",
    ]
    if commits:
        lines.extend([
            f"Between the selected dates, the main work landed in **{dominant}**.",
            f"The range includes **{len(commits)} commit(s)** from **{len(authors)} author(s)** and changes **{len(stats)} file(s)** with **+{additions}/-{deletions}** cumulative line churn.",
        ])
    else:
        lines.append("No commits matched the selected date range and path filters.")

    lines.extend(["", "## Category Breakdown", ""])
    if categories:
        for category in categories:
            lines.extend([
                f"### {category.name}",
                f"- Commits: `{category.commit_count}`; files: `{category.file_count}`; churn: `+{category.additions}/-{category.deletions}`",
            ])
            if category.subjects:
                lines.append("- Recent subjects:")
                lines.extend(f"  - {subject}" for subject in category.subjects)
            if category.files:
                lines.append("- Hot files:")
                lines.extend(f"  - `{path}`" for path in category.files)
            lines.append("")
    else:
        lines.append("_No category data._")
        lines.append("")

    lines.extend(["## Risk Signals", ""])
    lines.extend(f"- {signal}" for signal in risks)

    lines.extend(["", "## Suggested Verification", ""])
    lines.extend(f"- `{check}`" if check.startswith(("cd ", "Run ", "Apply ", "Verify ", "Review ")) is False else f"- {check}" for check in checks)

    lines.extend(["", "## Commit Timeline", ""])
    if commits:
        lines.append("| Date | Commit | Author | Subject |")
        lines.append("|---|---|---|---|")
        for commit in commits:
            date = commit.date.split("T", 1)[0]
            lines.append(f"| {date} | `{commit.short}` | {commit.author} | {commit.subject.replace('|', '\\|')} |")
    else:
        lines.append("_No commits._")

    lines.extend(["", "## Top Changed Files", ""])
    if stats:
        lines.append("| File | + | - |")
        lines.append("|---|---:|---:|")
        for item in stats[:40]:
            plus = "binary" if item.binary else str(item.additions)
            minus = "binary" if item.binary else str(item.deletions)
            lines.append(f"| `{item.path}` | {plus} | {minus} |")
    else:
        lines.append("_No file changes._")

    lines.append("")
    return "\n".join(lines)


def json_report(
    repo: Path,
    since: str,
    until: str,
    commits: list[Commit],
    stats: list[FileStat],
    categories: list[CategorySummary],
    risks: list[str],
    checks: list[str],
    paths: list[str],
) -> str:
    return json.dumps(
        {
            "repository": str(repo),
            "since": since,
            "until": until,
            "scope": paths or ["."],
            "summary": {
                "commits": len(commits),
                "filesChanged": len(stats),
                "additions": sum(item.additions for item in stats),
                "deletions": sum(item.deletions for item in stats),
                "authors": dict(Counter(commit.author for commit in commits)),
            },
            "categories": [asdict(category) for category in categories],
            "riskSignals": risks,
            "suggestedVerification": checks,
            "commits": [asdict(commit) for commit in commits],
            "files": [asdict(item) for item in stats],
        },
        indent=2,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Explain code changes between two dates using git history.",
        epilog=(
            "Examples:\n"
            "  bin/explain-git-history.py 2026-06-20 2026-07-02\n"
            "  bin/explain-git-history.py --since '2026-06-20 09:00' --until '2026-06-21 18:00' --path agent-and-tools/web\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("since_arg", nargs="?", help="start date/time, for example 2026-06-20")
    parser.add_argument("until_arg", nargs="?", help="end date/time, for example 2026-07-02")
    parser.add_argument("--since", dest="since_opt", help="start date/time")
    parser.add_argument("--until", dest="until_opt", help="end date/time")
    parser.add_argument("--path", action="append", default=[], help="limit to a path; repeatable")
    parser.add_argument("--author", help="git author filter")
    parser.add_argument("--no-merges", action="store_true", help="exclude merge commits")
    parser.add_argument("--max-commits", type=int, default=250, help="maximum commits to explain")
    parser.add_argument("--format", choices=["markdown", "json"], default="markdown", help="output format")
    parser.add_argument("--output", help="write report to this file instead of stdout")
    parser.add_argument("--repo", default=str(ROOT), help="repository root; defaults to this monorepo")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    since_raw = args.since_opt or args.since_arg
    until_raw = args.until_opt or args.until_arg
    if not since_raw or not until_raw:
        print("ERROR: provide both since and until dates.", file=sys.stderr)
        return 2

    repo = Path(args.repo).resolve()
    try:
        root = run_git(repo, ["rev-parse", "--show-toplevel"]).stdout.strip()
    except subprocess.CalledProcessError as exc:
        print((exc.stderr or exc.stdout or f"{repo} is not a git repository").strip(), file=sys.stderr)
        return 2
    repo = Path(root)

    since = normalize_date(since_raw, end_of_day=False)
    until = normalize_date(until_raw, end_of_day=True)
    try:
        commits = load_commits(repo, since, until, args.path, args.author, args.no_merges, args.max_commits)
        stats = load_file_stats(repo, commits, args.path)
    except subprocess.CalledProcessError as exc:
        print((exc.stderr or exc.stdout or "git command failed").strip(), file=sys.stderr)
        return 1

    categories = build_categories(commits, stats)
    risks = risk_signals(commits, stats)
    checks = suggested_verification(categories)
    if args.format == "json":
        output = json_report(repo, since, until, commits, stats, categories, risks, checks, args.path)
    else:
        output = markdown_report(repo, since, until, commits, stats, categories, risks, checks, args.path)

    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(output, encoding="utf-8")
        print(f"Wrote git history explanation to {output_path}")
    else:
        print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
