from __future__ import annotations

import logging
import os


def bounded_float_env(
    name: str,
    *,
    default: float,
    min_value: float,
    max_value: float,
    logger: logging.Logger | None = None,
) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        if logger:
            logger.warning("invalid float env %s=%r; using default=%s", name, raw, default)
        return default
    if value < min_value:
        if logger:
            logger.warning("float env %s=%s below min=%s; using default=%s", name, value, min_value, default)
        return default
    if value > max_value:
        if logger:
            logger.warning("float env %s=%s above max=%s; clamping", name, value, max_value)
        return max_value
    return value


def bounded_int_env(
    name: str,
    *,
    default: int,
    min_value: int,
    max_value: int,
    logger: logging.Logger | None = None,
) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        if logger:
            logger.warning("invalid integer env %s=%r; using default=%s", name, raw, default)
        return default
    if value < min_value:
        if logger:
            logger.warning("integer env %s=%s below min=%s; using default=%s", name, value, min_value, default)
        return default
    if value > max_value:
        if logger:
            logger.warning("integer env %s=%s above max=%s; clamping", name, value, max_value)
        return max_value
    return value
