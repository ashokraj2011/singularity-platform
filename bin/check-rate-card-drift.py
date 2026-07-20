#!/usr/bin/env python3
"""
Report disagreements between the two independent LLM price sources.

THE TWO SOURCES

  1. The gateway's model catalog (.singularity/llm-models.json), priced PER
     ALIAS via inputPricePerMtok / outputPricePerMtok. This is the price the
     gateway actually charges: it is computed by the process making the call,
     from the alias it actually routed to.

  2. audit_governance.rate_card, keyed (provider, model). This is what priced
     historical rows and still prices any emitter that carries no price of its
     own — the laptop shim, anything older than the M75 emitter.

Since the price-precedence change, source 1 wins at call time and source 2 is
the historical fallback. Both remain live, editable by different people through
different surfaces (the /llm-settings UI writes the catalog; SQL writes the rate
card), and NOTHING reconciles them. This script is that reconciliation, as a
report.

IT WARNS. IT DOES NOT SYNC.

Auto-syncing would mean silently rewriting a price a human deliberately set,
in whichever direction the script's author happened to prefer. A stale price
that an operator can see and reason about is strictly better than a correct-
looking price that changed underneath them. So: print, exit 0, let a human
decide. `--strict` turns findings into a non-zero exit for CI, and is opt-in
precisely because the default must never block anyone.

THE STRUCTURAL FINDING THIS EXISTS FOR

rate_card is keyed (provider, model). The catalog is keyed by alias. Several
aliases legitimately resolve to one model — five point at claude-sonnet-4-6 in
the shipped catalog today. rate_card CANNOT represent two of those aliases
priced differently. They happen to agree right now, so nothing is broken; the
moment someone prices one lane differently (a discount, committed throughput, a
passthrough markup) the rate card can only hold one of the two numbers. That is
reported as SPLIT below, before it becomes a costing bug rather than after.

USAGE

  bin/check-rate-card-drift.py                     # live DB via docker compose
  bin/check-rate-card-drift.py --offline           # seeds from db/init.sql
  bin/check-rate-card-drift.py --catalog PATH
  bin/check-rate-card-drift.py --database-url URL  # psql-reachable DSN
  bin/check-rate-card-drift.py --strict            # findings -> exit 1
  bin/check-rate-card-drift.py --verbose           # also print agreements

No new Python dependency: the live read shells out to psql, the same trick
bin/stage-trace.py uses, so this runs on a bare host with no psycopg installed.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

_REPO_ROOT = Path(__file__).resolve().parent.parent

# Mirrors llm_gateway_service/app/provider_config.py::_load_catalog, including
# its mcp-models.json back-compat name. Checked in order.
_CATALOG_CANDIDATES = (
    _REPO_ROOT / ".singularity/llm-models.json",
    _REPO_ROOT / ".singularity/mcp-models.json",
    _REPO_ROOT / ".singularity/llm-models.json.default",
)

_INIT_SQL = _REPO_ROOT / "audit-governance-service/db/init.sql"

# The catalog's ceiling on a sane price (provider_config._MAX_PRICE_PER_MTOK).
# A value above this is ignored by the gateway, so comparing against it would
# report drift on a price that never prices anything.
_MAX_PRICE_PER_MTOK = 10_000.0

# Rate-card NUMERIC(10,6) resolution is 1e-6 per 1k tokens. Compare at half
# that, so a representable difference is drift and float noise is not.
_EPSILON = 5e-7


class CatalogEntry(NamedTuple):
    alias: str
    provider: str
    model: str
    input_per_1k: Optional[float]
    output_per_1k: Optional[float]


class RateCardEntry(NamedTuple):
    provider: str
    model: str
    input_per_1k: float
    output_per_1k: float
    source: str


# ── Colour, disabled when piped ─────────────────────────────────────────────

def _c(code: str, s: str) -> str:
    return s if not sys.stdout.isatty() else f"\033[{code}m{s}\033[0m"


def _yellow(s: str) -> str:
    return _c("33", s)


def _red(s: str) -> str:
    return _c("31", s)


def _dim(s: str) -> str:
    return _c("2", s)


def _bold(s: str) -> str:
    return _c("1", s)


# ── Source 1: the gateway catalog ───────────────────────────────────────────

def _price_per_1k(value: Any) -> Optional[float]:
    """Catalog price (USD per 1M tokens) as USD per 1k, or None.

    Applies the SAME validity rules as provider_config._safe_price_per_mtok, so
    a price the gateway would reject is reported as absent rather than compared.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    price = float(value)
    if price != price or price in (float("inf"), float("-inf")):  # NaN / inf
        return None
    if price < 0 or price > _MAX_PRICE_PER_MTOK:
        return None
    return price / 1000.0


def load_catalog(explicit: Optional[str]) -> Tuple[Path, List[CatalogEntry]]:
    if explicit:
        path = Path(explicit).expanduser().resolve()
        if not path.exists():
            raise SystemExit(f"catalog not found: {path}")
    else:
        path = next((p for p in _CATALOG_CANDIDATES if p.exists()), None)
        if path is None:
            raise SystemExit(
                "No model catalog found. Looked for:\n"
                + "\n".join(f"  {p}" for p in _CATALOG_CANDIDATES)
                + "\nPass --catalog PATH to point at one."
            )
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise SystemExit(f"catalog parse error ({path}): {exc}")
    if not isinstance(raw, list):
        raise SystemExit(f"catalog must be a JSON array: {path}")

    out: List[CatalogEntry] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        provider = str(entry.get("provider") or "").strip().lower()
        model = str(entry.get("model") or "").strip()
        alias = str(entry.get("id") or "").strip()
        if not provider or not model:
            continue
        out.append(CatalogEntry(
            alias=alias or model,
            provider=provider,
            model=model,
            input_per_1k=_price_per_1k(entry.get("inputPricePerMtok")),
            output_per_1k=_price_per_1k(entry.get("outputPricePerMtok")),
        ))
    return path, out


# ── Source 2: rate_card ─────────────────────────────────────────────────────

_ROWS_SQL = (
    "SELECT provider, model, input_per_1k_usd, output_per_1k_usd, "
    "coalesce(source, '') FROM audit_governance.rate_card "
    "WHERE effective_from <= now() "
    "AND (effective_to IS NULL OR effective_to > now()) "
    "ORDER BY provider, model, effective_from DESC"
)


def _parse_psql_rows(stdout: str) -> List[RateCardEntry]:
    """Parse `psql -A -t -F'|'` output. Keeps only the first row per
    (provider, model) — the query orders effective_from DESC, which is the same
    row cost-worker's LIMIT 1 would pick."""
    seen: Dict[Tuple[str, str], RateCardEntry] = {}
    for line in stdout.strip().splitlines():
        if not line.strip():
            continue
        parts = line.split("|")
        if len(parts) < 4:
            continue
        provider, model, in_raw, out_raw = parts[0], parts[1], parts[2], parts[3]
        source = parts[4] if len(parts) > 4 else ""
        try:
            entry = RateCardEntry(
                provider=provider.strip().lower(), model=model.strip(),
                input_per_1k=float(in_raw), output_per_1k=float(out_raw),
                source=source.strip(),
            )
        except ValueError:
            continue
        seen.setdefault((entry.provider, entry.model), entry)
    return list(seen.values())


def load_rate_card_live(database_url: Optional[str], container: str) -> List[RateCardEntry]:
    """Read active rows via psql. Prefers a direct DSN; otherwise goes through
    `docker compose exec` against the audit-gov postgres container."""
    if database_url:
        if not shutil.which("psql"):
            raise SystemExit(
                "--database-url given but psql is not on PATH.\n"
                "  Install the postgres client, or drop --database-url to go "
                "through docker compose, or use --offline."
            )
        cmd = ["psql", database_url, "-A", "-t", "-F", "|", "-c", _ROWS_SQL]
    else:
        if not shutil.which("docker"):
            raise SystemExit(
                "docker is not on PATH and no --database-url was given.\n"
                "  Use --offline to compare against the db/init.sql seed instead."
            )
        cmd = [
            "docker", "compose",
            "-f", str(_REPO_ROOT / "audit-governance-service/docker-compose.yml"),
            "exec", "-T", container,
            "psql", "-U", "postgres", "-d", "audit_governance",
            "-A", "-t", "-F", "|", "-c", _ROWS_SQL,
        ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except subprocess.TimeoutExpired:
        raise SystemExit("timed out reading rate_card; is the audit-gov stack up?")
    if proc.returncode != 0:
        raise SystemExit(
            f"could not read rate_card ({proc.stderr.strip()[:400]})\n"
            "  Is the audit-gov stack up? Start it with:\n"
            "    docker compose -f audit-governance-service/docker-compose.yml up -d\n"
            "  Or run with --offline to compare against the db/init.sql seed."
        )
    return _parse_psql_rows(proc.stdout)


def load_rate_card_offline() -> List[RateCardEntry]:
    """Parse the seeded INSERT out of db/init.sql.

    A deliberately partial view: it sees the shipped seed and NOT whatever an
    operator has since inserted. Callers are told so, because "no drift" against
    the seed says nothing about the running database.
    """
    if not _INIT_SQL.exists():
        raise SystemExit(f"cannot read seed rows, missing: {_INIT_SQL}")
    sql = _INIT_SQL.read_text(encoding="utf-8")
    match = re.search(
        r"INSERT INTO rate_card\s*\([^)]*\)\s*VALUES(.*?);",
        sql, re.DOTALL | re.IGNORECASE,
    )
    if not match:
        raise SystemExit(f"no rate_card seed INSERT found in {_INIT_SQL}")
    rows: List[RateCardEntry] = []
    tuple_re = re.compile(
        r"\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*'([^']*)'\s*\)"
    )
    for provider, model, in_raw, out_raw, source in tuple_re.findall(match.group(1)):
        rows.append(RateCardEntry(
            provider=provider.strip().lower(), model=model.strip(),
            input_per_1k=float(in_raw), output_per_1k=float(out_raw),
            source=source.strip(),
        ))
    return rows


# ── Comparison ──────────────────────────────────────────────────────────────

class Finding(NamedTuple):
    kind: str      # SPLIT | DRIFT | UNPRICED | NO_RATE_CARD | ORPHAN_RATE_CARD
    key: str
    detail: str


def _fmt(price: Optional[float]) -> str:
    return "—" if price is None else f"${price:.6f}/1k"


def compare(catalog: List[CatalogEntry], rate_card: List[RateCardEntry]) -> List[Finding]:
    findings: List[Finding] = []

    by_model: Dict[Tuple[str, str], List[CatalogEntry]] = {}
    for entry in catalog:
        by_model.setdefault((entry.provider, entry.model), []).append(entry)
    cards = {(r.provider, r.model): r for r in rate_card}

    for key, aliases in sorted(by_model.items()):
        label = f"{key[0]}/{key[1]}"

        # SPLIT — aliases on one model disagreeing with EACH OTHER. rate_card is
        # structurally incapable of holding both, so this is reported whether or
        # not a card exists.
        distinct = {(a.input_per_1k, a.output_per_1k) for a in aliases}
        if len(distinct) > 1:
            detail = "; ".join(
                f"{a.alias}={_fmt(a.input_per_1k)}/{_fmt(a.output_per_1k)}" for a in aliases
            )
            findings.append(Finding(
                "SPLIT", label,
                f"{len(aliases)} aliases, {len(distinct)} distinct prices — "
                f"rate_card is keyed (provider, model) and can hold only one. {detail}",
            ))

        priced = [a for a in aliases if a.input_per_1k is not None and a.output_per_1k is not None]
        if not priced:
            findings.append(Finding(
                "UNPRICED", label,
                f"catalog carries no usable price for {', '.join(a.alias for a in aliases)} — "
                "the gateway emits no cost_usd, so these rows fall through to rate_card",
            ))
            continue

        card = cards.get(key)
        if card is None:
            findings.append(Finding(
                "NO_RATE_CARD", label,
                f"priced in the catalog ({_fmt(priced[0].input_per_1k)} in / "
                f"{_fmt(priced[0].output_per_1k)} out) but absent from rate_card — "
                "fine while the emitter carries a price; unpriced if it ever does not",
            ))
            continue

        # DRIFT — reported per alias so a SPLIT names which lane disagrees.
        for alias in priced:
            in_delta = abs((alias.input_per_1k or 0) - card.input_per_1k)
            out_delta = abs((alias.output_per_1k or 0) - card.output_per_1k)
            if in_delta <= _EPSILON and out_delta <= _EPSILON:
                continue
            bits = []
            if in_delta > _EPSILON:
                bits.append(f"input {_fmt(alias.input_per_1k)} vs {_fmt(card.input_per_1k)}")
            if out_delta > _EPSILON:
                bits.append(f"output {_fmt(alias.output_per_1k)} vs {_fmt(card.output_per_1k)}")
            findings.append(Finding(
                "DRIFT", f"{label} (alias {alias.alias})",
                "catalog vs rate_card: " + "; ".join(bits),
            ))

    for key, card in sorted(cards.items()):
        if key not in by_model:
            findings.append(Finding(
                "ORPHAN_RATE_CARD", f"{key[0]}/{key[1]}",
                f"rate_card row ({card.source or 'no source'}) has no catalog alias — "
                "prices historical rows only; nothing routes to it today",
            ))

    return findings


# ── Reporting ───────────────────────────────────────────────────────────────

# Ordered by how much an operator should care. SPLIT and DRIFT mean two live
# numbers disagree. The rest are coverage observations, normal in a healthy
# system, and are printed but never counted as drift.
_ORDER = ["SPLIT", "DRIFT", "UNPRICED", "NO_RATE_CARD", "ORPHAN_RATE_CARD"]
_DISAGREEMENTS = {"SPLIT", "DRIFT"}


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Warn when the gateway model catalog and audit_governance.rate_card disagree.",
    )
    ap.add_argument("--catalog", help="path to llm-models.json (default: autodetect under .singularity/)")
    ap.add_argument("--offline", action="store_true",
                    help="compare against the db/init.sql seed instead of a live database")
    ap.add_argument("--database-url", help="psql-reachable DSN for audit_governance")
    ap.add_argument("--container", default="audit-postgres",
                    help="compose service holding audit_governance (default: audit-postgres)")
    ap.add_argument("--strict", action="store_true",
                    help="exit 1 when the two sources disagree (default: report and exit 0)")
    ap.add_argument("--verbose", action="store_true", help="also print pairs that agree")
    args = ap.parse_args()

    catalog_path, catalog = load_catalog(args.catalog)
    if args.offline:
        rate_card = load_rate_card_offline()
        origin = f"{_INIT_SQL.relative_to(_REPO_ROOT)} (seed only)"
    else:
        rate_card = load_rate_card_live(args.database_url, args.container)
        origin = args.database_url and "live database" or f"live database via docker compose exec {args.container}"

    print(_bold("rate-card drift check"))
    print(f"  catalog   : {catalog_path}  ({len(catalog)} aliases)")
    print(f"  rate_card : {origin}  ({len(rate_card)} active rows)")
    if args.offline:
        print(_dim("  NOTE: --offline sees only the shipped seed. Rows an operator"))
        print(_dim("        inserted since are invisible, so a clean result here does"))
        print(_dim("        NOT mean the running database agrees."))
    print()

    findings = compare(catalog, rate_card)

    if args.verbose:
        cards = {(r.provider, r.model): r for r in rate_card}
        noisy = {f.key.split(" (alias")[0] for f in findings}
        agreed = [
            f"{p}/{m}" for (p, m) in sorted(cards)
            if f"{p}/{m}" not in noisy and any(c.provider == p and c.model == m for c in catalog)
        ]
        for label in agreed:
            print(f"  {_dim('OK')}  {label}")
        if agreed:
            print()

    if not findings:
        print("OK — the catalog and rate_card agree on every priced model.")
        return 0

    by_kind: Dict[str, List[Finding]] = {}
    for f in findings:
        by_kind.setdefault(f.kind, []).append(f)

    for kind in _ORDER:
        group = by_kind.get(kind)
        if not group:
            continue
        colour = _red if kind in _DISAGREEMENTS else _yellow
        print(colour(f"{kind} ({len(group)})"))
        for f in group:
            print(f"  {f.key}")
            print(f"    {f.detail}")
        print()

    disagreements = sum(len(by_kind.get(k, [])) for k in _DISAGREEMENTS)
    if disagreements:
        print(_bold("Two live price sources disagree."))
        print(
            "Since the price-precedence change the CATALOG wins at call time, so\n"
            "new rows carry the catalog number and rate_card prices only emitters\n"
            "that send no price. Nothing here is automatically corrected — decide\n"
            "which number is right and edit that source yourself:\n"
            f"  catalog   : {catalog_path}  (or the /llm-settings UI)\n"
            "  rate_card : UPDATE audit_governance.rate_card — close the old row\n"
            "              with effective_to and INSERT a new one, so historical\n"
            "              rows keep the price they were actually costed at."
        )
    else:
        print("No price disagreement. The findings above are coverage notes, not drift.")

    return 1 if (args.strict and disagreements) else 0


if __name__ == "__main__":
    sys.exit(main())
