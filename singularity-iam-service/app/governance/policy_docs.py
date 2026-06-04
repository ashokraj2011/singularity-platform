"""G9 — live-fetch governance policy docs (markdown) referenced by a
``promptLayer.sourceUrl``.

The governance authoring UI lets a policy's content be EITHER typed inline
(``promptLayer.text``) OR linked to a central markdown doc
(``promptLayer.sourceUrl``). For linked layers we fetch the doc content at
resolve time so the live policy always reflects the source.

SSRF-guarded (the fetch target is operator-supplied):
  * only http/https,
  * the resolved host must not be private / loopback / link-local / reserved,
  * optional strict allowlist via ``GOVERNANCE_DOCS_ALLOWED_HOSTS``,
  * redirects are NOT followed (a public URL can't bounce to an internal one),
  * hard timeout + response size cap.

Fail-soft: returns ``None`` on any error so a governance resolve never breaks
because a doc is slow / unreachable / blocked. TTL-cached so a run that resolves
the same (capability, stage) many times doesn't refetch each time.
"""
from __future__ import annotations

import ipaddress
import logging
import os
import socket
import time
from urllib.parse import urlparse

import httpx

log = logging.getLogger(__name__)

_TTL_SECONDS = int(os.environ.get("GOVERNANCE_DOC_CACHE_TTL", "60"))
_MAX_BYTES = int(os.environ.get("GOVERNANCE_DOC_MAX_BYTES", str(256 * 1024)))
_TIMEOUT = float(os.environ.get("GOVERNANCE_DOC_TIMEOUT", "5"))
_ALLOWED_HOSTS = {
    h.strip().lower()
    for h in os.environ.get("GOVERNANCE_DOCS_ALLOWED_HOSTS", "").split(",")
    if h.strip()
}

# url -> (expires_at, content)
_cache: dict[str, tuple[float, str]] = {}


def _host_blocked(host: str) -> bool:
    """True if the host should not be fetched (SSRF guard)."""
    if _ALLOWED_HOSTS and host.lower() not in _ALLOWED_HOSTS:
        return True
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return True  # unresolvable → block
    for info in infos:
        ip = info[4][0]
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            continue
        if (
            addr.is_private or addr.is_loopback or addr.is_link_local
            or addr.is_reserved or addr.is_multicast or addr.is_unspecified
        ):
            return True
    return False


async def fetch_policy_doc(url: str) -> str | None:
    """Fetch a markdown policy doc. Returns text, or None on any failure."""
    if not url or not isinstance(url, str):
        return None
    now = time.time()
    cached = _cache.get(url)
    if cached and cached[0] > now:
        return cached[1]

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return None
    if _host_blocked(parsed.hostname):
        log.warning("governance policy doc blocked by SSRF guard: %s", parsed.hostname)
        return None

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=False) as client:
            resp = await client.get(url, headers={"accept": "text/markdown, text/plain, */*"})
        if resp.status_code != 200:
            return None
        raw = resp.content[:_MAX_BYTES]
        content = raw.decode("utf-8", "ignore")
        _cache[url] = (now + _TTL_SECONDS, content)
        return content
    except Exception as exc:  # noqa: BLE001 — fail-soft on any fetch error
        log.info("governance policy doc fetch failed (%s): %s", url, exc)
        return None


async def enrich_overlay_prompt_layers(overlay: dict) -> None:
    """Mutate `overlay` in place: for each promptLayer with a `sourceUrl`,
    live-fetch the markdown and set it as the layer `text`. Never raises.

    Note: overlayHash was computed by the pure resolver over the source ref
    (sourceUrl), NOT the fetched body — so the hash stays a stable identity for
    "this policy source" while the rendered text tracks the live doc.
    """
    for layer in overlay.get("promptLayers", []) or []:
        src = layer.get("sourceUrl") if isinstance(layer, dict) else None
        if not src:
            continue
        fetched = await fetch_policy_doc(src)
        if fetched is not None:
            layer["text"] = fetched
            layer["sourceFetched"] = True
        else:
            layer["sourceError"] = True
