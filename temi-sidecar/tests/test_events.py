"""AGENT_PLAN M4：/events/ws 事件回传与导航到达确认（模拟模式）。"""

from __future__ import annotations

import os
import sys

os.environ["TEMI_MOCK"] = "1"
for mod in list(sys.modules.keys()):
    if mod.startswith("server") or mod.startswith("adapters"):
        del sys.modules[mod]

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def client() -> TestClient:
    from server import app  # noqa: PLC0415

    with TestClient(app) as c:
        yield c


def test_goto_reports_arrival_and_events(client: TestClient) -> None:
    with client.websocket_connect("/events/ws") as ws:
        assert ws.receive_json()["type"] == "connection"
        r = client.post("/goto", json={"location": "入口", "action_id": "act_1"}).json()
        assert r["ok"] is True and r["arrived"] is True and r["action_id"] == "act_1"
        started = ws.receive_json()
        arrived = ws.receive_json()
        assert started["type"] == "nav.started" and started["action_id"] == "act_1"
        assert arrived["type"] == "nav.arrived" and arrived["location"] == "入口"
    s = client.get("/status").json()
    assert s["location"] == "入口" and s["is_moving"] is False


def test_stop_emits_estop(client: TestClient) -> None:
    with client.websocket_connect("/events/ws") as ws:
        ws.receive_json()
        assert client.post("/stop", json={"immediate": True}).json()["ok"] is True
        assert ws.receive_json()["type"] == "estop"


def test_woz_callbacks_are_mapped(client: TestClient) -> None:
    with client.websocket_connect("/events/ws") as ws:
        ws.receive_json()
        client.post("/mock/event", json={"event": {"event": "onBatteryStatusChanged", "level": 15, "isCharging": True}})
        e = ws.receive_json()
        assert e == {**e, "type": "battery", "battery": 15, "charging": True}
        client.post("/mock/event", json={"event": {"event": "onDetectionStateChanged", "state": 2}})
        assert ws.receive_json()["type"] == "person.detected"
    s = client.get("/status").json()
    assert s["battery"] == 15 and s["charging"] is True
