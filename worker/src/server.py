"""
Playwright worker with WebSocket proxy for selector-aware command logging.

Architecture:
  test client → Python WS proxy :9222 → playwright run-server :9223

The proxy intercepts Playwright wire protocol messages (client → server)
before forwarding them, so it sees the full selector on Frame.click,
Frame.fill, Frame.goto, etc. — not just x,y coordinates.

Headed mode:
  Xvfb virtual display → Chromium renders here → x11vnc + websockify :6080
  noVNC in the dashboard connects via WebSocket to view/interact with the browser.
  Error screenshots are captured automatically on command failures.
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
WORKER_IP = _socket.gethostbyname(WORKER_ID)  # container's routable IP for direct routing
PROXY_PORT = 9222
SERVER_PORT = 9223
STREAM_PORT = int(os.environ.get("STREAM_PORT", "6080"))
DISPLAY = os.environ.get("DISPLAY", ":99")
SCREENSHOT_DIR = "/data/screenshots"
VIDEO_DIR = "/data/videos"
SCREEN_WIDTH = int(os.environ.get("SCREEN_WIDTH", "1920"))
SCREEN_HEIGHT = int(os.environ.get("SCREEN_HEIGHT", "1080"))

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


# ── Xvfb (virtual display) ──────────────────────────────────────────────────

def start_xvfb() -> subprocess.Popen:
    """Start Xvfb virtual framebuffer so Chromium can run in headed mode."""
    os.environ["DISPLAY"] = DISPLAY
    xvfb = subprocess.Popen(
        [
            "Xvfb", DISPLAY,
            "-screen", "0", f"{SCREEN_WIDTH}x{SCREEN_HEIGHT}x24",
            "-ac",         # disable access control
            "+extension", "RANDR",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    # Wait for the display to be available (x11-utils provides xdpyinfo)
    for attempt in range(50):
        # Check if Xvfb process has crashed
        if xvfb.poll() is not None:
            err = xvfb.stderr.read().decode("utf-8", errors="replace")
            print(f"[xvfb] ERROR: Xvfb exited with code {xvfb.returncode}: {err}", flush=True)
            raise RuntimeError(f"Xvfb failed to start: {err}")
        try:
            subprocess.check_call(
                ["xdpyinfo", "-display", DISPLAY],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            print(f"[xvfb] display {DISPLAY} ready ({SCREEN_WIDTH}x{SCREEN_HEIGHT})", flush=True)
            return xvfb
        except (subprocess.CalledProcessError, FileNotFoundError):
            time.sleep(0.2)
    raise RuntimeError(f"Xvfb display {DISPLAY} not ready after 10s")


# ── Window maximizer ─────────────────────────────────────────────────────────

def maximize_windows() -> None:
    """Watch for new X11 windows and force them to fill the Xvfb display using xdotool."""
    seen = set()
    while True:
        try:
            result = subprocess.run(
                ["xdotool", "search", "--onlyvisible", "--name", ""],
                capture_output=True, text=True, timeout=5,
            )
            wids = [w.strip() for w in result.stdout.strip().split("\n") if w.strip()]
            for wid in wids:
                if wid not in seen:
                    seen.add(wid)
                    subprocess.run(
                        ["xdotool", "windowmove", "--sync", wid, "0", "0"],
                        timeout=5, capture_output=True,
                    )
                    subprocess.run(
                        ["xdotool", "windowsize", "--sync", wid,
                         str(SCREEN_WIDTH), str(SCREEN_HEIGHT)],
                        timeout=5, capture_output=True,
                    )
                    print(f"[maximize] window {wid} → {SCREEN_WIDTH}x{SCREEN_HEIGHT}", flush=True)
        except Exception:
            pass
        time.sleep(1)


# ── VNC + websockify stream server ──────────────────────────────────────────

VNC_PORT = 5900


def start_vnc(retries: int = 5, delay: float = 2.0) -> subprocess.Popen:
    """Start x11vnc to capture the Xvfb display and serve VNC on localhost."""
    cmd = [
        "x11vnc",
        "-display", DISPLAY,
        "-nopw",                # no password (container-internal only)
        "-listen", "localhost", # only accept local connections (websockify fronts it)
        "-rfbport", str(VNC_PORT),
        "-shared",              # allow multiple viewers
        "-forever",             # don't exit after first client disconnects
        "-noxdamage",           # avoid X DAMAGE extension issues in containers
        "-ncache", "0",         # disable client-side caching for lower memory usage
    ]
    for attempt in range(retries):
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        time.sleep(1)
        if proc.poll() is not None:
            out = proc.stdout.read().decode("utf-8", errors="replace")
            print(f"[x11vnc] attempt {attempt + 1}/{retries} failed: {out.strip()}", flush=True)
            if attempt < retries - 1:
                time.sleep(delay)
                continue
            raise RuntimeError(f"x11vnc failed to start after {retries} attempts")
        print(f"[x11vnc] serving display {DISPLAY} on localhost:{VNC_PORT}", flush=True)
        # Log x11vnc output in background
        threading.Thread(target=_proc_logger, args=(proc, "x11vnc"), daemon=True).start()
        return proc
    raise RuntimeError("x11vnc failed to start")


def start_websockify() -> subprocess.Popen:
    """Start websockify to bridge VNC (TCP) to WebSocket on STREAM_PORT."""
    cmd = [
        "websockify",
        "--web", "/usr/share/novnc",  # serve noVNC static files (fallback, dashboard has its own)
        "0.0.0.0:" + str(STREAM_PORT),
        "localhost:" + str(VNC_PORT),
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    time.sleep(0.5)
    if proc.poll() is not None:
        out = proc.stdout.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"websockify failed to start: {out.strip()}")
    print(f"[websockify] bridging localhost:{VNC_PORT} → 0.0.0.0:{STREAM_PORT}", flush=True)
    threading.Thread(target=_proc_logger, args=(proc, "websockify"), daemon=True).start()
    return proc


def _proc_logger(proc: subprocess.Popen, name: str) -> None:
    """Log stdout/stderr from a subprocess."""
    for raw in iter(proc.stdout.readline, b""):
        line = raw.decode("utf-8", errors="replace").rstrip()
        if line:
            print(f"[{name}] {line}", flush=True)


# ── Error screenshots ────────────────────────────────────────────────────────

os.makedirs(SCREENSHOT_DIR, exist_ok=True)


def capture_screenshot(cmd: dict, error_msg: str) -> None:
    """Capture a screenshot of the current display and publish to Redis."""
    ts = int(time.time() * 1000)
    filename = f"{WORKER_ID}_{ts}.jpg"
    filepath = os.path.join(SCREENSHOT_DIR, filename)

    try:
        subprocess.run(
            [
                "import", "-window", "root",
                "-display", DISPLAY,
                "-quality", "80",
                filepath,
            ],
            timeout=5,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        r.publish("worker:screenshot", json.dumps({
            "workerId": WORKER_ID,
            "filename": filename,
            "timestamp": ts,
            "command": cmd.get("label", ""),
            "param": cmd.get("param", ""),
            "error": error_msg,
        }))
        print(f"[screenshot] captured {filename} for error: {error_msg[:80]}", flush=True)
    except Exception as e:
        print(f"[screenshot] capture failed: {e}", flush=True)


# ── Video recording ──────────────────────────────────────────────────────────

_recording_proc = None   # ffmpeg subprocess
_recording_file = None   # current video filename (without path)


def start_recording():
    """Start ffmpeg recording of the Xvfb display."""
    global _recording_proc, _recording_file

    stop_recording()  # ensure no stale process

    ts = int(time.time() * 1000)
    _recording_file = f"{WORKER_ID}_{ts}.mp4"
    filepath = os.path.join(VIDEO_DIR, _recording_file)

    try:
        _recording_proc = subprocess.Popen(
            [
                "ffmpeg",
                "-f", "x11grab",
                "-video_size", f"{SCREEN_WIDTH}x{SCREEN_HEIGHT}",
                "-framerate", "15",
                "-i", DISPLAY,
                "-c:v", "libx264",
                "-preset", "ultrafast",
                "-crf", "30",
                "-pix_fmt", "yuv420p",
                "-movflags", "+faststart",
                "-y",
                filepath,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        print(f"[video] recording started → {_recording_file} (pid {_recording_proc.pid})", flush=True)
    except Exception as e:
        print(f"[video] failed to start recording: {e}", flush=True)
        _recording_proc = None
        _recording_file = None


def stop_recording():
    """Stop ffmpeg recording and publish the video filename to Redis."""
    global _recording_proc, _recording_file

    if _recording_proc is None:
        return None

    filename = _recording_file
    proc = _recording_proc
    _recording_proc = None
    _recording_file = None

    try:
        # Send 'q' to ffmpeg stdin for graceful stop (finalizes mp4)
        proc.terminate()
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass

    filepath = os.path.join(VIDEO_DIR, filename) if filename else None
    if filepath and os.path.exists(filepath) and os.path.getsize(filepath) > 0:
        print(f"[video] recording stopped → {filename} ({os.path.getsize(filepath)} bytes)", flush=True)
        r.publish("worker:video", json.dumps({
            "workerId": WORKER_ID,
            "filename": filename,
            "timestamp": int(time.time() * 1000),
        }))
        return filename
    else:
        print(f"[video] recording stopped but file is empty or missing", flush=True)
        return None


# ── Redis helpers ─────────────────────────────────────────────────────────────

def set_scenario(name: str | None) -> None:
    global _scenario
    _scenario = name


def register(status: str) -> None:
    global _status
    _status = status
    payload = {
        "id": WORKER_ID,
        "ip": WORKER_IP,
        "status": status,
        "lastHeartbeat": int(time.time() * 1000),
        "streamUrl": f"/stream/{WORKER_IP}",
    }
    if _scenario:
        payload["scenarioName"] = _scenario
    data = json.dumps(payload)
    r.setex(f"worker:{WORKER_ID}", 30, data)
    r.publish("worker:status", data)
    # Release the acquire lock so the queue can assign this worker again
    if status == "idle":
        r.delete(f"lock:worker:{WORKER_ID}")


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


def publish_command_with_screenshot(cmd: dict, error_msg: str) -> None:
    """Publish error command and capture a screenshot."""
    publish_command(cmd, error_msg)
    capture_screenshot(cmd, error_msg)


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
            # Send full param — let the dashboard handle display truncation if needed
        return {"method": method, "label": label, "param": param}
    except Exception:
        return None


# ── Headed mode injection ─────────────────────────────────────────────────────

# Methods where we need to ensure headless=false is set.
# Wire protocol uses prefixed names like "browserType.launch", so we check suffixes.
_LAUNCH_SUFFIXES = {"launch", "launchbrowser", "launchserver", "launchpersistentcontext"}


def _is_launch_method(method: str) -> bool:
    """Check if a wire protocol method is a browser launch method (e.g. 'browserType.launch')."""
    if not method:
        return False
    # The method may be prefixed (e.g. "browserType.launch") — check the last segment
    suffix = method.rsplit(".", 1)[-1].lower()
    return suffix in _LAUNCH_SUFFIXES


def _set_headless_false(obj) -> bool:
    """Recursively find every 'headless' key in a nested dict/list and set it to False."""
    modified = False
    if isinstance(obj, dict):
        if "headless" in obj and obj["headless"] is not False:
            obj["headless"] = False
            modified = True
        for v in obj.values():
            if _set_headless_false(v):
                modified = True
    elif isinstance(obj, list):
        for item in obj:
            if _set_headless_false(item):
                modified = True
    return modified


def _find_headless_value(obj):
    """Recursively search for a 'headless' key and return its value, or None if not found."""
    if isinstance(obj, dict):
        if "headless" in obj:
            return obj["headless"]
        for v in obj.values():
            result = _find_headless_value(v)
            if result is not None:
                return result
    elif isinstance(obj, list):
        for item in obj:
            result = _find_headless_value(item)
            if result is not None:
                return result
    return None


def force_headed(message: str):
    """Rewrite wire protocol messages to force headed (headless=false) mode.

    Returns (rewritten_message, client_wants_headless).
    If the client explicitly sent headless=true in a launch method, we respect it
    and return client_wants_headless=True so the caller can skip VNC streaming.

    Two strategies when forcing headed:
    1. Any message containing '"headless"' — rewrite the value to false.
    2. Any launch-like method — inject headless=false into params even if absent.
       This is the critical case: Playwright clients often omit 'headless' entirely,
       and the server defaults to headless=true.
    """
    try:
        data = json.loads(message)
    except Exception:
        return message, False

    method = data.get("method", "")

    # Check if the client explicitly requested headless in a launch method
    if _is_launch_method(method):
        headless_val = _find_headless_value(data.get("params", {}))
        print(f"[proxy] launch method={method!r}, detected headless={headless_val!r}", flush=True)
        if headless_val is True:
            print(f"[proxy] client explicitly requested headless=true in method={method!r}, respecting it", flush=True)
            return message, True

    modified = False

    # Strategy 1: rewrite any existing "headless" key anywhere in the message
    if '"headless"' in message:
        modified = _set_headless_false(data)

    # Strategy 2: for launch methods, inject headless=false into params
    if _is_launch_method(method):
        params = data.get("params")
        if isinstance(params, dict):
            if params.get("headless") is not False:
                params["headless"] = False
                modified = True
            # Also handle nested options dict (some protocol versions)
            if isinstance(params.get("options"), dict):
                if params["options"].get("headless") is not False:
                    params["options"]["headless"] = False
                    modified = True

    if modified:
        rewritten = json.dumps(data)
        print(f"[proxy] forced headless=false in method={method!r}", flush=True)
        return rewritten, False
    return message, False


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


_first_connection = True


async def handle_connection(client_ws):
    """Proxy a single client WebSocket connection to playwright run-server."""
    global _first_connection
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

    # ── Headless detection ──────────────────────────────────────────────────
    # Check multiple sources (in priority order):
    #   1. ?headless=true query parameter (most reliable, user-controlled)
    #   2. x-playwright-headless: true header (simple custom header)
    #   3. x-playwright-launch-options header with {"headless": true}
    #   4. Wire protocol launch message (detected later in force_headed())
    qs = parse_qs(urlparse(path).query)
    _client_wants_headless = False
    _launch_header_key = None

    # Source 1: query parameter ?headless=true
    headless_param = qs.get("headless", [None])[0]
    if headless_param and headless_param.lower() in ("true", "1", "yes"):
        _client_wants_headless = True
        print(f"[proxy] headless=true detected from query parameter", flush=True)

    # Source 2 & 3: headers
    if not _client_wants_headless:
        for k, v in extra_headers.items():
            kl = k.lower()
            # Simple custom header
            if kl == "x-playwright-headless" and v.strip().lower() in ("true", "1", "yes"):
                _client_wants_headless = True
                print(f"[proxy] headless=true detected from x-playwright-headless header", flush=True)
                break
            # Standard launch options header
            if kl == "x-playwright-launch-options":
                _launch_header_key = k
                try:
                    opts = json.loads(v)
                    if opts.get("headless") is True:
                        _client_wants_headless = True
                        print(f"[proxy] headless=true detected from x-playwright-launch-options header", flush=True)
                except Exception:
                    pass

    # Debug: log detection result and all headers
    print(f"[proxy] headless detection result: {_client_wants_headless}", flush=True)
    print(f"[proxy] headers: {list(extra_headers.keys())}", flush=True)

    # Only force headed if client didn't explicitly request headless
    if not _client_wants_headless:
        extra_headers[_launch_header_key or "x-playwright-launch-options"] = json.dumps({
            "headless": False,
            "args": [
                "--start-maximized",
                "--no-sandbox",
            ],
        })
    else:
        print(f"[proxy] respecting headless mode — skipping headed injection", flush=True)

    # Start video recording (skip for headless runs — no display content)
    if not _client_wants_headless:
        start_recording()

    # Log first connection for debugging
    log_methods = _first_connection
    _first_connection = False

    try:
        async with websockets.connect(server_uri, max_size=None,
                                      extra_headers=extra_headers) as server_ws:
            print(f"[proxy] connection opened → {path}", flush=True)

            # in_flight: msg id → cmd dict — used to correlate error responses
            in_flight = {}
            loop = asyncio.get_running_loop()
            msg_count = [0]

            async def client_to_server():
                nonlocal _client_wants_headless
                async for msg in client_ws:
                    if isinstance(msg, str):
                        # Log first N methods for debugging headed/headless mode
                        if msg_count[0] < 30:
                            try:
                                d = json.loads(msg)
                                m = d.get("method", "")
                                # For launch methods, log full params to see headless value
                                if m and any(lm in m.lower() for lm in ['launch', 'browser']):
                                    print(f"[proxy:debug] #{msg_count[0]} method={m!r} FULL params={json.dumps(d.get('params', {}))[:500]}", flush=True)
                                else:
                                    pk = list(d.get("params", {}).keys())[:5]
                                    print(f"[proxy:debug] #{msg_count[0]} method={m!r} param_keys={pk}", flush=True)
                            except Exception:
                                pass
                        msg_count[0] += 1

                        # Detect headless from wire protocol and force headed if not requested
                        if not _client_wants_headless:
                            msg, detected_headless = force_headed(msg)
                            if detected_headless:
                                _client_wants_headless = True
                                print("[proxy] client wants headless — skipping headed rewriting for remaining messages", flush=True)
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
                                    # Publish error + auto-capture screenshot
                                    await loop.run_in_executor(
                                        None, publish_command_with_screenshot, cmd, error_msg
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
            print(f"[proxy] connection closed ← {path} ({msg_count[0]} messages)", flush=True)
    except (ConnectionClosed, OSError):
        pass
    except Exception as e:
        print(f"[proxy] error: {e}", flush=True)
    finally:
        # Stop video recording before going idle so the video is finalized
        stop_recording()
        set_scenario(None)
        # Register idle here — after all proxy tasks have finished — so the error
        # command is guaranteed to be in Redis before the idle status fires.
        register("idle")


async def run_proxy() -> None:
    print(f"Waiting for playwright server on :{SERVER_PORT}...", flush=True)
    await wait_for_playwright()
    print(f"Proxy ready on :{PROXY_PORT}", flush=True)
    publish_log(f"Worker {WORKER_ID} started on port {PROXY_PORT}")
    async with websockets.serve(handle_connection, "0.0.0.0", PROXY_PORT, max_size=None):
        await asyncio.Future()  # run forever


# ── Startup ───────────────────────────────────────────────────────────────────

# 1. Start Xvfb virtual display
xvfb_proc = start_xvfb()

# 2. Start window maximizer (forces all windows to fill the display)
threading.Thread(target=maximize_windows, daemon=True).start()

# 3. Start VNC server and websockify bridge
vnc_proc = start_vnc()
websockify_proc = start_websockify()

# 4. Register worker and start heartbeat
register("idle")
threading.Thread(target=heartbeat, daemon=True).start()

# 5. Start playwright run-server on internal port — proxy exposes :9222
proc = subprocess.Popen(
    ["playwright", "run-server", "--port", str(SERVER_PORT), "--host", "127.0.0.1"],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
)

print(f"Worker {WORKER_ID}: playwright server :{SERVER_PORT}, proxy :{PROXY_PORT}, vnc/websockify :{STREAM_PORT}", flush=True)


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


threading.Thread(target=stream_logs, daemon=True).start()


def shutdown(sig, frame):
    proc.terminate()
    websockify_proc.terminate()
    vnc_proc.terminate()
    xvfb_proc.terminate()
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
