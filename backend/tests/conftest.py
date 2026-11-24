"""Shared test fixtures.

The production stack imports ``essentia`` at module import time and Demucs only
inside the analysis call path. Neither is installable in every test environment
(no Windows wheels / no compilers), so:

* ``essentia`` is replaced by a throwing stub — the app already treats every
  MusicExtractor failure as an empty-feature fallback;
* Demucs is replaced per-test with a deterministic in-memory fake stem module.
"""

from __future__ import annotations

import math
import sys
import types
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

# Make ``import backend.app`` work regardless of the directory pytest is
# launched from.
REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

_essentia = types.ModuleType("essentia")
_standard = types.ModuleType("essentia.standard")


class _FailingMusicExtractor:
    def __init__(self, *args: object, **kwargs: object) -> None:
        pass

    def __call__(self, path: str):
        raise RuntimeError("essentia unavailable in test environment")


_standard.MusicExtractor = _FailingMusicExtractor
_essentia.standard = _standard
sys.modules.setdefault("essentia", _essentia)
sys.modules.setdefault("essentia.standard", _standard)

from backend import app as app_module  # noqa: E402
from backend.app import app  # noqa: E402,F401


@pytest.fixture
def cache_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Redirect the on-disk analysis cache at an isolated temp directory."""
    path = tmp_path / "analysis-cache"
    monkeypatch.setattr(app_module, "CACHE_DIR", path)
    return path


@pytest.fixture
def audio_file(tmp_path: Path) -> str:
    """An 8 s synthetic track: quiet intro, tonal middle band, quiet tail."""
    sr = 22050
    times = np.linspace(0.0, 8.0, sr * 8, endpoint=False)
    rng = np.random.default_rng(42)
    y = 0.05 * np.sin(2 * np.pi * 220.0 * times)
    lo, hi = int(2 * sr), int(6 * sr)
    y[lo:hi] += 0.25 * np.sin(2 * np.pi * 880.0 * times[lo:hi])
    y += 0.01 * rng.standard_normal(times.size)
    path = tmp_path / "track.wav"
    sf.write(str(path), y.astype(np.float32), sr)
    return str(path)


@pytest.fixture
def fake_demucs(monkeypatch: pytest.MonkeyPatch) -> dict[str, int]:
    """Deterministic stand-in for ``backend.stems`` with call counters.

    The fake vocal timeline uses a distinctive 0.91 risk that no heuristic VAD
    can produce, so tests can tell the two sources apart unambiguously.
    """
    calls = {"timeline": 0, "vocals": 0}

    def vocal_activity_timeline(path: str, duration: float, step: float = 1.0):
        calls["timeline"] += 1
        n = max(1, int(math.ceil(duration / step))) if duration > 0 else 1
        risk = [0.91 if 2 <= i * step < 6 else 0.0 for i in range(n)]
        return {"vocalRisk": risk, "firstVocalAt": 2.0, "lastVocalAt": 5.0}

    def analyze_vocals(path: str, duration: float):
        calls["vocals"] += 1
        return {
            "available": True,
            "vocalIntro": 2.0,
            "vocalOutro": 2.0,
            "introVocalFreeSeconds": 2.0,
            "outroVocalFreeSeconds": 2.0,
            "firstVocalAt": 2.0,
            "lastVocalAt": max(0.0, duration - 2.0),
            "vocalDensityIntro": 0.4,
            "vocalDensityOutro": 0.2,
        }

    fake = types.ModuleType("backend.stems")
    fake.vocal_activity_timeline = vocal_activity_timeline
    fake.analyze_vocals = analyze_vocals
    monkeypatch.setitem(sys.modules, "backend.stems", fake)
    return calls


@pytest.fixture
def failing_demucs(monkeypatch: pytest.MonkeyPatch) -> dict[str, int]:
    """Stand-in for ``backend.stems`` where every Demucs entry point fails."""
    calls = {"timeline": 0, "vocals": 0}

    def vocal_activity_timeline(path: str, duration: float, step: float = 1.0):
        calls["timeline"] += 1
        return None  # the documented failure contract of the real function

    def analyze_vocals(path: str, duration: float):
        calls["vocals"] += 1
        return {"available": False, "reason": "simulated demucs failure"}

    fake = types.ModuleType("backend.stems")
    fake.vocal_activity_timeline = vocal_activity_timeline
    fake.analyze_vocals = analyze_vocals
    monkeypatch.setitem(sys.modules, "backend.stems", fake)
    return calls
