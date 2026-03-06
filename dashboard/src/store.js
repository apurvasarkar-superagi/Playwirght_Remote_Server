import { defineStore } from 'pinia'
import { socket } from './socket.js'

const MAX_LOGS = 500

export const useStore = defineStore('main', {
  state: () => ({
    connected: false,
    workers: [],
    logs: [], // [{ workerId, message, timestamp }]
    filterWorker: null, // null = show all
  }),

  getters: {
    busyWorkers: (s) => s.workers.filter((w) => w.status === 'busy').length,
    idleWorkers: (s) => s.workers.filter((w) => w.status !== 'busy').length,
    filteredLogs: (s) =>
      s.filterWorker ? s.logs.filter((l) => l.workerId === s.filterWorker) : s.logs,
  },

  actions: {
    init() {
      socket.on('connect', () => (this.connected = true))
      socket.on('disconnect', () => (this.connected = false))

      socket.on('init', ({ workers }) => {
        this.workers = workers
      })

      // workers:update only syncs the worker list (add/remove dead workers).
      // It does NOT override status — worker:status handles that immediately.
      socket.on('workers:update', (updatedWorkers) => {
        const byId = Object.fromEntries(this.workers.map((w) => [w.id, w]))
        this.workers.splice(
          0,
          this.workers.length,
          ...updatedWorkers.map((w) => byId[w.id] ?? w)
        )
      })

      // Immediate status update — single source of truth for busy/idle
      socket.on('worker:status', (worker) => {
        const idx = this.workers.findIndex((w) => w.id === worker.id)
        if (idx >= 0) this.workers.splice(idx, 1, worker)
        else this.workers.push(worker)
      })

      socket.on('worker:log', ({ workerId, message, timestamp }) => {
        this.logs.push({ workerId, message, timestamp })
        // Keep only the latest MAX_LOGS lines
        if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS)
      })
    },

    setFilter(workerId) {
      this.filterWorker = workerId === this.filterWorker ? null : workerId
    },
  },
})
