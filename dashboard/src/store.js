import { defineStore } from 'pinia'
import { socket } from './socket.js'

const MAX_LOGS = 500
const MAX_COMMANDS = 500
const MAX_RUNS = 100

export const useStore = defineStore('main', {
  state: () => ({
    connected: false,
    workers: [],
    logs: [],     // [{ workerId, message, timestamp }]
    commands: [], // [{ workerId, method, label, param, error, timestamp }]
    runs: [],     // [{ id, scenarioName, workerId, status, startTime, endTime, hasError }]
    selectedRun: null, // run id, null = show all
    waitingCount: 0,   // tests waiting for a free worker (real queue)
  }),

  getters: {
    busyWorkers: (s) => s.workers.filter((w) => w.status === 'busy').length,
    idleWorkers: (s) => s.workers.filter((w) => w.status !== 'busy').length,
    activeRuns: (s) => s.runs.filter((r) => r.status === 'running').length,

    filteredLogs: (s) => {
      if (!s.selectedRun) return s.logs
      const run = s.runs.find((r) => r.id === s.selectedRun)
      if (!run) return s.logs
      return s.logs.filter(
        (l) =>
          l.workerId === run.workerId &&
          l.timestamp >= run.startTime &&
          (!run.endTime || l.timestamp <= run.endTime),
      )
    },

    filteredCommands: (s) => {
      if (!s.selectedRun) return s.commands
      const run = s.runs.find((r) => r.id === s.selectedRun)
      if (!run) return s.commands
      return s.commands.filter(
        (c) =>
          c.workerId === run.workerId &&
          c.timestamp >= run.startTime &&
          (!run.endTime || c.timestamp <= run.endTime),
      )
    },
  },

  actions: {
    init() {
      socket.on('connect', () => (this.connected = true))
      socket.on('disconnect', () => (this.connected = false))

      socket.on('init', ({ workers }) => {
        this.workers = workers
      })

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
        const idx = this.workers.findIndex((w) => w.id === worker.id)
        if (idx >= 0) this.workers.splice(idx, 1, worker)
        else this.workers.push(worker)

        if (worker.status === 'busy') {
          // If this worker already has a running entry (duplicate busy event),
          // just update the scenario name if it now has one
          const existing = this.runs.find(
            (r) => r.workerId === worker.id && r.status === 'running',
          )
          if (existing) {
            if (worker.scenarioName) existing.scenarioName = worker.scenarioName
          } else {
            this.runs.unshift({
              id: `${worker.id}-${worker.lastHeartbeat}`,
              scenarioName: worker.scenarioName || worker.id.slice(-8),
              workerId: worker.id,
              status: 'running',
              startTime: worker.lastHeartbeat,
              endTime: null,
              hasError: false,
            })
            if (this.runs.length > MAX_RUNS) this.runs.splice(MAX_RUNS)
          }
        } else if (worker.status === 'idle') {
          const run = this.runs.find(
            (r) => r.workerId === worker.id && r.status === 'running',
          )
          if (run) {
            run.status = run.hasError ? 'failed' : 'passed'
            run.endTime = worker.lastHeartbeat
          }
        }
      })

      socket.on('queue:length', (count) => {
        this.waitingCount = count
      })

      socket.on('worker:log', ({ workerId, message, timestamp }) => {
        this.logs.push({ workerId, message, timestamp })
        if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS)
      })

      socket.on('worker:command', ({ workerId, method, label, param, error, timestamp }) => {
        this.commands.push({ workerId, method, label, param, error, timestamp })
        if (this.commands.length > MAX_COMMANDS)
          this.commands.splice(0, this.commands.length - MAX_COMMANDS)

        // Mark current run as failed if any command has an error
        if (error) {
          const run = this.runs.find(
            (r) => r.workerId === workerId && r.status === 'running',
          )
          if (run) run.hasError = true
        }
      })
    },

    selectRun(runId) {
      if (runId === null) {
        this.selectedRun = null
      } else {
        this.selectedRun = runId === this.selectedRun ? null : runId
      }
    },
  },
})
