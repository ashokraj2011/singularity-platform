"""Config-file extensions to the IAM permission/role catalog (app/seed/catalog_files.py).

These make the RBAC vocabulary extensible without a code change, additively and
add-only — a file can never override a shipped permission or system role.
"""
from __future__ import annotations

import json

from app.seed.catalog_files import (
    load_permission_catalog_file,
    load_role_catalog_file,
    merge_permissions,
    merge_roles,
)


def _write(tmp_path, name, data):
    p = tmp_path / name
    p.write_text(json.dumps(data), encoding="utf-8")
    return str(p)


def test_permission_loader_none_empty_and_missing(tmp_path):
    assert load_permission_catalog_file(None) == []
    assert load_permission_catalog_file("") == []
    # A missing file degrades to [] rather than raising.
    assert load_permission_catalog_file(str(tmp_path / "nope.json")) == []


def test_permission_loader_bare_list_and_wrapper(tmp_path):
    bare = _write(tmp_path, "p1.json", [{"permission_key": "billing:refund", "category": "billing"}])
    assert load_permission_catalog_file(bare) == [{"permission_key": "billing:refund", "category": "billing"}]
    wrapped = _write(tmp_path, "p2.json", {"permissions": [{"permission_key": "billing:void"}]})
    assert load_permission_catalog_file(wrapped) == [{"permission_key": "billing:void", "category": "custom"}]


def test_permission_loader_skips_bad_entries(tmp_path):
    f = _write(tmp_path, "p3.json", [{"category": "x"}, "nope", {"permission_key": "  "}, {"permission_key": "ok"}])
    assert load_permission_catalog_file(f) == [{"permission_key": "ok", "category": "custom"}]


def test_role_loader_defaults_and_skips(tmp_path):
    f = _write(tmp_path, "r1.json", {"roles": [
        {"role_key": "billing_clerk", "name": "Billing Clerk", "role_scope": "platform", "permissions": ["billing:refund", 5]},
        {"name": "no key"},
    ]})
    assert load_role_catalog_file(f) == [{
        "role_key": "billing_clerk", "name": "Billing Clerk", "role_scope": "platform",
        "system_role": False, "permissions": ["billing:refund"],  # non-str perm dropped
    }]


def test_merge_permissions_defaults_win_and_copy():
    defaults = [{"permission_key": "a", "category": "x"}]
    extra = [{"permission_key": "a", "category": "OVERRIDE"}, {"permission_key": "b", "category": "y"}]
    merged = merge_permissions(defaults, extra)
    assert [p["permission_key"] for p in merged] == ["a", "b"]
    assert merged[0]["category"] == "x"  # code default kept, not overridden by the file
    merged[0]["category"] = "mutated"
    assert defaults[0]["category"] == "x"  # merge returns fresh dicts


def test_merge_roles_cannot_override_system_role():
    defaults = [{"role_key": "super_admin", "name": "Super Admin", "permissions": ["platform:all"]}]
    extra = [{"role_key": "super_admin", "name": "HIJACK", "permissions": ["evil"]}, {"role_key": "clerk", "name": "Clerk", "permissions": []}]
    merged = merge_roles(defaults, extra)
    assert [r["role_key"] for r in merged] == ["super_admin", "clerk"]
    assert merged[0]["name"] == "Super Admin"  # a file can't hijack a shipped system role


def test_merged_catalog_has_unique_keys_against_real_defaults(tmp_path):
    # A file re-declaring a shipped key must not create a duplicate, which would break
    # the add-only seed with a unique-constraint violation on flush.
    from app.seed.default_permissions import DEFAULT_PERMISSIONS
    from app.seed.default_roles import DEFAULT_ROLES

    pf = _write(tmp_path, "dup-perms.json", [{"permission_key": "platform:all", "category": "dup"}, {"permission_key": "x:new"}])
    pmerged = merge_permissions(DEFAULT_PERMISSIONS, load_permission_catalog_file(pf))
    pkeys = [p["permission_key"] for p in pmerged]
    assert len(pkeys) == len(set(pkeys))
    assert "x:new" in pkeys

    rf = _write(tmp_path, "dup-roles.json", {"roles": [{"role_key": "super_admin", "name": "dup"}, {"role_key": "site_role"}]})
    rmerged = merge_roles(DEFAULT_ROLES, load_role_catalog_file(rf))
    rkeys = [r["role_key"] for r in rmerged]
    assert len(rkeys) == len(set(rkeys))
    assert "site_role" in rkeys
