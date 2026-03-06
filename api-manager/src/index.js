import Fastify from 'fastify'
import cors from '@fastify/cors'
import { Server } from 'socket.io'
import IORedis from 'ioredis'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

const fastify = Fastify({ logger: false })
await fastify.register(cors, { origin: '*' })

// Attach Socket.io to Fastify's own http.Server so both share port 3000
const io = new Server(fastify.server, { cors: { origin: '*' } })

// Redis clients — separate connections needed for pub/sub
const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null })
const subscriber = new IORedis(REDIS_URL, { maxRetriesPerRequest: null })

// ─── Queue tracking ──────────────────────────────────────────────────────────

let waitingCount = 0

function setWaiting(n) {
  waitingCount = n
  io.emit('queue:length', waitingCount)
}

// Atomically find and lock an idle worker. Returns worker object or null.
async function acquireIdleWorker() {
  const keys = await redis.keys('worker:*')
  if (!keys.length) return null

  const values = await redis.mget(...keys)
  const workers = values.map((v) => (v ? JSON.parse(v) : null)).filter(Boolean)

  for (const worker of workers) {
    if (worker.status !== 'idle') continue
    const acquired = await redis.set(`lock:worker:${worker.id}`, '1', 'EX', 300, 'NX')
    if (acquired === 'OK') return worker
  }
  return null
}

// ─── REST Routes ────────────────────────────────────────────────────────────

fastify.get('/api/stats', async () => {
  const keys = await redis.keys('worker:*')
  return { workers: keys.length }
})

// Acquire an idle worker — waits up to `timeout` ms (default 120s)
fastify.post('/api/acquire-worker', async (request, reply) => {
  const timeoutMs = parseInt(request.body?.timeout) || 120000
  const start = Date.now()

  setWaiting(waitingCount + 1)
  try {
    while (Date.now() - start < timeoutMs) {
      const worker = await acquireIdleWorker()
      if (worker) {
        console.log(`[queue] assigned worker ${worker.id} (${worker.ip})`)
        return {
          workerId: worker.id,
          workerIp: worker.ip,
          wsUrl: `/playwright/${worker.ip}`,
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    reply.status(503).send({ error: 'No workers available after timeout' })
  } finally {
    setWaiting(waitingCount - 1)
  }
})

// ─── Worker status + logs via Redis pub/sub ──────────────────────────────────

await subscriber.subscribe('worker:status', 'worker:log', 'worker:command')

subscriber.on('message', (channel, raw) => {
  const data = JSON.parse(raw)
  if (channel === 'worker:status') {
    io.emit('worker:status', data)
  } else if (channel === 'worker:log') {
    io.emit('worker:log', data)
  } else if (channel === 'worker:command') {
    io.emit('worker:command', data)
  }
})

// Broadcast current worker list every 2s (detects dead workers via TTL expiry)
async function broadcastWorkers() {
  const keys = await redis.keys('worker:*')
  if (!keys.length) {
    io.emit('workers:update', [])
    return
  }
  const values = await redis.mget(...keys)
  const workers = values.map((v) => (v ? JSON.parse(v) : null)).filter(Boolean)
  io.emit('workers:update', workers)
}
setInterval(broadcastWorkers, 2000)

// ─── Socket.io connections ──────────────────────────────────────────────────

io.on('connection', async (socket) => {
  console.log('Dashboard connected:', socket.id)

  const keys = await redis.keys('worker:*')
  let workers = []
  if (keys.length) {
    const values = await redis.mget(...keys)
    workers = values.map((v) => (v ? JSON.parse(v) : null)).filter(Boolean)
  }

  socket.emit('init', { workers })
  socket.emit('queue:length', waitingCount)
})

// ─── Start ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000
await fastify.listen({ port: Number(PORT), host: '0.0.0.0' })
console.log(`API Manager running on port ${PORT}`)
