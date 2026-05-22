"""M62 — Module-level singleton holding the loaded PromptCompressor.

Keeping the model in module scope (not on the FastAPI app object) means:
  - it stays warm across requests (~600MB resident memory)
  - cold-start happens at most once per process
  - tests can monkey-patch `_compressor` to a stub without faking
    fastapi state

The actual llmlingua import lives inside `load_compressor` so importing
this module doesn't pull in transformers + torch (a ~2s import cost)
just to read config or run unit tests on the validation logic.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any, Optional

from .config import settings

log = logging.getLogger(__name__)

# Lazy singletons. The lock guards the load_compressor double-check
# so two simultaneous first requests don't both pay the cold-start
# cost and waste ~600MB of duplicate model state.
_lock = threading.Lock()
_compressor: Optional[Any] = None
_load_failed_reason: Optional[str] = None


def is_loaded() -> bool:
    """True iff a compressor instance is resident in memory."""
    return _compressor is not None


def last_load_error() -> Optional[str]:
    """Most recent failure message from load_compressor, or None."""
    return _load_failed_reason


def load_compressor() -> Any:
    """Return the singleton, constructing it on first call.

    Raises RuntimeError if construction fails (caller surfaces as 503).
    Subsequent calls re-raise without retrying the import — the
    constructor side-effects (huggingface cache reads) are deterministic
    given a build-baked model, so a failure once means a failure always
    until the operator fixes the env and restarts.
    """
    global _compressor, _load_failed_reason
    if _compressor is not None:
        return _compressor
    with _lock:
        if _compressor is not None:
            return _compressor
        if _load_failed_reason is not None:
            raise RuntimeError(f"compressor load previously failed: {_load_failed_reason}")
        started = time.perf_counter()
        try:
            # Deferred import — keeps `from .compressor import is_loaded`
            # cheap when the service starts up. ImportError here is
            # expected for lean builds (M62 Slice F: COMPRESSION_BAKE_MODEL=skip
            # produces an image with no llmlingua). The api layer
            # short-circuits to the stopwords strategy before reaching
            # here when COMPRESSION_STRATEGY=stopwords (the default),
            # so this only fires when an operator explicitly opts in
            # to llmlingua without a baked model.
            from llmlingua import PromptCompressor  # type: ignore

            log.info(
                "[compressor] loading model=%s device=%s",
                settings.compression_model_name,
                settings.compression_device,
            )
            _compressor = PromptCompressor(
                model_name=settings.compression_model_name,
                use_llmlingua2=True,
                device_map=settings.compression_device,
            )
            took_ms = int((time.perf_counter() - started) * 1000)
            log.info("[compressor] loaded in %dms", took_ms)
            return _compressor
        except Exception as exc:  # pylint: disable=broad-except
            _load_failed_reason = f"{type(exc).__name__}: {exc}"
            log.exception("[compressor] load failed")
            raise RuntimeError(_load_failed_reason) from exc


def maybe_eager_load() -> None:
    """If COMPRESSION_LAZY_LOAD=false, load now. Swallow errors and
    log — failing to eager-load should NOT prevent the service from
    starting; /health still reports the failure via last_load_error.
    """
    if settings.compression_lazy_load:
        return
    if not settings.compression_enabled:
        return
    try:
        load_compressor()
    except Exception:  # pylint: disable=broad-except
        # Already logged in load_compressor. Service comes up anyway.
        pass
