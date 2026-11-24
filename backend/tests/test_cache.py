"""Unit tests for the validated, self-healing analysis cache."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

from backend import app as app_module


def _cache_path(cache_dir: Path, key: str) -> Path:
    return cache_dir / f"{key}.json"


def _valid_payload(use_stems: bool) -> dict:
    n = 8
    return {
        "version": app_module.ANALYSIS_VERSION,
        "analyzer": app_module.ANALYZER_ID,
        "stems": use_stems,
        "vocalSource": "demucs" if use_stems else "heuristic",
        "firstVocalAt": 2.0 if use_stems else None,
        "lastVocalAt": 5.0 if use_stems else None,
        "timeline": {
            "t": [float(i) for i in range(n)],
            "vocalRisk": [0.5] * n,
            "vocalSource": "demucs" if use_stems else "heuristic",
        },
    }


def _write_cache(cache_dir: Path, key: str, payload: dict | str) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = _cache_path(cache_dir, key)
    if isinstance(payload, str):
        path.write_text(payload, encoding="utf-8")
    else:
        path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def test_cache_hit_returns_payload_when_everything_matches(cache_dir, audio_file):
    key = app_module._cache_key(audio_file, use_stems=False)
    payload = _valid_payload(use_stems=False)
    _write_cache(cache_dir, key, payload)

    assert app_module._cache_read(key, use_stems=False) == payload


def test_cache_miss_when_stems_mode_differs(cache_dir, audio_file):
    # Entry produced with stems=false must never serve a stems=true request.
    key_false = app_module._cache_key(audio_file, use_stems=False)
    _write_cache(cache_dir, key_false, _valid_payload(use_stems=False))

    key_true = app_module._cache_key(audio_file, use_stems=True)
    assert app_module._cache_read(key_true, use_stems=True) is None
    # Same key, but requested mode disagrees with the recorded one.
    assert app_module._cache_read(key_false, use_stems=True) is None


def test_cache_miss_on_version_mismatch(cache_dir, audio_file):
    key = app_module._cache_key(audio_file, use_stems=False)
    payload = _valid_payload(use_stems=False)
    payload["version"] = app_module.ANALYSIS_VERSION - 1
    _write_cache(cache_dir, key, payload)

    assert app_module._cache_read(key, use_stems=False) is None


def test_cache_miss_on_analyzer_mismatch(cache_dir, audio_file):
    key = app_module._cache_key(audio_file, use_stems=False)
    payload = _valid_payload(use_stems=False)
    payload["analyzer"] = "some-other-analyzer"
    _write_cache(cache_dir, key, payload)

    assert app_module._cache_read(key, use_stems=False) is None


def test_cache_miss_on_corrupt_json(cache_dir, audio_file):
    key = app_module._cache_key(audio_file, use_stems=False)
    _write_cache(cache_dir, key, "{not valid json")

    assert app_module._cache_read(key, use_stems=False) is None


def test_cache_miss_when_file_replaced_by_directory(cache_dir, audio_file):
    # Concurrent replacement can leave a directory where the JSON was expected.
    key = app_module._cache_key(audio_file, use_stems=False)
    _cache_path(cache_dir, key).mkdir(parents=True)

    assert app_module._cache_read(key, use_stems=False) is None


def test_cache_miss_on_non_dict_payload(cache_dir, audio_file):
    key = app_module._cache_key(audio_file, use_stems=False)
    _write_cache(cache_dir, key, json.dumps([1, 2, 3]))

    assert app_module._cache_read(key, use_stems=False) is None


def test_cache_miss_when_vocal_risk_length_mismatches_timeline(cache_dir, audio_file):
    key = app_module._cache_key(audio_file, use_stems=True)
    payload = _valid_payload(use_stems=True)
    payload["timeline"]["vocalRisk"].pop()  # one sample short

    assert app_module._cache_read(key, use_stems=True) is None


def test_cache_miss_when_heuristic_entry_keeps_demucs_vocal_times(cache_dir, audio_file):
    key = app_module._cache_key(audio_file, use_stems=False)
    payload = _valid_payload(use_stems=False)
    payload["firstVocalAt"] = 3.0  # stale Demucs timestamp

    assert app_module._cache_read(key, use_stems=False) is None


def test_cache_miss_when_vocal_source_disagrees(cache_dir, audio_file):
    key = app_module._cache_key(audio_file, use_stems=True)
    payload = _valid_payload(use_stems=True)
    payload["vocalSource"] = "heuristic"  # top-level vs timeline disagreement

    assert app_module._cache_read(key, use_stems=True) is None


def test_cache_read_without_key_never_touches_disk(cache_dir):
    assert app_module._cache_read(None, use_stems=True) is None


def test_cache_write_then_read_roundtrip(cache_dir, audio_file):
    key = app_module._cache_key(audio_file, use_stems=False)
    payload = _valid_payload(use_stems=False)
    app_module._cache_write(key, payload)

    assert app_module._cache_read(key, use_stems=False) == payload
    # Atomic replace leaves no temp file behind.
    assert not (cache_dir / f"{key}.json.tmp").exists()


def test_cache_write_swallows_unwritable_directory(cache_dir, monkeypatch):
    # A path component that is a file, not a directory: mkdir/open must fail.
    blocker = cache_dir.parent / "blocker"
    blocker.write_text("x", encoding="utf-8")
    monkeypatch.setattr(app_module, "CACHE_DIR", blocker / "analysis")

    app_module._cache_write("deadbeef", _valid_payload(use_stems=False))  # no raise


@pytest.mark.skipif(sys.platform.startswith("win"), reason="chmod cannot make a dir read-only on Windows")
def test_cache_write_swallows_readonly_directory(tmp_path, monkeypatch):
    readonly = tmp_path / "readonly"
    readonly.mkdir()
    readonly.chmod(0o500)
    monkeypatch.setattr(app_module, "CACHE_DIR", readonly)
    try:
        app_module._cache_write("deadbeef", _valid_payload(use_stems=False))  # no raise
    finally:
        readonly.chmod(0o700)


def test_analyze_file_swallows_cache_read_errors(audio_file, cache_dir, monkeypatch):
    def boom(key, use_stems):
        raise OSError("simulated concurrent replacement")

    monkeypatch.setattr(app_module, "_cache_read", boom)
    # Must degrade to a fresh analysis rather than propagate the error.
    result = app_module.analyze_file(audio_file, use_stems=False)
    assert result["version"] == app_module.ANALYSIS_VERSION
    assert result["vocalSource"] == "heuristic"


def test_tampered_version_forces_reanalysis(audio_file, cache_dir, monkeypatch):
    key = app_module._cache_key(audio_file, use_stems=False)
    payload = _valid_payload(use_stems=False)
    payload["version"] = app_module.ANALYSIS_VERSION + 99
    _write_cache(cache_dir, key, payload)

    runs = {"n": 0}
    real = app_module._analyze_file_uncached

    def counting(path, use_stems=False):
        runs["n"] += 1
        return real(path, use_stems=use_stems)

    monkeypatch.setattr(app_module, "_analyze_file_uncached", counting)
    result = app_module.analyze_file(audio_file, use_stems=False)

    assert runs["n"] == 1
    assert result["version"] == app_module.ANALYSIS_VERSION
    # The stale entry is overwritten with the fresh one.
    reread = json.loads(_cache_path(cache_dir, key).read_text(encoding="utf-8"))
    assert reread["version"] == app_module.ANALYSIS_VERSION


def test_fit_vocal_risk_pads_and_truncates_to_timeline_length():
    assert app_module._fit_vocal_risk([0.1, 0.2], 4) == [0.1, 0.2, 0.0, 0.0]
    assert app_module._fit_vocal_risk([0.1, 0.2, 0.3, 0.4, 0.5], 3) == [0.1, 0.2, 0.3]
    fitted = app_module._fit_vocal_risk([0.1, "bad", None], 3)
    assert fitted == [0.1, 0.0, 0.0]
    assert app_module._fit_vocal_risk([], 2) == [0.0, 0.0]
