import { defineStore } from 'pinia'
import { socket } from './socket.js'

const MAX_LOGS = 500
const MAX_COMMANDS = 500
const MAX_RUNS = 100

export const useStore = defineStore('main', {
  state: () => ({
    connected: false,
    workers: [],
    logs: [],      // live ring-buffer [{ workerId, message, timestamp }]
    commands: [],  // live ring-buffer [{ workerId, method, label, param, error, timestamp }]
    runs: [],      // [{ id (UUID), scenarioName, workerId, status, startTime, endTime, hasError }]
    selectedRun: null,  // UUID of the selected run, null = show all live
    runDetail: null,    // { commands[], logs[] } fetched from DB for the selected run
    waitingCount: 0,
    // workerId → true: error arrived before run:started — applied when run is registered
    pendingErrors: {},
  }),

  getters: {
    busyWorkers: (s) => s.workers.filter((w) => w.status === 'busy').length,
    idleWorkers: (s) => s.workers.filter((w) => w.status !== 'busy').length,
    activeRuns:  (s) => s.runs.filter((r) => r.status === 'running').length,

    // When a run is selected, show its DB-fetched detail (commands/logs).
    // runDetail is always fetched from DB — even for live runs (shows history
    // before the page loaded, then new events are appended in real-time).
    // When nothing is selected, show the live ring-buffer.
    filteredLogs: (s) => {
      if (!s.selectedRun) return s.logs
      return s.runDetail ? s.runDetail.logs : []
    },

    filteredCommands: (s) => {
      if (!s.selectedRun) return s.commands
      return s.runDetail ? s.runDetail.commands : []
    },
  },

  actions: {
    async init() {
      socket.on('connect', () => (this.connected = true))
      socket.on('disconnect', () => (this.connected = false))

      socket.on('init', ({ workers }) => {
        this.workers = workers
      })

      // Load persisted run history from the database on page load
      try {
        const res = await fetch('/api/runs?limit=100')
        if (res.ok) {
          const rows = await res.json()
          this.runs = rows.map((r) => ({
            id: r.run_id,
            scenarioName: r.scenario || r.worker_id.slice(-8),
            workerId: r.worker_id,
            status: r.status === 'completed' ? 'passed' : r.status,
            startTime: new Date(r.started_at).getTime(),
            endTime: r.finished_at ? new Date(r.finished_at).getTime() : null,
            hasError: r.status === 'failed',
          }))
        }
      } catch (e) {
        console.warn('[store] could not load run history:', e)
      }

      socket.on('workers:update', (updatedWorkers) => {
        const byId = Object.fromEntries(this.workers.map((w) => [w.id, w]))
        this.workers.splice(
          0,
          this.workers.length,
          ...updatedWorkers.map((w) => {
            const mem = byId[w.id]
            if (!mem) return w
            return { ...w, status: mem.status }
          }),
        )
      })

      socket.on('worker:status', (worker) => {
        // Only update the workers list — never create run entries here
        const idx = this.workers.findIndex((w) => w.id === worker.id)
        if (idx >= 0) this.workers.splice(idx, 1, worker)
        else this.workers.push(worker)

        // Mark the active run as finished when the worker goes idle
        if (worker.status === 'idle') {
          delete this.pendingErrors[worker.id]
          const run = this.runs.find(
            (r) => r.workerId === worker.id && r.status === 'running',
          )
          if (run) {
            run.status = run.hasError ? 'failed' : 'passed'
            run.endTime = worker.lastHeartbeat
          }
        }
      })

      // Single source of truth: run entries are ONLY created here, with the real DB UUID.
      // The backend guard ensures startRun returns the same UUID for a live worker,
      // so this event fires at most once per unique run UUID.
      socket.on('run:started', ({ runId, workerId, scenarioName, startTime }) => {
        // UUID already in list (loaded from DB on page refresh) — nothing to do
        if (this.runs.some((r) => r.id === runId)) return

        const hasError = !!this.pendingErrors[workerId]
        delete this.pendingErrors[workerId]

        this.runs.unshift({
          id: runId,
          scenarioName: scenarioName || workerId.slice(-8),
          workerId,
          status: 'running',
          startTime: startTime || Date.now(),
          endTime: null,
          hasError,
        })
        if (this.runs.length > MAX_RUNS) this.runs.splice(MAX_RUNS)
      })

      socket.on('queue:length', (count) => {
        this.waitingCount = count
      })

      socket.on('worker:log', ({ workerId, message, timestamp }) => {
        // Always push to live ring-buffer (used when no run selected)
        this.logs.push({ workerId, message, timestamp })
        if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS)

        // If the selected run belongs to this worker, append to runDetail in real-time
        if (this.runDetail && this.selectedRun) {
          const run = this.runs.find((r) => r.id === this.selectedRun)
          if (run && run.workerId === workerId) {
            this.runDetail.logs.push({ workerId, message, timestamp })
          }
        }
      })

      socket.on('worker:command', ({ workerId, method, label, param, error, timestamp }) => {
        const entry = { workerId, method, label, param, error, timestamp }

        // Always push to live ring-buffer
        this.commands.push(entry)
        if (this.commands.length > MAX_COMMANDS)
          this.commands.splice(0, this.commands.length - MAX_COMMANDS)

        // Mark run as failed if a command errors
        if (error) {
          const run = this.runs.find(
            (r) => r.workerId === workerId && r.status === 'running',
          )
          if (run) {
            run.hasError = true
          } else {
            // run:started hasn't arrived yet — stash until the run is registered
            this.pendingErrors[workerId] = true
          }
        }

        // If the selected run belongs to this worker, append to runDetail in real-time
        if (this.runDetail && this.selectedRun) {
          const run = this.runs.find((r) => r.id === this.selectedRun)
          if (run && run.workerId === workerId) {
            this.runDetail.commands.push(entry)
          }
        }
      })
    },

    async selectRun(runId) {
      if (runId === null) {
        this.selectedRun = null
        this.runDetail = null
        return
      }
      const newId = runId === this.selectedRun ? null : runId
      this.selectedRun = newId
      this.runDetail = null
      if (!newId) return

      // Always fetch from DB — gives full history even for live runs after a refresh
      try {
        const res = await fetch(`/api/runs/${newId}`)
        if (res.ok) {
          const data = await res.json()
          this.runDetail = {
            commands: (data.commands || []).map((c) => ({ ...c, workerId: data.worker_id, timestamp: Number(c.timestamp) })),
            logs: (data.logs || []).map((l) => ({ ...l, workerId: data.worker_id, timestamp: Number(l.timestamp) })),
          }
        }
      } catch (e) {
        console.warn('[store] could not load run detail:', e)
        this.runDetail = { commands: [], logs: [] }
      }
    },
  },
})
