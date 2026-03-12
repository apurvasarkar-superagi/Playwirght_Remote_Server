import Fastify from 'fastify'
import cors from '@fastify/cors'
import { Server } from 'socket.io'
import IORedis from 'ioredis'

import { initDb } from './db.js'
import fastifyStatic from '@fastify/static'
import { recoverActiveRuns, startRun, finishRun, appendCommand, appendLog, appendScreenshot, setVideoFilename, listRuns, getRun, getScreenshots } from './runs.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

const fastify = Fastify({ logger: false })
await fastify.register(cors, { origin: '*' })

// Attach Socket.io to Fastify's own http.Server so both share port 3000
const io = new Server(fastify.server, { cors: { origin: '*' } })

// Redis clients — separate connections needed for pub/sub
const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null })
const subscriber = new IORedis(REDIS_URL, { maxRetriesPerRequest: null })

// Serve screenshot files from shared volume
await fastify.register(fastifyStatic, {
  root: '/data/screenshots',
  prefix: '/screenshots/',
  decorateReply: false,
})

// Serve video recordings from shared volume
await fastify.register(fastifyStatic, {
  root: '/data/videos',
  prefix: '/videos/',
  decorateReply: false,
})

// Initialise PostgreSQL schema then recover any active runs from the last process
await initDb()
await recoverActiveRuns(redis)

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

// ─── Run history endpoints ───────────────────────────────────────────────────

fastify.get('/api/runs', async (request) => {
  const limit = Math.min(parseInt(request.query.limit) || 50, 200)
  const offset = parseInt(request.query.offset) || 0
  const status = request.query.status || undefined
  return listRuns({ limit, offset, status })
})

fastify.get('/api/runs/:runId', async (request, reply) => {
  const run = await getRun(request.params.runId)
  if (!run) return reply.status(404).send({ error: 'Run not found' })
  return run
})

fastify.get('/api/runs/:runId/screenshots', async (request, reply) => {
  const screenshots = await getScreenshots(request.params.runId)
  if (!screenshots) return reply.status(404).send({ error: 'Run not found' })
  return screenshots
})

// ─── Worker status + logs via Redis pub/sub ──────────────────────────────────

await subscriber.subscribe('worker:status', 'worker:log', 'worker:command', 'worker:screenshot', 'worker:video')

subscriber.on('message', (channel, raw) => {
  const data = JSON.parse(raw)

  if (channel === 'worker:status') {
    io.emit('worker:status', data)
    if (data.status === 'busy') {
      startRun(data.id, data.scenarioName).then((runId) => {
        io.emit('run:started', {
          runId,
          workerId: data.id,
          scenarioName: data.scenarioName || null,
          startTime: data.lastHeartbeat,
        })
      }).catch((e) => console.error('[runs] startRun error:', e.message))
    } else if (data.status === 'idle') {
      finishRun(data.id, 'completed').catch((e) =>
        console.error('[runs] finishRun error:', e.message),
      )
    }
  } else if (channel === 'worker:log') {
    io.emit('worker:log', data)
    appendLog(data.workerId, data.message, data.timestamp)
      .catch((e) => console.error('[runs] appendLog error:', e.message))
  } else if (channel === 'worker:command') {
    io.emit('worker:command', data)
    appendCommand(data.workerId, {
      method: data.method,
      label: data.label,
      param: data.param,
      timestamp: data.timestamp,
      error: data.error || null,
    }).catch((e) => console.error('[runs] appendCommand error:', e.message))
  } else if (channel === 'worker:screenshot') {
    io.emit('screenshot:captured', data)
    appendScreenshot(data.workerId, {
      filename: data.filename,
      command: data.command,
      param: data.param,
      error: data.error,
      timestamp: data.timestamp,
    }).catch((e) => console.error('[runs] appendScreenshot error:', e.message))
  } else if (channel === 'worker:video') {
    setVideoFilename(data.workerId, data.filename)
      .catch((e) => console.error('[runs] setVideoFilename error:', e.message))
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
