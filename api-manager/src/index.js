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

// ─── REST Routes ────────────────────────────────────────────────────────────

fastify.get('/api/stats', async () => {
  const keys = await redis.keys('worker:*')
  return { workers: keys.length }
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

// Broadcast current worker list every 5s (detects dead workers via TTL expiry)
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
})

// ─── Start ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000
await fastify.listen({ port: Number(PORT), host: '0.0.0.0' })
console.log(`API Manager running on port ${PORT}`)
