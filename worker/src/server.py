"""
Playwright worker with WebSocket proxy for selector-aware command logging.

Architecture:
  test client → Python WS proxy :9222 → playwright run-server :9223

The proxy intercepts Playwright wire protocol messages (client → server)
before forwarding them, so it sees the full selector on Frame.click,
Frame.fill, Frame.goto, etc. — not just x,y coordinates.
"""
import asyncio
import json
import os
import signal
import socket as _socket
import subprocess
import sys
import threading
import time
from urllib.parse import urlparse, parse_qs

import redis
import websockets
from websockets.exceptions import ConnectionClosed

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")
WORKER_ID = _socket.gethostname()
PROXY_PORT = 9222
SERVER_PORT = 9223

r = redis.from_url(REDIS_URL, decode_responses=True)
_status = "idle"
_scenario = None  # current scenario name (set per-connection)

# Playwright wire protocol method names → (human label, primary param key).
# The wire protocol uses short names (e.g. "goto", "click") not qualified names.
COMMAND_MAP = {
    "goto":               ("Navigate to URL",     "url"),
    "reload":             ("Reload Page",         None),
    "goBack":             ("Navigate Back",       None),
    "goForward":          ("Navigate Forward",    None),
    "click":              ("Click",               "selector"),
    "dblclick":           ("Double Click",        "selector"),
    "fill":               ("Fill",                "selector"),
    "type":               ("Type",                "selector"),
    "selectOption":       ("Select Option",       "selector"),
    "check":              ("Check",               "selector"),
    "uncheck":            ("Uncheck",             "selector"),
    "hover":              ("Hover",               "selector"),
    "tap":                ("Tap",                 "selector"),
    "press":              ("Key Press",           "key"),
    "screenshot":         ("Screenshot",          None),
    "pdf":                ("Save as PDF",         None),
    "evaluate":           ("Execute Script",      None),
    "evaluateExpression": ("Execute Script",      None),
    "waitForSelector":    ("Wait For Element",    "selector"),
    "waitForNavigation":  ("Wait For Navigation", None),
    "newPage":            ("New Page",            None),
    "close":              ("Close",               None),
    "setViewportSize":    ("Set Viewport",        None),
    "bringToFront":       ("Switch to Tab",       None),
    "setContent":         ("Set Content",         None),
}

# Methods to ignore in diagnostic logging (internal/infrastructure noise)
_INFRA_METHODS = {
    "initialize", "__create__", "__dispose__", "ping",
    "setDefaultNavigationTimeoutNoReply", "setDefaultTimeoutNoReply",
    "enableRecorder", "setTransportOptions", "addInitScript",
    "crNewBrowserCDPSession", "newContext", "launch", "connect",
}


# ── Redis helpers ─────────────────────────────────────────────────────────────

def set_scenario(name: str | None) -> None:
    global _scenario
    _scenario = name


def register(status: str) -> None:
    global _status
    _status = status
    payload = {"id": WORKER_ID, "status": status, "lastHeartbeat": int(time.time() * 1000)}
    if _scenario:
        payload["scenarioName"] = _scenario
    data = json.dumps(payload)
    r.setex(f"worker:{WORKER_ID}", 30, data)
    r.publish("worker:status", data)


def publish_log(message: str) -> None:
    try:
        r.publish("worker:log", json.dumps({
            "workerId": WORKER_ID,
            "message": message,
            "timestamp": int(time.time() * 1000),
        }))
    except Exception:
        pass


def publish_command(cmd: dict, error: str = None) -> None:
    try:
        payload = {
            "workerId": WORKER_ID,
            "method": cmd["method"],
            "label": cmd["label"],
            "param": cmd["param"],
            "timestamp": int(time.time() * 1000),
        }
        if error:
            payload["error"] = error
        r.publish("worker:command", json.dumps(payload))
    except Exception:
        pass


# ── Wire protocol parser ──────────────────────────────────────────────────────

def try_parse_command(message: str):
    """Parse a Playwright wire protocol client→server message. Return command dict or None."""
    try:
        data = json.loads(message)
        method = data.get("method")
        if not method:
            return None
        if method not in COMMAND_MAP:
            # Log unrecognised methods (skip infra noise) to help calibrate the map
            if method not in _INFRA_METHODS:
                params = data.get("params", {})
                print(f"[proxy:unknown] method={method!r} param_keys={list(params.keys())}", flush=True)
            return None
        label, param_key = COMMAND_MAP[method]
        param = None
        if param_key:
            param = data.get("params", {}).get(param_key)
            if isinstance(param, str) and len(param) > 120:
                param = param[:117] + "..."
        return {"method": method, "label": label, "param": param}
    except Exception:
        return None


# ── Heartbeat ─────────────────────────────────────────────────────────────────

def heartbeat() -> None:
    while True:
        time.sleep(10)
        try:
            register(_status)
        except Exception as e:
            print(f"[heartbeat] {e}", flush=True)


# ── WebSocket proxy ───────────────────────────────────────────────────────────

async def wait_for_playwright(retries: int = 40, delay: float = 0.5) -> None:
    """Block until playwright run-server is accepting TCP connections."""
    for _ in range(retries):
        try:
            reader, writer = await asyncio.open_connection("127.0.0.1", SERVER_PORT)
            writer.close()
            await writer.wait_closed()
            return
        except OSError:
            await asyncio.sleep(delay)
    raise RuntimeError(f"playwright run-server did not start on :{SERVER_PORT}")


async def handle_connection(client_ws):
    """Proxy a single client WebSocket connection to playwright run-server."""
    path = getattr(client_ws, "path", "/")

    # Extract scenario name — prefer X-Scenario-Name header (more reliable than
    # query params which Playwright's connect() may not preserve), fall back to ?scenario=
    scenario = None
    if hasattr(client_ws, 'request_headers'):
        scenario = client_ws.request_headers.get('x-scenario-name') or \
                   client_ws.request_headers.get('X-Scenario-Name')
    if not scenario:
        qs = parse_qs(urlparse(path).query)
        scenario = qs.get("scenario", [None])[0]
    print(f"[proxy] new connection path={path!r} scenario={scenario!r}", flush=True)
    set_scenario(scenario)
    # Register busy immediately so scenarioName is in Redis before stream_logs fires
    register("busy")

    # Strip the query string before forwarding to playwright (it doesn't need it)
    clean_path = urlparse(path).path
    server_uri = f"ws://127.0.0.1:{SERVER_PORT}{clean_path}"

    # Forward the original HTTP upgrade headers so playwright can read browser
    # type / launch mode from them (determines "chromium" vs "null" launch mode).
    # Skip x-scenario-name — it's only for our proxy, not for playwright.
    _skip = {'host', 'connection', 'upgrade', 'sec-websocket-key',
             'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-accept',
             'x-scenario-name'}
    extra_headers = {}
    if hasattr(client_ws, 'request_headers'):
        extra_headers = {k: v for k, v in client_ws.request_headers.items()
                         if k.lower() not in _skip}

    try:
        async with websockets.connect(server_uri, max_size=None,
                                      extra_headers=extra_headers) as server_ws:
            print(f"[proxy] connection opened → {path}", flush=True)

            # in_flight: msg id → cmd dict — used to correlate error responses
            in_flight = {}
            loop = asyncio.get_running_loop()

            async def client_to_server():
                async for msg in client_ws:
                    if isinstance(msg, str):
                        cmd = try_parse_command(msg)
                        if cmd:
                            try:
                                msg_id = json.loads(msg).get("id")
                                if msg_id is not None:
                                    in_flight[msg_id] = cmd
                            except Exception:
                                pass
                            await loop.run_in_executor(None, publish_command, cmd)
                    await server_ws.send(msg)

            async def server_to_client():
                async for msg in server_ws:
                    if isinstance(msg, str):
                        try:
                            data = json.loads(msg)
                            msg_id = data.get("id")
                            if msg_id is not None:
                                cmd = in_flight.pop(msg_id, None)
                                if cmd and "error" in data:
                                    err = data["error"].get("error", {})
                                    # First line only, max 200 chars
                                    error_msg = err.get("message", "Unknown error").split("\n")[0][:200]
                                    await loop.run_in_executor(
                                        None, publish_command, cmd, error_msg
                                    )
                        except Exception:
                            pass
                    await client_ws.send(msg)

            done, pending_tasks = await asyncio.wait(
                [asyncio.create_task(client_to_server()),
                 asyncio.create_task(server_to_client())],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending_tasks:
                task.cancel()
            print(f"[proxy] connection closed ← {path}", flush=True)
    except (ConnectionClosed, OSError):
        pass
    except Exception as e:
        print(f"[proxy] error: {e}", flush=True)
    finally:
        set_scenario(None)


async def run_proxy() -> None:
    print(f"Waiting for playwright server on :{SERVER_PORT}...", flush=True)
    await wait_for_playwright()
    print(f"Proxy ready on :{PROXY_PORT}", flush=True)
    publish_log(f"Worker {WORKER_ID} started on port {PROXY_PORT}")
    async with websockets.serve(handle_connection, "0.0.0.0", PROXY_PORT, max_size=None):
        await asyncio.Future()  # run forever


# ── Startup ───────────────────────────────────────────────────────────────────

register("idle")
threading.Thread(target=heartbeat, daemon=True).start()

# playwright run-server on internal port — proxy exposes :9222
proc = subprocess.Popen(
    ["playwright", "run-server", "--port", str(SERVER_PORT), "--host", "127.0.0.1"],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
)

print(f"Worker {WORKER_ID}: playwright server :{SERVER_PORT}, proxy :{PROXY_PORT}", flush=True)


def stream_logs() -> None:
    for raw in iter(proc.stdout.readline, b""):
        line = raw.decode("utf-8", errors="replace").rstrip()
        if not line:
            continue
        print(line, flush=True)
        publish_log(line)

        if "pw:server" in line:
            if "Connected client" in line:
                register("busy")
            elif "disconnected" in line:
                register("idle")


threading.Thread(target=stream_logs, daemon=True).start()


def shutdown(sig, frame):
    proc.terminate()
    try:
        r.delete(f"worker:{WORKER_ID}")
    except Exception:
        pass
    sys.exit(0)


signal.signal(signal.SIGTERM, shutdown)

try:
    asyncio.run(run_proxy())
except KeyboardInterrupt:
    pass
