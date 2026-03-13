import pg from 'pg'

const { Pool } = pg

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://playwright:playwright@localhost:5432/playwright_runs',
})

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS runs (
      id          SERIAL PRIMARY KEY,
      run_id      UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
      worker_id   TEXT NOT NULL,
      scenario    TEXT,
      status      TEXT NOT NULL DEFAULT 'running',
      started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      video_filename TEXT
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS run_commands (
      id         SERIAL PRIMARY KEY,
      run_id     UUID NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      method     TEXT,
      label      TEXT,
      param      TEXT,
      error      TEXT,
      ts         BIGINT NOT NULL
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS run_logs (
      id         SERIAL PRIMARY KEY,
      run_id     UUID NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      message    TEXT NOT NULL,
      ts         BIGINT NOT NULL
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS run_screenshots (
      id          SERIAL PRIMARY KEY,
      run_id      UUID NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      filename    TEXT NOT NULL,
      command     TEXT,
      param       TEXT,
      error       TEXT,
      ts          BIGINT NOT NULL
    )
  `)

  // Migration: add video_filename column if missing (table may already exist)
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS video_filename TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `)

  // Migration: add build_name column for grouping runs into builds
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS build_name TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `)

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_run_commands_run_id    ON run_commands(run_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_run_logs_run_id        ON run_logs(run_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_run_screenshots_run_id ON run_screenshots(run_id)`)

  console.log('[db] schema ready')
}
