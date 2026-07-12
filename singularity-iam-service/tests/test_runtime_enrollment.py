from app.devices.enrollment_routes import _code_hash, _new_code, _normalize_code


def test_enrollment_code_is_high_entropy_and_formatting_tolerant():
    code = _new_code()
    assert code.startswith("SGR-")
    assert len(code.replace("-", "")) == 32
    assert _normalize_code(f"  {code.lower()}  ") == _normalize_code(code)
    assert _code_hash(code) == _code_hash(code.lower().replace("-", ""))


def test_enrollment_code_hash_is_not_the_plaintext_code():
    code = _new_code()
    assert _code_hash(code) != code
    assert _code_hash(code) != _code_hash(_new_code())
