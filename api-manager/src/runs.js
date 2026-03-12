import { pool } from './db.js'

// workerId → run_id for currently active runs
const activeRuns = new Map()

// workerId → true if any command with an error was recorded during the run
const runHasError = new Map()

// Per-worker lock: prevents two concurrent startRun calls for the same worker
// from both seeing activeRuns.has() === false and double-inserting.
const startLocks = new Map() // workerId → Promise

/**
 * Called once at startup. Cross-checks DB 'running' runs against Redis worker keys.
 * Workers that are still alive in Redis: restored into activeRuns (same UUID reused).
 * Workers that are gone from Redis: their runs are marked 'failed'.
 *
 * redis client is passed in to avoid a circular dependency.
 */
export async function recoverActiveRuns(redis) {
  const { rows } = await pool.query(
    `SELECT run_id, worker_id FROM runs WHERE status = 'running'`,
  )
  if (!rows.length) return

  const stale = []
  for (const row of rows) {
    const workerKey = await redis.get(`worker:${row.worker_id}`)
    if (workerKey) {
      // Worker is still alive — reuse the existing run UUID
      activeRuns.set(row.worker_id, row.run_id)
      console.log(`[runs] recovered run ${row.run_id} for live worker ${row.worker_id}`)
    } else {
      // Worker is gone — mark the run as failed
      stale.push(row.run_id)
    }
  }

  if (stale.length) {
    await pool.query(
      `UPDATE runs SET status = 'failed', finished_at = NOW() WHERE run_id = ANY($1)`,
      [stale],
    )
    console.log(`[runs] marked ${stale.length} stale run(s) as failed`)
  }
}

export async function startRun(workerId, scenario) {
  // If another call is already inserting a run for this worker, wait for it to finish
  if (startLocks.has(workerId)) {
    await startLocks.get(workerId)
    return activeRuns.get(workerId)
  }

  if (activeRuns.has(workerId)) {
    // Same worker, same run — update scenario name if we now have one
    if (scenario) {
      await pool.query(
        `UPDATE runs SET scenario = $1 WHERE run_id = $2 AND scenario IS NULL`,
        [scenario, activeRuns.get(workerId)],
      )
    }
    return activeRuns.get(workerId)
  }

  // Acquire lock before the async INSERT
  let resolveLock
  startLocks.set(workerId, new Promise((r) => { resolveLock = r }))
  try {
    const { rows } = await pool.query(
      `INSERT INTO runs (worker_id, scenario) VALUES ($1, $2) RETURNING run_id`,
      [workerId, scenario || null],
    )
    const runId = rows[0].run_id
    activeRuns.set(workerId, runId)
    console.log(`[runs] started run ${runId} worker=${workerId} scenario=${scenario}`)
    return runId
  } finally {
    startLocks.delete(workerId)
    resolveLock()
  }
}

export async function finishRun(workerId, status = 'completed') {
  const runId = activeRuns.get(workerId)
  if (!runId) return null
  activeRuns.delete(workerId)

  // Use in-memory error flag — avoids a race with unfinished appendCommand writes
  const finalStatus = (status === 'completed' && runHasError.get(workerId)) ? 'failed' : status
  runHasError.delete(workerId)

  await pool.query(
    `UPDATE runs SET status = $1, finished_at = NOW() WHERE run_id = $2`,
    [finalStatus, runId],
  )
  console.log(`[runs] finished run ${runId} status=${finalStatus}`)
  return runId
}

async function resolveRunId(workerId) {
  // If startRun is mid-INSERT for this worker, wait for it to finish
  if (startLocks.has(workerId)) await startLocks.get(workerId)
  return activeRuns.get(workerId) ?? null
}

export async function appendCommand(workerId, cmd) {
  const runId = await resolveRunId(workerId)
  if (!runId) return
  if (cmd.error) runHasError.set(workerId, true)
  await pool.query(
    `INSERT INTO run_commands (run_id, method, label, param, error, ts)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [runId, cmd.method, cmd.label, cmd.param || null, cmd.error || null, cmd.timestamp],
  )
}

export async function appendLog(workerId, message, timestamp) {
  const runId = await resolveRunId(workerId)
  if (!runId) return
  await pool.query(
    `INSERT INTO run_logs (run_id, message, ts) VALUES ($1, $2, $3)`,
    [runId, message, timestamp],
  )
}

export async function listRuns({ limit = 50, offset = 0, status } = {}) {
  const conditions = []
  const values = []

  if (status) {
    values.push(status)
    conditions.push(`status = $${values.length}`)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  values.push(limit, offset)

  const { rows } = await pool.query(
    `SELECT r.id, r.run_id, r.worker_id, r.scenario, r.status,
            r.started_at, r.finished_at,
            COUNT(rc.id)::int AS command_count
     FROM runs r
     LEFT JOIN run_commands rc ON rc.run_id = r.run_id
     ${where}
     GROUP BY r.id
     ORDER BY r.started_at DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  )
  return rows
}

export async function appendScreenshot(workerId, { filename, command, param, error, timestamp }) {
  const runId = await resolveRunId(workerId)
  if (!runId) return null
  await pool.query(
    `INSERT INTO run_screenshots (run_id, filename, command, param, error, ts)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [runId, filename, command || null, param || null, error || null, timestamp],
  )
  return runId
}

export async function getScreenshots(runId) {
  const { rows } = await pool.query(
    `SELECT filename, command, param, error, ts::float8 AS timestamp
     FROM run_screenshots WHERE run_id = $1 ORDER BY id`,
    [runId],
  )
  return rows
}

export async function getRun(runId) {
  const [runRes, cmdsRes, logsRes, screenshotsRes] = await Promise.all([
    pool.query(`SELECT * FROM runs WHERE run_id = $1`, [runId]),
    pool.query(
      `SELECT method, label, param, error, ts::float8 AS timestamp
       FROM run_commands WHERE run_id = $1 ORDER BY id`,
      [runId],
    ),
    pool.query(
      `SELECT message, ts::float8 AS timestamp
       FROM run_logs WHERE run_id = $1 ORDER BY id`,
      [runId],
    ),
    pool.query(
      `SELECT filename, command, param, error, ts::float8 AS timestamp
       FROM run_screenshots WHERE run_id = $1 ORDER BY id`,
      [runId],
    ),
  ])
  if (!runRes.rows.length) return null
  return {
    ...runRes.rows[0],
    commands: cmdsRes.rows,
    logs: logsRes.rows,
    screenshots: screenshotsRes.rows,
  }
}
