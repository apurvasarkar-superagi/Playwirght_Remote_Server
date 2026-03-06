"""
Playwright worker: runs `playwright run-server`, captures its output,
forwards each log line to Redis pub/sub, and registers itself so the
monitoring dashboard can track worker status.

Status is derived by watching pw:server log lines:
  "Connected client" → busy
  "disconnected"     → idle
"""
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time

import redis

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")
WORKER_ID = socket.gethostname()
PORT = 9222

r = redis.from_url(REDIS_URL, decode_responses=True)

# Track current status so the heartbeat publishes the right value
_status = "idle"


def register(status: str) -> None:
    global _status
    _status = status
    data = json.dumps(
        {"id": WORKER_ID, "status": status, "lastHeartbeat": int(time.time() * 1000)}
    )
    r.setex(f"worker:{WORKER_ID}", 30, data)
    r.publish("worker:status", data)


def publish_log(message: str) -> None:
    try:
        r.publish(
            "worker:log",
            json.dumps(
                {
                    "workerId": WORKER_ID,
                    "message": message,
                    "timestamp": int(time.time() * 1000),
                }
            ),
        )
    except Exception:
        pass


def heartbeat() -> None:
    while True:
        time.sleep(10)
        try:
            register(_status)
        except Exception as e:
            print(f"[heartbeat] {e}", flush=True)


register("idle")
threading.Thread(target=heartbeat, daemon=True).start()

proc = subprocess.Popen(
    # stdbuf forces line-buffered stdout/stderr so logs stream immediately
    # instead of being held until the buffer fills or the process exits
    ["stdbuf", "-oL", "-eL", "playwright", "run-server", "--port", str(PORT), "--host", "0.0.0.0"],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,  # merge stderr so we capture everything
)

print(f"Worker {WORKER_ID} listening on port {PORT}", flush=True)
publish_log(f"Worker {WORKER_ID} started on port {PORT}")


def stream_logs() -> None:
    for raw in iter(proc.stdout.readline, b""):
        line = raw.decode("utf-8", errors="replace").rstrip()
        if not line:
            continue
        print(line, flush=True)
        publish_log(line)

        # Detect connection events from pw:server debug output
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
proc.wait()
