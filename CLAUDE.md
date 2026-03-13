# Playwright Remote Server

## What This Project Is

A distributed Playwright remote server cluster. It does NOT run test scripts itself — it exposes `playwright run-server` over WebSocket so that **external clients** (local machines, CI pipelines) connect and send browser commands over the wire. The server just provides the browsers.

Client usage:
```python
browser = await playwright.chromium.connect("ws://<host>:8080/playwright")
```

## Architecture

```
External test client (scripts live HERE, not on the server)
        │
        ▼ WebSocket
┌─────────────────────────────────────────────────────┐
│  Nginx Gateway (port 8080)                          │
│    /playwright/{IP}  → Worker:9222 (WS proxy)       │
│    /stream/{IP}      → Worker:6080 (VNC/noVNC)      │
│    /api/*            → API Manager:3000 (REST)       │
│    /socket.io/*      → API Manager:3000 (WebSocket)  │
│    /                 → Dashboard:80 (Vue SPA)        │
└─────────────────────────────────────────────────────┘
        │
   ┌────┴────┬──────────────┐
   ▼         ▼              ▼
 Worker   Redis 7     PostgreSQL 16
          (pub/sub)   (persistence)
```

## Services

### worker/ (Python)
- **Entry**: `worker/src/server.py`
- Runs a Python WebSocket proxy on port 9222 that forwards to `playwright run-server` on internal port 9223
- The proxy intercepts Playwright wire protocol messages to:
  - Extract selector info from commands (click, fill, goto, etc.)
  - Force `headless=false` so browsers render on the virtual display
  - Publish command telemetry to Redis
- Xvfb provides a virtual display (1920x1080) for headed Chromium
- x11vnc + websockify (port 6080) stream the display via noVNC
- ffmpeg records video of each test run
- ImageMagick captures error screenshots on command failures
- Workers register in Redis with a 30s TTL heartbeat (refreshed every 10s)

### api-manager/ (Node.js/Fastify)
- **Entry**: `api-manager/src/index.js`
- **Key files**: `db.js` (PostgreSQL setup), `runs.js` (run CRUD), `queue.js` (BullMQ job queue)
- Tracks worker status via Redis heartbeats
- `POST /api/acquire-worker` — waits up to 2 min for an idle worker, returns its IP with an atomic lock
- Subscribes to Redis pub/sub channels and relays events to the dashboard via Socket.io
- Persists runs, commands, logs, screenshots, and video filenames to PostgreSQL
- Serves screenshot/video files from shared Docker volumes

### dashboard/ (Vue 3)
- **Entry**: `dashboard/src/main.js`, app root is `App.vue`
- **State**: `store.js` (Pinia) — maintains live worker status and ring-buffered logs/commands/screenshots
- **Socket**: `socket.js` — Socket.io client receiving real-time events
- Shows live worker grid (idle vs busy), log viewer, noVNC browser stream, job queue length
- Sidebar lists all runs with pass/fail indicators
- Selecting a run fetches full history from PostgreSQL, then appends live events

### gateway/ (Nginx)
- **Config**: `gateway/nginx.conf`
- Dynamic routing: `/playwright/{worker-ip}` proxies to that worker's port 9222
- VNC streaming: `/stream/{worker-ip}` proxies to worker's port 6080
- Uses Docker DNS (127.0.0.11) for dynamic service discovery when scaling
- Round-robin fallback: `/playwright` (no IP) load-balances across workers

## Redis Pub/Sub Channels

| Channel | Payload | Publisher |
|---------|---------|-----------|
| `worker:status` | Worker IP + status (idle/busy) | Worker |
| `worker:log` | Server log lines | Worker |
| `worker:command` | Browser command + selector info | Worker (proxy) |
| `worker:screenshot` | Screenshot filename | Worker |
| `worker:video` | Video filename | Worker |

## Database (PostgreSQL)

- DB name: `playwright_runs`, user: `playwright`, password: `playwright`
- Tables: runs, commands, logs, screenshots (all linked by run UUID)
- Schema is auto-created by `api-manager/src/db.js`

## Docker & Volumes

- **Orchestration**: `docker-compose.yml`
- **Scaling**: `docker compose up --build --scale worker=N`
- **Shared volumes**: `screenshots` and `videos` mounted on both worker and api-manager
- **Persistent volume**: `postgres_data` for database
- **Ports**: Gateway on 8080, ngrok inspector on 4040

## Environment Variables

- `.env` file at project root
- `NGROK_AUTHTOKEN` — required only for public access via ngrok
- Worker env: `REDIS_URL`, `DISPLAY=:99`, `STREAM_PORT=6080`
- API manager env: `REDIS_URL`, `PORT=3000`, `DATABASE_URL`

## Key Design Patterns

1. **Wire protocol interception** — the Python proxy modifies Playwright CDP messages in-flight, not the test scripts
2. **Redis TTL heartbeat** — workers are ephemeral; a missing heartbeat auto-removes them
3. **Atomic worker acquisition** — distributed lock prevents race conditions when assigning workers to clients
4. **Ring-buffer state** — dashboard keeps max 500 logs/commands in memory to prevent bloat
5. **Dual view** — live mode shows all workers; selecting a run shows its full DB history

## Common Development Commands

```bash
# Start everything
docker compose up --build

# Scale workers
docker compose up --build --scale worker=3

# Stop and clean up
docker compose down -v

# Get local connection URL
bash get-ip.sh
```
