# Reference Pilot

The Reference Pilot is an idempotent, transparent synthetic control exercise for
the complete idea-to-verified-check-in evidence spine. It exists to prove that
the platform can persist, correlate, display, and verify every Master Design
pilot obligation without pretending the result is a customer or sponsor pilot.

## Run it

Start the platform, then run:

```bash
bin/reference-pilot.sh
```

The command creates or refreshes `REF-PILOT-001`, verifies all 25 obligations,
and prints the Pilot Proof URL. `bin/demo-up.sh` runs it by default; set
`REFERENCE_PILOT_ENABLED=false` to skip it.

Use the individual phases when debugging:

```bash
bin/reference-pilot.sh seed
bin/reference-pilot.sh verify
```

## Evidence integrity

- The initiative is tagged `reference-pilot` and `synthetic-evidence`.
- The API returns `evidenceMode=REFERENCE_SYNTHETIC`.
- Pilot Proof displays a permanent synthetic-evidence disclosure.
- Authorship and approval use separate durable WorkGraph identities.
- The fixture includes linked failure, stale-fence, waiver, reconciliation,
  finalization, economics, sponsor, learning, attention, and SLA evidence.
- Re-running the command updates deterministic records rather than duplicating
  events or finalization transitions.

Production evidence verification should reject synthetic evidence:

```bash
python3 bin/verify-contract-bound-pilot.py \
  --project-id <production-project-id> \
  --require-live
```

The seed refuses `NODE_ENV=production` unless an operator explicitly enables it
with `REFERENCE_PILOT_ALLOW_SYNTHETIC=true` in an isolated validation tenant.
