"""Make the parent directory importable so tests can `from corpus import …`
without packaging the harness. The directory has a hyphen in its name
which blocks normal `python -m` style imports — adjusting sys.path
here is the smallest workaround."""
from __future__ import annotations

import sys
from pathlib import Path

_HARNESS_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_HARNESS_ROOT))
