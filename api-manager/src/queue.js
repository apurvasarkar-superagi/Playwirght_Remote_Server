import IORedis from 'ioredis'
import { Queue } from 'bullmq'

const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
})

export const queue = new Queue('playwright-jobs', { connection })

export async function addJob(data) {
  const job = await queue.add(data.name, data)
  return { id: job.id, name: job.name, status: 'waiting', data }
}

export async function getJobs() {
  const [active, waiting, completed, failed] = await Promise.all([
    queue.getActive(0, 50),
    queue.getWaiting(0, 50),
    queue.getCompleted(0, 50),
    queue.getFailed(0, 50),
  ])

  const fmt = (status) => (jobs) =>
    jobs.map((j) => ({
      id: j.id,
      name: j.name,
      status,
      timestamp: j.timestamp,
      processedOn: j.processedOn,
      finishedOn: j.finishedOn,
      failedReason: j.failedReason,
    }))

  return [
    ...fmt('active')(active),
    ...fmt('waiting')(waiting),
    ...fmt('completed')(completed),
    ...fmt('failed')(failed),
  ]
}

export async function getJob(id) {
  const job = await queue.getJob(id)
  if (!job) return null
  const state = await job.getState()
  return {
    id: job.id,
    name: job.name,
    status: state,
    data: job.data,
    timestamp: job.timestamp,
    processedOn: job.processedOn,
    finishedOn: job.finishedOn,
    failedReason: job.failedReason,
    returnvalue: job.returnvalue,
  }
}

export async function getStats() {
  return queue.getJobCounts('waiting', 'active', 'completed', 'failed')
}
