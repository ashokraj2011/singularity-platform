"""ToolInvocationGrant — signed authorization binding a tool call to the
upstream stage/phase/policy decision (governed-cutover hardening, defence-in-depth).

Background
----------
mcp-server's POST /mcp/tool-run is intentionally *policy-dumb*: it executes
whatever the bearer-authenticated caller asks for. The bearer only proves
"some caller in IAM is allowed to talk to MCP" — it does NOT prove that *this
specific tool call* (this tool, these args, this stage/phase) was authorized by
Context Fabric's governed loop. So a leaked or over-scoped bearer could POST
/mcp/tool-run directly and dispatch any tool — including mutating ones like
``apply_patch`` / ``write_file`` or the arbitrary-command ``run_command`` —
bypassing every policy decision CF makes.

This module closes that gap. Context Fabric already resolves the StagePolicy,
the current Phase, and the stage_key at dispatch time (see
``loop.governed_step``). At the moment a tool call is emitted toward mcp-server
we mint a short-lived, HMAC-signed grant that *binds* the call to that upstream
decision. mcp-server verifies the grant (signature + expiry + nonce + the
tool/args binding) before executing mutating / high-risk tools and refuses
otherwise. MCP stays policy-dumb — it does not re-derive the policy; it only
checks that what it's about to run matches a thing CF cryptographically signed.

The grant binds + is signed over:
    traceId, stageKey, phase, toolName, argsHash,
    policyId, policyVersion, policyHash, issuedAt, expiresAt, nonce

Backward compatibility
----------------------
Minting is OFF by default. ``mint_tool_grant`` returns ``None`` unless both
``CF_TOOL_GRANT_ENABLED`` is truthy *and* ``TOOL_GRANT_SIGNING_SECRET`` is set.
``dispatch.dispatch_tool`` simply omits the grant from the payload when it's
``None``, so existing flows are byte-for-byte unchanged until the flag is
flipped. mcp-server has its own independent enforcement mode (off / grace /
enforce) so the two sides can be rolled out in either order.

Cross-language note
-------------------
The args/policy hashes and the signing string are canonicalised so the TS
verifier in ``mcp-server/src/security/tool-grant.ts`` recomputes identical
bytes. Keep ``canonical_json`` and ``_signing_string`` in lock-step with that
file. The shared golden vectors are pinned in both test suites
(tests/governed/test_grant.py and mcp-server/test/tool-grant.test.ts).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from typing import Any

from .phase_state import Phase
from .policy_loader import StagePolicy

log = logging.getLogger(__name__)

# Wire version. Bump if the signed field set or the signing-string layout
# changes in a non-backward-compatible way; the verifier rejects unknown
# versions rather than silently mis-binding.
GRANT_VERSION = 1
GRANT_ALG = "HMAC-SHA256"

# Environment knobs (read at call time, not import time, so a `docker compose
# up -d` config reload picks them up without a rebuild — same convention as
# dispatch.LAPTOP_USE_LEGACY_INVOKE):
#   CF_TOOL_GRANT_ENABLED        — master mint switch (default off)
#   TOOL_GRANT_SIGNING_SECRET    — shared HMAC key (same value in mcp-server)
#   CF_TOOL_GRANT_TTL_SEC        — grant lifetime in seconds (default 120)
_TRUE = {"1", "true", "yes", "on"}


def grant_enabled() -> bool:
    return os.environ.get("CF_TOOL_GRANT_ENABLED", "").strip().lower() in _TRUE


def _signing_secret() -> str | None:
    secret = os.environ.get("TOOL_GRANT_SIGNING_SECRET", "").strip()
    return secret or None


def _ttl_sec() -> int:
    try:
        ttl = int(os.environ.get("CF_TOOL_GRANT_TTL_SEC", "120"))
    except ValueError:
        ttl = 120
    # Clamp to something sane: long enough to survive a slow tool dispatch,
    # short enough that a captured grant is near-useless. 1h hard ceiling.
    return max(5, min(ttl, 3600))


def canonical_json(obj: Any) -> str:
    """Deterministic JSON: keys sorted recursively, no whitespace, raw UTF-8.

    MUST match ``canonicalJson`` in mcp-server/src/security/tool-grant.ts so the
    args-hash computed here equals the one recomputed there over the same args.
    ``ensure_ascii=False`` keeps non-ASCII bytes raw to match JS JSON.stringify;
    ``default=str`` is a defensive fallback for stray non-JSON values (it should
    never fire for real tool args, which are JSON already).
    """
    return json.dumps(
        obj,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        default=str,
    )


def _sha256_tagged(material: str) -> str:
    return "sha256:" + hashlib.sha256(material.encode("utf-8")).hexdigest()


def hash_args(args: dict[str, Any] | None) -> str:
    """Hash the tool args exactly as they'll be sent on the wire.

    The caller must hash the SAME dict it dispatches (post-PII-unmask), and
    mcp-server must hash the raw received args BEFORE its alias-normalisation
    pass — otherwise the hashes won't match. See the note in
    dispatch.dispatch_tool and the route handler in tool-run.ts.
    """
    return _sha256_tagged(canonical_json(args or {}))


def policy_hash(policy: StagePolicy) -> str:
    """Hash the policy's identity + per-phase tool allow/deny lists.

    Binding the *content* (not just the id+version) means that if the resolved
    policy's tool gating changes underneath a long-lived grant — e.g. a hot
    policy edit during a rollout — the grant no longer matches and MCP refuses.
    Deterministic ordering (sorted phases, sorted tool names) keeps this stable
    across cache reloads and process restarts.
    """
    material = {
        "policyId": policy.policy_id,
        "stageKey": policy.stage_key,
        "agentRole": policy.agent_role,
        "version": policy.version,
        "phases": {
            phase.value: {
                "allow": sorted(pp.allowed_tools),
                "deny": sorted(pp.forbidden_tools),
            }
            for phase, pp in sorted(
                policy.phases.items(), key=lambda kv: kv[0].value
            )
        },
    }
    return _sha256_tagged(canonical_json(material))


def _signing_string(grant: dict[str, Any]) -> str:
    """Fixed-order, newline-joined concatenation of the bound fields.

    Order and field set MUST match the TS verifier. The signature is computed
    over THIS string (never over the JSON object, whose key order is
    implementation-defined). ``sig`` and ``alg`` are deliberately excluded.
    """
    return "\n".join(
        [
            f"v{GRANT_VERSION}",
            str(grant["traceId"]),
            str(grant["stageKey"]),
            str(grant["phase"]),
            str(grant["toolName"]),
            str(grant["argsHash"]),
            str(grant["policyId"]),
            str(grant["policyVersion"]),
            str(grant["policyHash"]),
            str(grant["issuedAt"]),
            str(grant["expiresAt"]),
            str(grant["nonce"]),
        ]
    )


def sign_grant(grant: dict[str, Any], secret: str) -> str:
    return hmac.new(
        secret.encode("utf-8"),
        _signing_string(grant).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _trace_id_from(run_context: dict[str, Any] | None) -> str:
    rc = run_context or {}
    for key in ("traceId", "trace_id", "runId", "run_id"):
        val = rc.get(key)
        if val:
            return str(val)
    return ""


def mint_tool_grant(
    *,
    policy: StagePolicy | None,
    phase: Phase | None,
    tool_name: str,
    args: dict[str, Any] | None,
    run_context: dict[str, Any] | None,
    ttl_sec: int | None = None,
) -> dict[str, Any] | None:
    """Mint + sign a ToolInvocationGrant for one tool dispatch.

    Returns ``None`` (and the dispatcher sends no grant) when:
      * minting is disabled (``CF_TOOL_GRANT_ENABLED`` falsy), OR
      * no signing secret is configured, OR
      * the binding context is incomplete (no policy / no phase).

    The last case matters for system-initiated dispatches whose caller hasn't
    threaded the policy/phase through yet — we'd rather emit no grant (and let
    MCP's grace/off mode allow it) than emit a half-bound one. Never raises:
    grant minting must not be able to fail a tool dispatch.
    """
    if not grant_enabled():
        return None
    secret = _signing_secret()
    if not secret:
        # Enabled but unconfigured — loud, because it means the operator
        # flipped the flag without provisioning the shared key. Fail open
        # (no grant) so we don't break dispatch; MCP-side mode decides.
        log.warning(
            "CF_TOOL_GRANT_ENABLED is set but TOOL_GRANT_SIGNING_SECRET is "
            "empty — dispatching tool=%s WITHOUT a grant",
            tool_name,
        )
        return None
    if policy is None or phase is None:
        log.debug(
            "skip grant mint (no policy/phase context) tool=%s phase=%s",
            tool_name,
            getattr(phase, "value", phase),
        )
        return None

    now = int(time.time())
    ttl = ttl_sec if ttl_sec is not None else _ttl_sec()
    grant: dict[str, Any] = {
        "v": GRANT_VERSION,
        "traceId": _trace_id_from(run_context),
        "stageKey": policy.stage_key,
        "phase": phase.value if isinstance(phase, Phase) else str(phase),
        "toolName": tool_name,
        "argsHash": hash_args(args),
        "policyId": policy.policy_id,
        "policyVersion": policy.version,
        "policyHash": policy_hash(policy),
        "issuedAt": now,
        "expiresAt": now + ttl,
        # 128 bits of randomness — the replay-protection primitive. mcp-server
        # records seen nonces until their grant expires.
        "nonce": secrets.token_hex(16),
        "alg": GRANT_ALG,
    }
    grant["sig"] = sign_grant(grant, secret)
    return grant
