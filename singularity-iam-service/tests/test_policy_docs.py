"""G9 — SSRF guard for governance policy-doc fetching. Network-free: uses IP
literals + localhost so no DNS/HTTP is needed."""
from app.governance.policy_docs import _host_blocked


def test_blocks_loopback():
    assert _host_blocked("localhost") is True
    assert _host_blocked("127.0.0.1") is True


def test_blocks_private_and_linklocal():
    assert _host_blocked("10.0.0.1") is True
    assert _host_blocked("192.168.1.1") is True
    assert _host_blocked("172.16.0.1") is True
    assert _host_blocked("169.254.169.254") is True  # cloud metadata endpoint


def test_blocks_unresolvable():
    assert _host_blocked("no-such-host.invalid") is True


def test_allows_public_ip_literal():
    # Public IP literal — no DNS needed, not private/loopback → allowed.
    assert _host_blocked("8.8.8.8") is False
