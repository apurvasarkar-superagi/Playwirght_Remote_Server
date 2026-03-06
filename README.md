# Playwright Remote Server

A distributed Playwright remote server cluster. Run `playwright run-server` across multiple Docker containers, load-balanced behind Nginx, with a real-time monitoring dashboard and optional public access via ngrok.

## Architecture

```
Internet → ngrok → nginx (gateway:80)
                     ├── /playwright  → worker(s):9222  (WebSocket, round-robin)
                     ├── /api/        → api-manager:3000
                     ├── /socket.io/  → api-manager:3000
                     └── /            → dashboard:80
```

**Services:**
- **worker** — Python container running `playwright run-server`. Scale this for more parallelism.
- **api-manager** — Node.js/Fastify service that tracks worker status via Redis and streams logs/events to the dashboard over Socket.io.
- **dashboard** — Vue 3 SPA showing live worker status and log output.
- **gateway** — Nginx reverse proxy that routes all traffic.
- **redis** — Pub/sub and worker heartbeat storage.
- **ngrok** — Exposes the gateway publicly (optional).

---

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose v2+
- An [ngrok account](https://dashboard.ngrok.com/signup) and auth token (only needed for public access)

---

## Setup

**1. Clone the repo**

```bash
git clone <repo-url>
cd Playwright_Remote_Server
```

**2. Configure environment**

```bash
cp .env.example .env
```

Edit `.env` and paste your ngrok auth token:

```
NGROK_AUTHTOKEN=your_token_here
```

If you don't need public access, you can remove the `ngrok` service from `docker-compose.yml`.

---

## Running

**Start the stack (single worker):**

```bash
docker compose up --build
```

**Scale to multiple workers:**

```bash
docker compose up --build --scale worker=3
```

Nginx will automatically round-robin Playwright WebSocket connections across all worker containers.

---

## Connecting Playwright

### Local network

Run the helper script to get your connection URL:

```bash
bash get-ip.sh
```

Then connect from your test machine:

```python
# Python (playwright-python)
browser = await playwright.chromium.connect("ws://<host-ip>:8080/playwright")
```

```typescript
// TypeScript / Node.js
const browser = await chromium.connect("ws://<host-ip>:8080/playwright");
```

### Public access via ngrok

Once the stack is running, get the public ngrok URL:

```bash
# Open the ngrok inspector
open http://localhost:4040
```

The public WebSocket URL will be:

```
wss://<your-ngrok-subdomain>.ngrok-free.app/playwright
```

---

## Dashboard

Open [http://localhost:8080](http://localhost:8080) in your browser.

The dashboard shows:
- Live worker count (idle vs busy)
- Real-time log output from all workers
- Connection status indicator

---

## Stopping

```bash
docker compose down
```

To also remove volumes (clears Redis data):

```bash
docker compose down -v
```
