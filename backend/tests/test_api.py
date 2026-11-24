"""End-to-end HTTP acceptance tests for /analyze and /health."""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from backend import app as app_module
from backend.app import app


def _post_analyze(client: TestClient, audio_file: str, stems: bool | None = None):
    params = {} if stems is None else {"stems": str(stems).lower()}
    with open(audio_file, "rb") as handle:
        return client.post(
            "/analyze",
            params=params,
            files={"file": ("track.wav", handle, "audio/wav")},
        )


def test_analyze_then_stems_true_does_not_return_heuristic_cache(
    audio_file, cache_dir, fake_demucs
):
    client = TestClient(app)

    first = _post_analyze(client, audio_file, stems=False)
    assert first.status_code == 200
    first_body = first.json()
    assert first_body["vocalSource"] == "heuristic"
    assert 0.91 not in first_body["timeline"]["vocalRisk"]

    second = _post_analyze(client, audio_file, stems=True)
    assert second.status_code == 200
    second_body = second.json()
    assert second_body["vocalSource"] == "demucs"
    assert 0.91 in second_body["timeline"]["vocalRisk"]
    assert len(second_body["timeline"]["vocalRisk"]) == len(second_body["timeline"]["t"])
    assert fake_demucs["timeline"] == 1


def test_analyze_reanalyzes_after_cache_version_tampering(audio_file, cache_dir):
    client = TestClient(app)
    response = _post_analyze(client, audio_file, stems=False)
    assert response.status_code == 200

    key = app_module._cache_key(audio_file, use_stems=False)
    entry = cache_dir / f"{key}.json"
    tampered = json.loads(entry.read_text(encoding="utf-8"))
    tampered["version"] = app_module.ANALYSIS_VERSION + 1000
    entry.write_text(json.dumps(tampered), encoding="utf-8")

    again = _post_analyze(client, audio_file, stems=False)
    assert again.status_code == 200
    body = again.json()
    assert body["version"] == app_module.ANALYSIS_VERSION
    assert body["analyzer"] == app_module.ANALYZER_ID
    assert json.loads(entry.read_text(encoding="utf-8"))["version"] == app_module.ANALYSIS_VERSION


def test_analyze_survives_unwritable_cache_dir(audio_file, tmp_path, monkeypatch):
    blocker = tmp_path / "blocker"
    blocker.write_text("x", encoding="utf-8")
    monkeypatch.setattr(app_module, "CACHE_DIR", blocker / "nested")

    client = TestClient(app)
    response = _post_analyze(client, audio_file, stems=False)

    assert response.status_code == 200
    body = response.json()
    assert body["analyzer"] == app_module.ANALYZER_ID
    assert body["version"] == app_module.ANALYSIS_VERSION
    assert body["vocalSource"] == "heuristic"
    assert len(body["timeline"]["vocalRisk"]) == len(body["timeline"]["t"])
    assert body["mixableIntro"] >= 0.0
    assert body["waveform"]["peaks"]


def test_analyze_survives_corrupt_cache_json(audio_file, cache_dir):
    client = TestClient(app)
    key = app_module._cache_key(audio_file, use_stems=False)
    cache_dir.mkdir(parents=True, exist_ok=True)
    (cache_dir / f"{key}.json").write_text("{{not json", encoding="utf-8")

    response = _post_analyze(client, audio_file, stems=False)
    assert response.status_code == 200
    assert response.json()["version"] == app_module.ANALYSIS_VERSION


def test_health_tracks_autodj_stems_env(monkeypatch):
    import importlib

    monkeypatch.setenv("AUTODJ_STEMS", "0")
    module = importlib.reload(importlib.import_module("backend.app"))
    try:
        body = TestClient(module.app).get("/health").json()
        assert body["stemsOn"] is False
        assert body["stemsSource"] == "env"
    finally:
        monkeypatch.delenv("AUTODJ_STEMS", raising=False)
        importlib.reload(importlib.import_module("backend.app"))
