"""Analysis-path tests: stems modes, cache separation and fallback hygiene."""

from __future__ import annotations

import json

from backend import app as app_module


def test_heuristic_timeline_is_self_consistent(audio_file, cache_dir):
    result = app_module.analyze_file(audio_file, use_stems=False)

    n = len(result["timeline"]["t"])
    assert n > 1
    assert len(result["timeline"]["vocalRisk"]) == n
    assert result["timeline"]["vocalSource"] == "heuristic"
    assert result["vocalSource"] == "heuristic"
    assert result["firstVocalAt"] is None
    assert result["lastVocalAt"] is None
    assert result["stems"] is False
    assert result["analyzer"] == app_module.ANALYZER_ID


def test_stems_true_uses_demucs_risk_not_heuristic(audio_file, cache_dir, fake_demucs):
    heuristic = app_module.analyze_file(audio_file, use_stems=False)
    demucs = app_module.analyze_file(audio_file, use_stems=True)

    assert demucs["vocalSource"] == "demucs"
    assert demucs["timeline"]["vocalSource"] == "demucs"
    assert demucs["stems"] is True
    assert len(demucs["timeline"]["vocalRisk"]) == len(demucs["timeline"]["t"])
    assert 0.91 in demucs["timeline"]["vocalRisk"]
    # The second request must not have been served the first request's data:
    # the distinctive Demucs values cannot appear in the heuristic result.
    assert 0.91 not in heuristic["timeline"]["vocalRisk"]
    assert demucs["firstVocalAt"] == 2.0
    assert demucs["lastVocalAt"] == 5.0
    assert fake_demucs["timeline"] == 1


def test_two_modes_keep_independent_cache_entries(audio_file, cache_dir, fake_demucs):
    first = app_module.analyze_file(audio_file, use_stems=False)
    second = app_module.analyze_file(audio_file, use_stems=True)

    key_false = app_module._cache_key(audio_file, use_stems=False)
    key_true = app_module._cache_key(audio_file, use_stems=True)
    assert key_false != key_true

    cached_files = sorted(p.name for p in cache_dir.glob("*.json"))
    assert cached_files == sorted([f"{key_false}.json", f"{key_true}.json"])

    # Reads hit the cache (Demucs is not invoked again) and keep their source.
    cached_false = app_module.analyze_file(audio_file, use_stems=False)
    cached_true = app_module.analyze_file(audio_file, use_stems=True)
    assert fake_demucs["timeline"] == 1
    assert cached_false["vocalSource"] == "heuristic"
    assert cached_true["vocalSource"] == "demucs"
    assert cached_true["timeline"]["vocalRisk"] == second["timeline"]["vocalRisk"]
    assert first["timeline"]["vocalRisk"] != second["timeline"]["vocalRisk"]


def test_demucs_failure_falls_back_to_heuristic_without_stale_values(
    audio_file, cache_dir, failing_demucs
):
    result = app_module.analyze_file(audio_file, use_stems=True)

    assert failing_demucs["timeline"] == 1
    assert result["timeline"]["vocalSource"] == "heuristic"
    assert result["vocalSource"] == "heuristic"
    assert result["firstVocalAt"] is None
    assert result["lastVocalAt"] is None
    assert len(result["timeline"]["vocalRisk"]) == len(result["timeline"]["t"])
    # The fallback entry is cached under the stems=true key with honest metadata.
    key = app_module._cache_key(audio_file, use_stems=True)
    on_disk = json.loads((cache_dir / f"{key}.json").read_text(encoding="utf-8"))
    assert on_disk["stems"] is True
    assert on_disk["vocalSource"] == "heuristic"
    assert on_disk["firstVocalAt"] is None
    assert on_disk["lastVocalAt"] is None


def test_demucs_risk_is_always_aligned_to_timeline(audio_file, cache_dir, monkeypatch):
    import math
    import sys
    import types

    def short_timeline(path, duration, step=1.0):
        # Deliberately one window short of the real timeline length.
        n = max(1, int(math.ceil(duration / step))) - 1
        return {
            "vocalRisk": [0.7] * n,
            "firstVocalAt": 0.0,
            "lastVocalAt": duration,
        }

    fake = types.ModuleType("backend.stems")
    fake.vocal_activity_timeline = short_timeline
    fake.analyze_vocals = lambda path, duration: {"available": False}
    monkeypatch.setitem(sys.modules, "backend.stems", fake)

    result = app_module.analyze_file(audio_file, use_stems=True)
    n_expected = max(1, int(math.ceil(result["duration"] / app_module.TIMELINE_STEP)))
    assert result["vocalSource"] == "demucs"
    assert len(result["timeline"]["vocalRisk"]) == len(result["timeline"]["t"])
    assert len(result["timeline"]["vocalRisk"]) == n_expected


def test_unwritable_cache_dir_still_returns_full_result(audio_file, tmp_path, monkeypatch):
    # Windows ignores the read-only directory bit for file creation, so block
    # writes the cross-platform way: point the cache at a path whose parent is
    # a file. Reads then fail with OSError and writes cannot create anything.
    blocker = tmp_path / "blocker"
    blocker.write_text("x", encoding="utf-8")
    monkeypatch.setattr(app_module, "CACHE_DIR", blocker / "nested")

    result = app_module.analyze_file(audio_file, use_stems=False)

    assert result["analyzer"] == app_module.ANALYZER_ID
    assert result["version"] == app_module.ANALYSIS_VERSION
    assert result["stems"] is False
    assert result["vocalSource"] == "heuristic"
    assert len(result["timeline"]["vocalRisk"]) == len(result["timeline"]["t"])
    assert result["mixableIntro"] >= 0.0
    assert result["waveform"]["peaks"]


def test_tampered_cache_json_forces_reanalysis(audio_file, cache_dir):
    key = app_module._cache_key(audio_file, use_stems=False)
    cache_dir.mkdir(parents=True, exist_ok=True)
    entry = cache_dir / f"{key}.json"
    entry.write_text("{broken", encoding="utf-8")

    result = app_module.analyze_file(audio_file, use_stems=False)
    assert result["version"] == app_module.ANALYSIS_VERSION
    # A healthy entry replaced the corrupt one.
    assert json.loads(entry.read_text(encoding="utf-8"))["analyzer"] == app_module.ANALYZER_ID
