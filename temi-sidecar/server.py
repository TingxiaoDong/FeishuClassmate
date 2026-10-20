"""
Temi Sidecar — FastAPI HTTP server bridging the feishu-classmate TypeScript
plugin to the Temi robot's WebSocket protocol.

Environment variables
---------------------
TEMI_MOCK     If set to any non-empty, non-"0" value, run in mock mode from startup.
              If unset, the server tries the real robot; falls back to mock on failure.
TEMI_IP       Temi robot IP address (required in real mode).
TEMI_PORT     Temi WebSocket port (default: 8175).
SIDECAR_PORT  Port this HTTP server listens on (default: 8091; used by run block only).
TEMI_WOZ_PRELAUNCH          Enable adb prelaunch before WS connect (default: 1).
TEMI_ADB_COMMAND            adb executable path/name (default: adb).
TEMI_ADB_PORT               adb TCP port on Temi (default: 5555).
TEMI_WOZ_PACKAGE            WOZ app package name (default: com.cdi.temiwoz.debug).
TEMI_WOZ_ACTIVITY           WOZ launcher activity (default: com.cdi.temiwoz.MainActivity).
TEMI_WOZ_PRELAUNCH_WAIT_S   Wait seconds after am start before WS connect (default: 2.0).
TEMI_IDLE_TIMEOUT_S         Auto-shutdown timeout after no command (default: 300).
TEMI_ASR_WEBHOOK_URL      If set, POST JSON to this URL on each WOZ ``onASRCompleted`` (user speech).
TEMI_ASR_WEBHOOK_SECRET   Optional shared secret sent as header ``X-Temi-ASR-Secret``.
TEMI_ASR_REFRESH_IDLE     If ``1`` (default), each ASR forward counts as activity for idle shutdown.
LOG_LEVEL     Python logging level string, e.g. DEBUG / INFO / WARNING (default: INFO).
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
import signal
import time
from contextlib import asynccontextmanager
from typing import Any, AsyncGenerator, Literal

import httpx
from fastapi import Body, FastAPI, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from adapters.temi import TemiWebSocketClient, extract_asr_text_from_woz, resolve_location

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("temi-sidecar")

# ---------------------------------------------------------------------------
# Configuration from environment
# ---------------------------------------------------------------------------

TEMI_IP: str = os.getenv("TEMI_IP", "")
TEMI_PORT: int = int(os.getenv("TEMI_PORT", "8175"))
SIDECAR_PORT: int = int(os.getenv("SIDECAR_PORT", "8091"))
TEMI_ADB_COMMAND: str = os.getenv("TEMI_ADB_COMMAND", "adb")
TEMI_ADB_PORT: int = int(os.getenv("TEMI_ADB_PORT", "5555"))
TEMI_WOZ_PACKAGE: str = os.getenv("TEMI_WOZ_PACKAGE", "com.cdi.temiwoz.debug")
TEMI_WOZ_ACTIVITY: str = os.getenv("TEMI_WOZ_ACTIVITY", "com.cdi.temiwoz.MainActivity")
TEMI_WOZ_PRELAUNCH_WAIT_S: float = float(os.getenv("TEMI_WOZ_PRELAUNCH_WAIT_S", "2.0"))
_woz_prelaunch_env = os.getenv("TEMI_WOZ_PRELAUNCH", "1").strip().lower()
TEMI_WOZ_PRELAUNCH: bool = _woz_prelaunch_env not in {"0", "false", "no", "off"}
TEMI_IDLE_TIMEOUT_S: float = float(os.getenv("TEMI_IDLE_TIMEOUT_S", "300"))

_mock_env = os.getenv("TEMI_MOCK", "")
_FORCE_MOCK: bool = bool(_mock_env and _mock_env != "0")

TEMI_ASR_WEBHOOK_URL: str = os.getenv("TEMI_ASR_WEBHOOK_URL", "").strip()
_asr_refresh = os.getenv("TEMI_ASR_REFRESH_IDLE", "1").strip().lower()
TEMI_ASR_REFRESH_IDLE: bool = _asr_refresh not in {"0", "false", "no", "off"}

# ---------------------------------------------------------------------------
# Application state
# ---------------------------------------------------------------------------

class AppState:
    def __init__(self) -> None:
        self.mock_mode: bool = _FORCE_MOCK
        self.client: TemiWebSocketClient | None = None
        # Simulated state for mock / status tracking
        self.battery: int = 87
        self.position: dict[str, float] = {"x": 1.2, "y": 0.5}
        self.is_moving: bool = False
        self.connected: bool = False
        self.last_command_at_monotonic: float = time.monotonic()
        self.idle_watchdog_task: asyncio.Task[None] | None = None
        self.shutdown_started: bool = False
        # AGENT_PLAN M4：导航动作与事件回传
        self.location: str | None = None
        self.heading_to: str | None = None
        self.charging: bool = False
        self.current_action: str | None = None
        self.nav_results: dict[str, dict[str, Any]] = {}


_state = AppState()


class EventHub:
    """把机器人事件推给所有 /events/ws 订阅者（大脑）。"""

    def __init__(self) -> None:
        self.queues: set[asyncio.Queue[dict[str, Any]]] = set()

    def emit(self, event: dict[str, Any]) -> None:
        event.setdefault("at", int(time.time() * 1000))
        for q in list(self.queues):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                logger.warning("[events] subscriber queue full; dropping event %s", event.get("type"))


_events = EventHub()


def _finish_nav(arrived: bool, reason: str | None = None) -> None:
    action_id = _state.current_action
    location = _state.heading_to
    if action_id is None and location is None:
        return
    if action_id:
        _state.nav_results[action_id] = {"arrived": arrived, "reason": reason}
        if len(_state.nav_results) > 100:
            _state.nav_results.pop(next(iter(_state.nav_results)))
    _state.is_moving = False
    if arrived:
        _state.location = location
    _state.heading_to = None
    _state.current_action = None
    evt: dict[str, Any] = {"type": "nav.arrived" if arrived else "nav.failed", "location": location, "action_id": action_id}
    if reason:
        evt["reason"] = reason
    _events.emit(evt)


async def _handle_robot_event(data: dict[str, Any]) -> None:
    """WOZ 回调 → 统一的机器人事件（字段名按 temi SDK 回调，兼容几种版本）。"""
    ev = str(data.get("event", ""))
    if ev == "onNavigationCompleted":
        _finish_nav(True)
    elif ev in {"onGoToLocationStatusChanged", "goToLocationStatusChanged"}:
        status = str(data.get("status", "")).lower()
        if status in {"complete", "completed"}:
            _finish_nav(True)
        elif status in {"abort", "aborted", "failed"}:
            _finish_nav(False, str(data.get("description") or data.get("descriptionId") or "导航被中止"))
    elif ev == "onDetectionStateChanged":
        state = data.get("state")
        detected = state in {2, "2", "DETECTED", "detected"}
        lost = state in {1, "1", "LOST", "lost"}
        if detected or lost:
            _events.emit({"type": "person.detected" if detected else "person.lost"})
    elif ev == "onBatteryStatusChanged":
        level = data.get("level", data.get("percentage", data.get("battery")))
        if isinstance(level, (int, float)):
            _state.battery = int(level)
            _state.charging = bool(data.get("isCharging", data.get("charging", False)))
            _events.emit({"type": "battery", "battery": _state.battery, "charging": _state.charging})
    elif ev == "onASRCompleted":
        text = extract_asr_text_from_woz(data)
        if text:
            _events.emit({"type": "asr", "text": text})

# ---------------------------------------------------------------------------
# Lifespan — connect/disconnect WebSocket on startup/shutdown
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # ---- startup ----
    if _state.mock_mode:
        logger.info("TEMI_MOCK=1 — starting in mock mode (no real robot connection)")
    elif not TEMI_IP:
        logger.warning(
            "TEMI_IP not set — cannot connect to real Temi; falling back to mock mode"
        )
        _state.mock_mode = True
    else:
        logger.info("Connecting to Temi at %s:%d …", TEMI_IP, TEMI_PORT)
        asr_hook = _handle_asr_completed if TEMI_ASR_WEBHOOK_URL else None
        if asr_hook:
            logger.info("ASR webhook enabled → %s", TEMI_ASR_WEBHOOK_URL[:80] + ("…" if len(TEMI_ASR_WEBHOOK_URL) > 80 else ""))
        _state.client = TemiWebSocketClient(
            TEMI_IP,
            TEMI_PORT,
            prelaunch_woz=TEMI_WOZ_PRELAUNCH,
            adb_command=TEMI_ADB_COMMAND,
            adb_port=TEMI_ADB_PORT,
            woz_package=TEMI_WOZ_PACKAGE,
            woz_activity=TEMI_WOZ_ACTIVITY,
            prelaunch_wait_s=TEMI_WOZ_PRELAUNCH_WAIT_S,
            on_asr_completed=asr_hook,
            on_event=_handle_robot_event,
        )
        ok = await _state.client.connect()
        if ok:
            _state.connected = True
            _mark_command_activity()
            logger.info("Temi connected successfully")
        else:
            logger.warning(
                "Could not reach Temi at %s:%d — falling back to mock mode",
                TEMI_IP,
                TEMI_PORT,
            )
            _state.mock_mode = True
            _state.client = None

    if not _state.mock_mode and TEMI_IDLE_TIMEOUT_S > 0:
        _state.idle_watchdog_task = asyncio.create_task(_idle_shutdown_watchdog())
        logger.info(
            "Idle shutdown watchdog enabled: %.0fs without command triggers sidecar exit",
            TEMI_IDLE_TIMEOUT_S,
        )

    # Register graceful shutdown on SIGTERM (in addition to FastAPI's own handling)
    loop = asyncio.get_event_loop()

    def _handle_sigterm() -> None:
        logger.info("SIGTERM received — scheduling shutdown")
        loop.create_task(_shutdown())

    try:
        loop.add_signal_handler(signal.SIGTERM, _handle_sigterm)
    except (NotImplementedError, RuntimeError):
        # Windows or non-main thread — skip
        pass

    yield

    # ---- shutdown ----
    await _shutdown()


async def _shutdown() -> None:
    if _state.shutdown_started:
        return
    _state.shutdown_started = True

    if _state.idle_watchdog_task and not _state.idle_watchdog_task.done():
        _state.idle_watchdog_task.cancel()
        try:
            await _state.idle_watchdog_task
        except asyncio.CancelledError:
            pass
        _state.idle_watchdog_task = None

    if _state.client:
        logger.info("Closing Temi WebSocket connection …")
        await _state.client.disconnect()
        _state.client = None
        _state.connected = False
    logger.info("Temi sidecar shut down cleanly")


def _mark_command_activity() -> None:
    """Record that a control command was received."""
    _state.last_command_at_monotonic = time.monotonic()


async def _handle_asr_completed(data: dict[str, Any]) -> None:
    """Forward Temi user-speech (ASR) events to the lab backend via HTTP POST."""
    url = TEMI_ASR_WEBHOOK_URL
    if not url:
        return

    text = extract_asr_text_from_woz(data)
    payload: dict[str, Any] = {
        "event": "onASRCompleted",
        "text": text,
        "raw": data,
    }
    headers = {"Content-Type": "application/json"}
    secret = os.getenv("TEMI_ASR_WEBHOOK_SECRET", "").strip()
    if secret:
        headers["X-Temi-ASR-Secret"] = secret

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(url, json=payload, headers=headers)
        if resp.status_code >= 400:
            logger.warning(
                "[ASR webhook] HTTP %s: %s",
                resp.status_code,
                (resp.text or "")[:500],
            )
        else:
            logger.info("[ASR webhook] forwarded ok text=%r", text)
    except Exception as exc:
        logger.warning("[ASR webhook] POST failed: %s", exc)

    if TEMI_ASR_REFRESH_IDLE:
        _mark_command_activity()


async def _idle_shutdown_watchdog() -> None:
    """Exit sidecar after prolonged command inactivity."""
    check_interval_s = 5.0
    try:
        while True:
            await asyncio.sleep(check_interval_s)
            idle_for_s = time.monotonic() - _state.last_command_at_monotonic
            if idle_for_s < TEMI_IDLE_TIMEOUT_S:
                continue

            logger.warning(
                "No control command for %.0fs (threshold %.0fs); disconnecting WS and exiting sidecar",
                idle_for_s,
                TEMI_IDLE_TIMEOUT_S,
            )
            await _shutdown()
            os.kill(os.getpid(), signal.SIGTERM)
            return
    except asyncio.CancelledError:
        return


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Temi Sidecar",
    version="0.1.0",
    description="HTTP bridge from feishu-classmate plugin to Temi robot WebSocket",
    lifespan=lifespan,
)

# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def _is_mock() -> bool:
    return _state.mock_mode


def _temi_error(message: str) -> dict[str, Any]:
    """Return a standard application-level error payload (HTTP 200, ok=false)."""
    return {"ok": False, "error": message}


# ---------------------------------------------------------------------------
# Pydantic request/response models
# ---------------------------------------------------------------------------

class GotoRequest(BaseModel):
    location: str
    action_id: str | None = None


class GotoResponse(BaseModel):
    ok: bool
    message: str
    mock: bool = False
    # True：收到了到达事件；False：指令已发出但没确认到达（仍可能在路上）
    arrived: bool | None = None
    action_id: str | None = None


class SpeakRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=500)
    voice: Literal["friendly", "professional"] = "friendly"


class SpeakResponse(BaseModel):
    ok: bool
    mock: bool = False
    error: str | None = None


class StopRequest(BaseModel):
    immediate: bool = False


class StopResponse(BaseModel):
    ok: bool
    mock: bool = False
    error: str | None = None


class DetectPersonRequest(BaseModel):
    timeout_ms: int = Field(..., ge=500, le=15_000)


class DetectPersonResponse(BaseModel):
    open_id: str | None
    confidence: float
    mock: bool = False
    error: str | None = None


class PhotoRequest(BaseModel):
    """Optional hint for logs (e.g. lab zone); does not affect auth."""

    context: str | None = Field(default=None, max_length=200)


class PhotoResponse(BaseModel):
    """Scene snapshot interpretation for lab outreach (align with research-collaboration-agent)."""

    ok: bool
    mock: bool = False
    availability_hint: Literal["likely_free", "likely_busy", "unknown"] = "unknown"
    people_present: int | None = None
    notes: str | None = None
    image_base64: str | None = None
    error: str | None = None


class Position(BaseModel):
    x: float
    y: float


class StatusResponse(BaseModel):
    connected: bool
    battery: int
    position: Position
    is_moving: bool
    mock: bool = False
    location: str | None = None
    heading_to: str | None = None
    charging: bool = False
    current_action: str | None = None


class RfidTag(BaseModel):
    tag_id: str
    location_estimate: str
    rssi: int


class RfidScanRequest(BaseModel):
    route: list[str] | None = None


class RfidScanResponse(BaseModel):
    tags: list[RfidTag]
    mock: bool = False
    error: str | None = None


class FocusSample(BaseModel):
    ts: float
    focused: bool
    score: float


class MonitorFocusRequest(BaseModel):
    student_open_id: str
    duration_s: int = Field(..., ge=1, le=3600)


class MonitorFocusResponse(BaseModel):
    samples: list[FocusSample]
    mock: bool = False
    error: str | None = None


class GestureRequest(BaseModel):
    type: Literal["encourage", "poke", "applause", "nod"]


class GestureResponse(BaseModel):
    ok: bool
    mock: bool = False
    error: str | None = None


class AskRequest(BaseModel):
    sentence: str = Field(..., min_length=1, max_length=500)


class AskResponse(BaseModel):
    ok: bool
    reply: str | None = None
    mock: bool = False
    error: str | None = None


class OpenUrlRequest(BaseModel):
    url: str = Field(..., min_length=1, max_length=2048)
    command: Literal["openURL", "interface"] = "openURL"


class CommandResponse(BaseModel):
    ok: bool
    mock: bool = False
    error: str | None = None


class TurnRequest(BaseModel):
    angle: float = Field(..., ge=-360, le=360)


class TiltRequest(BaseModel):
    angle: float = Field(..., ge=-30, le=60)


class LocationNameRequest(BaseModel):
    location_name: str = Field(..., min_length=1, max_length=100)


class CallRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=200)


class ContactResponse(BaseModel):
    ok: bool
    contacts: list[dict[str, Any]]
    mock: bool = False
    error: str | None = None


class ToggleRequest(BaseModel):
    on: bool


class CheckStateResponse(BaseModel):
    ok: bool
    value: bool | None = None
    mock: bool = False
    error: str | None = None


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

@app.get("/")
async def health() -> dict[str, Any]:
    """Health check — always returns 200."""
    return {
        "status": "ok",
        "mock": _is_mock(),
        "connected": _state.connected,
        "asr_webhook_configured": bool(TEMI_ASR_WEBHOOK_URL),
    }


# ---------------------------------------------------------------------------
# /goto
# ---------------------------------------------------------------------------

@app.post("/goto", response_model=GotoResponse)
async def goto(req: GotoRequest) -> GotoResponse:
    """Navigate Temi to a saved location by name."""
    _mark_command_activity()
    resolved = resolve_location(req.location)
    if _state.current_action or _state.heading_to:
        _finish_nav(False, "被新的导航指令取代")
    _state.current_action = req.action_id
    _state.heading_to = resolved
    _state.is_moving = True
    _events.emit({"type": "nav.started", "location": resolved, "action_id": req.action_id})

    if _is_mock():
        logger.info("[mock] /goto location=%r → %r", req.location, resolved)
        _finish_nav(True)
        return GotoResponse(ok=True, message=f"(mock) Temi 已导航到 {resolved}", mock=True, arrived=True, action_id=req.action_id)

    assert _state.client is not None
    try:
        ok = await _state.client.goto(resolved)
        # 到达事件可能比命令回调稍晚，最多再等 1 秒
        result: dict[str, Any] | None = None
        for _ in range(10):
            result = _state.nav_results.get(req.action_id) if req.action_id else None
            if result is not None or not req.action_id:
                break
            await asyncio.sleep(0.1)
        if result is not None:
            arrived = bool(result.get("arrived"))
            return GotoResponse(
                ok=arrived,
                arrived=arrived,
                action_id=req.action_id,
                message=f"Temi 已到达 {resolved}" if arrived else f"导航失败：{result.get('reason') or '未知原因'}",
            )
        if not ok:
            _finish_nav(False, "导航指令执行失败")
            return GotoResponse(ok=False, arrived=False, action_id=req.action_id, message="Navigation failed")
        # 没收到到达事件：不再假装已到达，交给事件流后续回报
        return GotoResponse(ok=True, arrived=False, action_id=req.action_id, message="已发出导航指令，尚未收到到达确认")
    except Exception as exc:
        logger.exception("/goto failed")
        _finish_nav(False, str(exc))
        return GotoResponse(ok=False, arrived=False, action_id=req.action_id, message=str(exc))


# ---------------------------------------------------------------------------
# /speak
# ---------------------------------------------------------------------------

@app.post("/speak", response_model=SpeakResponse)
async def speak(req: SpeakRequest) -> SpeakResponse:
    """Send TTS command to Temi."""
    _mark_command_activity()
    if _is_mock():
        logger.info("[mock] /speak text=%r voice=%r", req.text, req.voice)
        return SpeakResponse(ok=True, mock=True)

    assert _state.client is not None
    try:
        ok = await _state.client.speak(req.text, req.voice)
        return SpeakResponse(ok=ok, error=None if ok else "TTS command failed")
    except Exception as exc:
        logger.exception("/speak failed")
        return SpeakResponse(ok=False, error=str(exc))


# ---------------------------------------------------------------------------
# /stop
# ---------------------------------------------------------------------------

@app.post("/stop", response_model=StopResponse)
async def stop(req: StopRequest) -> StopResponse:
    """Stop all Temi motion."""
    _mark_command_activity()
    if _is_mock():
        logger.info("[mock] /stop immediate=%r", req.immediate)
        _finish_nav(False, "已急停")
        _state.is_moving = False
        _events.emit({"type": "estop"})
        return StopResponse(ok=True, mock=True)

    assert _state.client is not None
    try:
        ok = await _state.client.stop(immediate=req.immediate)
        _finish_nav(False, "已急停")
        _state.is_moving = False
        _events.emit({"type": "estop"})
        return StopResponse(ok=ok, error=None if ok else "Stop command failed")
    except Exception as exc:
        logger.exception("/stop failed")
        return StopResponse(ok=False, error=str(exc))


# ---------------------------------------------------------------------------
# /detect-person
# ---------------------------------------------------------------------------

@app.post("/detect-person", response_model=DetectPersonResponse)
async def detect_person(req: DetectPersonRequest) -> DetectPersonResponse:
    """Try to identify a person in Temi's camera view.

    Phase 1: always returns open_id=null (no vision pipeline yet).
    Phase 2: will integrate face / badge recognition.
    """
    _mark_command_activity()
    if _is_mock():
        logger.info("[mock] /detect-person timeout_ms=%d", req.timeout_ms)
        return DetectPersonResponse(open_id=None, confidence=0.0, mock=True)

    # Real mode — Phase 1: return null; Phase 2 will call detect_person()
    logger.info("/detect-person called (real mode, Phase 1 stub) timeout_ms=%d", req.timeout_ms)
    return DetectPersonResponse(open_id=None, confidence=0.0)


# ---------------------------------------------------------------------------
# /photo — scene snapshot for availability (Temi camera, not Feishu presence)
# ---------------------------------------------------------------------------

@app.post("/photo", response_model=PhotoResponse)
async def photo(req: PhotoRequest = Body(default_factory=PhotoRequest)) -> PhotoResponse:
    """One-shot scene snapshot to infer coarse lab presence / interruptibility.

    Used by the research-collaboration-agent skill: prefer this over Feishu
    user status or calendar when deciding whether to initiate in-lab social reach-out.
    """
    _mark_command_activity()
    if _is_mock():
        logger.info("[mock] /photo context=%r", req.context)
        return PhotoResponse(
            ok=True,
            mock=True,
            availability_hint="likely_free",
            people_present=1,
            notes="[mock] Single person at bench, screen-facing work, no obvious call/meeting pose.",
        )

    assert _state.client is not None
    try:
        out = await _state.client.photo_scene(req.context)
        hint = str(out.get("availability_hint", "unknown"))
        if hint not in ("likely_free", "likely_busy", "unknown"):
            hint = "unknown"
        return PhotoResponse(
            ok=True,
            mock=False,
            availability_hint=hint,  # type: ignore[arg-type]
            people_present=out.get("people_present") if isinstance(out.get("people_present"), int) else None,
            notes=out.get("notes") if isinstance(out.get("notes"), str) else None,
            image_base64=out.get("image_base64") if isinstance(out.get("image_base64"), str) else None,
        )
    except NotImplementedError as exc:
        logger.info("/photo real mode stub: %s", exc)
        return PhotoResponse(
            ok=True,
            mock=False,
            availability_hint="unknown",
            notes=str(exc),
        )
    except Exception as exc:
        logger.exception("/photo failed")
        return PhotoResponse(ok=False, error=str(exc), availability_hint="unknown")


# ---------------------------------------------------------------------------
# /status
# ---------------------------------------------------------------------------

@app.get("/status", response_model=StatusResponse)
async def status() -> StatusResponse:
    """Return current Temi status (battery, position, movement)."""
    if _is_mock():
        return StatusResponse(
            connected=False,
            battery=_state.battery,
            position=Position(x=_state.position["x"], y=_state.position["y"]),
            is_moving=_state.is_moving,
            mock=True,
            location=_state.location,
            heading_to=_state.heading_to,
            charging=_state.charging,
            current_action=_state.current_action,
        )

    return StatusResponse(
        connected=_state.connected,
        battery=_state.battery,
        position=Position(x=_state.position["x"], y=_state.position["y"]),
        is_moving=_state.is_moving,
        mock=False,
        location=_state.location,
        heading_to=_state.heading_to,
        charging=_state.charging,
        current_action=_state.current_action,
    )


# ---------------------------------------------------------------------------
# /rfid-scan
# ---------------------------------------------------------------------------

@app.post("/rfid-scan", response_model=RfidScanResponse)
async def rfid_scan(req: RfidScanRequest) -> RfidScanResponse:
    """Scan RFID tags along an optional route.

    Phase 2 feature — real mode raises NotImplementedError (returned as error payload).
    Mock mode returns plausible sample data.
    """
    _mark_command_activity()
    if _is_mock():
        logger.info("[mock] /rfid-scan route=%r", req.route)
        mock_tags = [
            RfidTag(tag_id="TAG-001A", location_estimate="工位区-A3", rssi=-62),
            RfidTag(tag_id="TAG-002B", location_estimate="生活仿真区", rssi=-71),
            RfidTag(tag_id="TAG-003C", location_estimate="入口", rssi=-55),
        ]
        # If a specific route was requested, filter to matching tags
        if req.route:
            mock_tags = [t for t in mock_tags if t.location_estimate in req.route] or mock_tags[:1]
        return RfidScanResponse(tags=mock_tags, mock=True)

    # Real mode
    assert _state.client is not None
    try:
        await _state.client.rfid_scan(req.route)
    except NotImplementedError as exc:
        return RfidScanResponse(tags=[], error=str(exc))
    except Exception as exc:
        logger.exception("/rfid-scan failed")
        return RfidScanResponse(tags=[], error=str(exc))

    return RfidScanResponse(tags=[])  # unreachable in Phase 1 but keeps type checker happy


# ---------------------------------------------------------------------------
# /monitor-focus
# ---------------------------------------------------------------------------

@app.post("/monitor-focus", response_model=MonitorFocusResponse)
async def monitor_focus(req: MonitorFocusRequest) -> MonitorFocusResponse:
    """Monitor student focus for duration_s seconds via Temi's camera.

    Phase 2 feature — real mode returns an error.
    Mock mode produces a realistic mostly-focused pattern with a dip in the middle.
    """
    _mark_command_activity()
    if _is_mock():
        logger.info(
            "[mock] /monitor-focus open_id=%r duration_s=%d",
            req.student_open_id,
            req.duration_s,
        )
        samples = _generate_mock_focus_samples(req.duration_s)
        return MonitorFocusResponse(samples=samples, mock=True)

    # Real mode
    assert _state.client is not None
    try:
        await _state.client.monitor_focus(req.student_open_id, req.duration_s)
    except NotImplementedError as exc:
        return MonitorFocusResponse(samples=[], error=str(exc))
    except Exception as exc:
        logger.exception("/monitor-focus failed")
        return MonitorFocusResponse(samples=[], error=str(exc))

    return MonitorFocusResponse(samples=[])


def _generate_mock_focus_samples(duration_s: int) -> list[FocusSample]:
    """Generate a mock focus trace: high focus → mid-session dip → recovery.

    Uses cos(2π·elapsed) so the score is high at t=0, dips around the
    midpoint (t=0.5), and recovers toward the end — a realistic classroom
    attention pattern.
    """
    samples: list[FocusSample] = []
    sample_interval = 5  # one sample every 5 seconds
    n = max(1, duration_s // sample_interval)
    base_ts = time.time()
    for i in range(n):
        elapsed = i / max(n - 1, 1)  # 0.0 → 1.0
        # cos(2π·t): 1 at start, -1 at midpoint, 1 at end
        # Scaled to roughly 0.55–0.95 range
        score = round(0.75 + 0.20 * math.cos(2 * math.pi * elapsed), 3)
        # A sample counts as "focused" when score > 0.6
        focused = score > 0.6
        samples.append(
            FocusSample(
                ts=round(base_ts + i * sample_interval, 3),
                focused=focused,
                score=score,
            )
        )
    return samples


# ---------------------------------------------------------------------------
# /gesture
# ---------------------------------------------------------------------------

@app.post("/gesture", response_model=GestureResponse)
async def gesture(req: GestureRequest) -> GestureResponse:
    """Trigger a physical gesture on Temi.

    Phase 2 feature — real mode returns an error.
    Mock mode acknowledges immediately.
    """
    _mark_command_activity()
    if _is_mock():
        logger.info("[mock] /gesture type=%r", req.type)
        return GestureResponse(ok=True, mock=True)

    # Real mode
    assert _state.client is not None
    try:
        await _state.client.gesture(req.type)
    except NotImplementedError as exc:
        return GestureResponse(ok=False, error=str(exc))
    except Exception as exc:
        logger.exception("/gesture failed")
        return GestureResponse(ok=False, error=str(exc))

    return GestureResponse(ok=True)


@app.post("/ask", response_model=AskResponse)
async def ask(req: AskRequest) -> AskResponse:
    _mark_command_activity()
    if _is_mock():
        logger.info("[mock] /ask sentence=%r", req.sentence)
        return AskResponse(ok=True, reply="(mock) 收到提问", mock=True)

    assert _state.client is not None
    try:
        reply = await _state.client.ask(req.sentence)
        return AskResponse(ok=True, reply=reply)
    except Exception as exc:
        logger.exception("/ask failed")
        return AskResponse(ok=False, error=str(exc))


@app.post("/open-url", response_model=CommandResponse)
async def open_url(req: OpenUrlRequest) -> CommandResponse:
    _mark_command_activity()
    if _is_mock():
        logger.info("[mock] /open-url command=%r url=%r", req.command, req.url)
        return CommandResponse(ok=True, mock=True)

    assert _state.client is not None
    try:
        ok = await _state.client.open_url(req.url, command=req.command)
        return CommandResponse(ok=ok, error=None if ok else "Open URL command failed")
    except Exception as exc:
        logger.exception("/open-url failed")
        return CommandResponse(ok=False, error=str(exc))


@app.post("/turn", response_model=CommandResponse)
async def turn(req: TurnRequest) -> CommandResponse:
    _mark_command_activity()
    if _is_mock():
        logger.info("[mock] /turn angle=%s", req.angle)
        return CommandResponse(ok=True, mock=True)

    assert _state.client is not None
    try:
        ok = await _state.client.turn(req.angle)
        return CommandResponse(ok=ok, error=None if ok else "Turn command failed")
    except Exception as exc:
        logger.exception("/turn failed")
        return CommandResponse(ok=False, error=str(exc))


@app.post("/tilt", response_model=CommandResponse)
async def tilt(req: TiltRequest) -> CommandResponse:
    _mark_command_activity()
    if _is_mock():
        logger.info("[mock] /tilt angle=%s", req.angle)
        return CommandResponse(ok=True, mock=True)

    assert _state.client is not None
    try:
        ok = await _state.client.tilt(req.angle)
        return CommandResponse(ok=ok, error=None if ok else "Tilt command failed")
    except Exception as exc:
        logger.exception("/tilt failed")
        return CommandResponse(ok=False, error=str(exc))


@app.get("/contacts", response_model=ContactResponse)
async def contacts() -> ContactResponse:
    _mark_command_activity()
    if _is_mock():
        logger.info("[mock] /contacts")
        return ContactResponse(ok=True, contacts=[], mock=True)

    assert _state.client is not None
    try:
        contacts_list = await _state.client.get_contact()
        return ContactResponse(ok=True, contacts=contacts_list)
    except Exception as exc:
        logger.exception("/contacts failed")
        return ContactResponse(ok=False, contacts=[], error=str(exc))


@app.post("/call", response_model=CommandResponse)
async def call(req: CallRequest) -> CommandResponse:
    _mark_command_activity()
    if _is_mock():
        logger.info("[mock] /call user_id=%r", req.user_id)
        return CommandResponse(ok=True, mock=True)

    assert _state.client is not None
    try:
        ok = await _state.client.call(req.user_id)
        return CommandResponse(ok=ok, error=None if ok else "Call command failed")
    except Exception as exc:
        logger.exception("/call failed")
        return CommandResponse(ok=False, error=str(exc))


@app.post("/wakeup", response_model=CommandResponse)
async def wakeup() -> CommandResponse:
    _mark_command_activity()
    if _is_mock():
        logger.info("[mock] /wakeup")
        return CommandResponse(ok=True, mock=True)

    assert _state.client is not None
    try:
        ok = await _state.client.wakeup()
        return CommandResponse(ok=ok, error=None if ok else "Wakeup command failed")
    except Exception as exc:
        logger.exception("/wakeup failed")
        return CommandResponse(ok=False, error=str(exc))


@app.post("/save-location", response_model=CommandResponse)
async def save_location(req: LocationNameRequest) -> CommandResponse:
    _mark_command_activity()
    if _is_mock():
        logger.info("[mock] /save-location name=%r", req.location_name)
        return CommandResponse(ok=True, mock=True)

    assert _state.client is not None
    try:
        ok = await _state.client.save_location(req.location_name)
        return CommandResponse(ok=ok, error=None if ok else "Save location command failed")
    except Exception as exc:
        logger.exception("/save-location failed")
        return CommandResponse(ok=False, error=str(exc))


@app.post("/delete-location", response_model=CommandResponse)
async def delete_location(req: LocationNameRequest) -> CommandResponse:
    _mark_command_activity()
    if _is_mock():
        logger.info("[mock] /delete-location name=%r", req.location_name)
        return CommandResponse(ok=True, mock=True)

    assert _state.client is not None
    try:
        ok = await _state.client.delete_location(req.location_name)
        return CommandResponse(ok=ok, error=None if ok else "Delete location command failed")
    except Exception as exc:
        logger.exception("/delete-location failed")
        return CommandResponse(ok=False, error=str(exc))


@app.post("/stop-movement", response_model=CommandResponse)
async def stop_movement() -> CommandResponse:
    _mark_command_activity()
    if _is_mock():
        logger.info("[mock] /stop-movement")
        _state.is_moving = False
        return CommandResponse(ok=True, mock=True)

    assert _state.client is not None
    try:
        ok = await _state.client.stop_movement()
        _state.is_moving = False
        return CommandResponse(ok=ok, error=None if ok else "Stop movement command failed")
    except Exception as exc:
        logger.exception("/stop-movement failed")
        return CommandResponse(ok=False, error=str(exc))


@app.post("/detection-mode/set", response_model=CheckStateResponse)
async def set_detection_mode(req: ToggleRequest) -> CheckStateResponse:
    _mark_command_activity()
    if _is_mock():
        logger.info("[mock] /detection-mode/set on=%r", req.on)
        return CheckStateResponse(ok=True, value=req.on, mock=True)

    assert _state.client is not None
    try:
        value = await _state.client.set_detection_mode(req.on)
        return CheckStateResponse(ok=True, value=value)
    except Exception as exc:
        logger.exception("/detection-mode/set failed")
        return CheckStateResponse(ok=False, error=str(exc))


@app.get("/detection-mode/check", response_model=CheckStateResponse)
async def check_detection_mode() -> CheckStateResponse:
    _mark_command_activity()
    if _is_mock():
        logger.info("[mock] /detection-mode/check")
        return CheckStateResponse(ok=True, value=False, mock=True)

    assert _state.client is not None
    try:
        value = await _state.client.check_detection_mode()
        return CheckStateResponse(ok=True, value=value)
    except Exception as exc:
        logger.exception("/detection-mode/check failed")
        return CheckStateResponse(ok=False, error=str(exc))


@app.post("/track-user", response_model=CheckStateResponse)
async def track_user(req: ToggleRequest) -> CheckStateResponse:
    _mark_command_activity()
    if _is_mock():
        logger.info("[mock] /track-user on=%r", req.on)
        return CheckStateResponse(ok=True, value=req.on, mock=True)

    assert _state.client is not None
    try:
        value = await _state.client.set_track_user_on(req.on)
        return CheckStateResponse(ok=True, value=value)
    except Exception as exc:
        logger.exception("/track-user failed")
        return CheckStateResponse(ok=False, error=str(exc))


@app.post("/be-with-me", response_model=CommandResponse)
async def be_with_me() -> CommandResponse:
    _mark_command_activity()
    if _is_mock():
        logger.info("[mock] /be-with-me")
        return CommandResponse(ok=True, mock=True)

    assert _state.client is not None
    try:
        ok = await _state.client.be_with_me()
        return CommandResponse(ok=ok, error=None if ok else "beWithMe command failed")
    except Exception as exc:
        logger.exception("/be-with-me failed")
        return CommandResponse(ok=False, error=str(exc))


@app.post("/constraint-be-with", response_model=CommandResponse)
async def constraint_be_with() -> CommandResponse:
    _mark_command_activity()
    if _is_mock():
        logger.info("[mock] /constraint-be-with")
        return CommandResponse(ok=True, mock=True)

    assert _state.client is not None
    try:
        ok = await _state.client.constraint_be_with()
        return CommandResponse(ok=ok, error=None if ok else "constraintBeWith command failed")
    except Exception as exc:
        logger.exception("/constraint-be-with failed")
        return CommandResponse(ok=False, error=str(exc))


# ---------------------------------------------------------------------------
# /events/ws — 机器人事件推给大脑（AGENT_PLAN M4 §3.2）
# ---------------------------------------------------------------------------

@app.websocket("/events/ws")
async def events_ws(ws: WebSocket) -> None:
    await ws.accept()
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=200)
    _events.queues.add(queue)
    await ws.send_json({"type": "connection", "connected": _state.connected, "at": int(time.time() * 1000)})
    try:
        while True:
            event = await queue.get()
            await ws.send_json(event)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        _events.queues.discard(queue)


class MockEventRequest(BaseModel):
    event: dict[str, Any]


@app.post("/mock/event")
async def mock_event(req: MockEventRequest) -> dict[str, Any]:
    """仅模拟模式：注入一条 WOZ 回调（开发调试事件链路用）。"""
    if not _is_mock():
        return {"ok": False, "error": "only available in mock mode"}
    await _handle_robot_event(req.event)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Entry point (for direct `python server.py` execution)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "server:app",
        host="0.0.0.0",
        port=SIDECAR_PORT,
        reload=False,
        log_level=os.getenv("LOG_LEVEL", "info").lower(),
    )
