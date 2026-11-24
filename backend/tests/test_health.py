"""``/health`` must report the effective stems default and its source."""

from __future__ import annotations

import importlib
import os

from fastapi.testclient import TestClient


def _client_for_env(monkeypatch, env_value: str | None):
    """Re-import the app module with AUTODJ_STEMS pinned to ``env_value``."""
    if env_value is None:
        monkeypatch.delenv("AUTODJ_STEMS", raising=False)
    else:
        monkeypatch.setenv("AUTODJ_STEMS", env_value)
    module = importlib.reload(importlib.import_module("backend.app"))
    return TestClient(module.app), module


def test_health_reflects_builtin_default(monkeypatch):
    client, module = _client_for_env(monkeypatch, None)
    try:
        body = client.get("/health").json()
        assert body["stemsDefault"] is True
        assert body["stemsOn"] is True
        assert body["stemsSource"] == "default"
    finally:
        importlib.reload(importlib.import_module("backend.app"))


def test_health_reflects_autodj_stems_zero(monkeypatch):
    client, module = _client_for_env(monkeypatch, "0")
    try:
        body = client.get("/health").json()
        assert body["stemsDefault"] is False
        assert body["stemsOn"] is False
        assert body["stemsSource"] == "env"
    finally:
        importlib.reload(importlib.import_module("backend.app"))


def test_health_reflects_autodj_stems_false_and_off(monkeypatch):
    for raw in ("false", "no", "off"):
        client, _ = _client_for_env(monkeypatch, raw)
        try:
            body = client.get("/health").json()
            assert body["stemsOn"] is False
            assert body["stemsSource"] == "env"
        finally:
            importlib.reload(importlib.import_module("backend.app"))


def test_health_reflects_autodj_stems_enabled(monkeypatch):
    client, _ = _client_for_env(monkeypatch, "1")
    try:
        body = client.get("/health").json()
        assert body["stemsDefault"] is True
        assert body["stemsOn"] is True
        # Set explicitly, so the source is the environment even at default value.
        assert body["stemsSource"] == "env"
    finally:
        importlib.reload(importlib.import_module("backend.app"))


def test_health_request_override_overrides_the_default(monkeypatch):
    client, module = _client_for_env(monkeypatch, None)
    try:
        off = client.get("/health?stems=false").json()
        assert off["stemsOn"] is False
        assert off["stemsSource"] == "request"
        assert off["stemsDefault"] is True  # configured default untouched

        on = client.get("/health?stems=true").json()
        assert on["stemsOn"] is True
        assert on["stemsSource"] == "request"
    finally:
        importlib.reload(importlib.import_module("backend.app"))


def test_resolve_stems_default_helper():
    from backend.app import resolve_stems_default

    assert resolve_stems_default(None) == (True, "default")
    assert resolve_stems_default("1") == (True, "env")
    assert resolve_stems_default("yes") == (True, "env")
    assert resolve_stems_default("0") == (False, "env")
    assert resolve_stems_default("false") == (False, "env")
    assert resolve_stems_default(" OFF ") == (False, "env")
    assert resolve_stems_default("") == (False, "env")
