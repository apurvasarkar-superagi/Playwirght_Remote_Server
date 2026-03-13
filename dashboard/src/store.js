import { defineStore } from 'pinia'
import { socket } from './socket.js'

const MAX_LOGS = 500
const MAX_COMMANDS = 500
const MAX_RUNS = 100
const MAX_SCREENSHOTS = 200

export const useStore = defineStore('main', {
  state: () => ({
    connected: false,
    initialized: false,
    workers: [],
    logs: [],      // live ring-buffer [{ workerId, message, timestamp }]
    commands: [],  // live ring-buffer [{ workerId, method, label, param, error, timestamp }]
    runs: [],      // [{ id (UUID), scenarioName, buildName, workerId, status, startTime, endTime, hasError }]
    selectedRun: null,  // UUID of the selected run, null = show all live
    runDetail: null,    // { commands[], logs[] } fetched from DB for the selected run
    activeBuild: null,  // build_name filter — when set, sidebar only shows runs from this build
    waitingCount: 0,
    screenshots: [],  // live ring-buffer [{ workerId, filename, command, param, error, timestamp }]
    // workerId → true: error arrived before run:started — applied when run is registered
    pendingErrors: {},
  }),

  getters: {
    busyWorkers: (s) => s.workers.filter((w) => w.status === 'busy').length,
    idleWorkers: (s) => s.workers.filter((w) => w.status !== 'busy').length,
    activeRuns:  (s) => s.runs.filter((r) => r.status === 'running').length,

    // Sidebar runs — filtered by activeBuild when set
    sidebarRuns: (s) => {
      if (!s.activeBuild) return s.runs
      return s.runs.filter((r) => r.buildName === s.activeBuild)
    },

    // When a run is selected, show its DB-fetched detail (commands/logs).
    // runDetail is always fetched from DB — even for live runs (shows history
    // before the page loaded, then new events are appended in real-time).
    // Only show data for the selected run — don't mix all workers together
    filteredLogs: (s) => {
      if (!s.selectedRun) return []
      return s.runDetail ? s.runDetail.logs : []
    },

    filteredCommands: (s) => {
      if (!s.selectedRun) return []
      return s.runDetail ? s.runDetail.commands : []
    },

    filteredScreenshots: (s) => {
      if (!s.selectedRun) return []
      return s.runDetail ? (s.runDetail.screenshots || []) : []
    },

    // Get the stream URL for the selected run's worker (only if running)
    activeStreamUrl: (s) => {
      if (!s.selectedRun) return null
      const run = s.runs.find((r) => r.id === s.selectedRun)
      if (!run || run.status !== 'running') return null
      const worker = s.workers.find((w) => w.id === run.workerId)
      return worker?.streamUrl || null
    },

    // Get stream URLs for all busy workers (used when no run is selected)
    busyWorkerStreams: (s) => {
      return s.workers
        .filter((w) => w.status === 'busy' && w.streamUrl)
        .map((w) => ({ workerId: w.id, streamUrl: w.streamUrl, scenarioName: w.scenarioName }))
    },

    // Get the video URL for the selected run (from DB detail or run list)
    selectedVideoUrl: (s) => {
      if (!s.selectedRun) return null
      // Prefer runDetail (freshly fetched from DB)
      if (s.runDetail?.videoUrl) return s.runDetail.videoUrl
      // Fall back to the run list entry
      const run = s.runs.find((r) => r.id === s.selectedRun)
      return run?.videoUrl || null
    },
  },

  actions: {
    async init() {
      if (this.initialized) return
      this.initialized = true

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
            buildName: r.build_name || null,
            workerId: r.worker_id,
            status: r.status === 'completed' ? 'passed' : r.status,
            startTime: new Date(r.started_at).getTime(),
            endTime: r.finished_at ? new Date(r.finished_at).getTime() : null,
            hasError: r.status === 'failed',
            videoUrl: r.video_filename ? `/videos/${r.video_filename}` : null,
            commandCount: r.command_count || 0,
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
      socket.on('run:started', ({ runId, workerId, scenarioName, buildName, startTime }) => {
        // UUID already in list (loaded from DB on page refresh) — nothing to do
        if (this.runs.some((r) => r.id === runId)) return

        const hasError = !!this.pendingErrors[workerId]
        delete this.pendingErrors[workerId]

        this.runs.unshift({
          id: runId,
          scenarioName: scenarioName || workerId.slice(-8),
          buildName: buildName || null,
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

      socket.on('screenshot:captured', (data) => {
        this.screenshots.push(data)
        if (this.screenshots.length > MAX_SCREENSHOTS)
          this.screenshots.splice(0, this.screenshots.length - MAX_SCREENSHOTS)

        // Append to selected run detail in real-time
        if (this.runDetail && this.selectedRun) {
          const run = this.runs.find((r) => r.id === this.selectedRun)
          if (run && run.workerId === data.workerId) {
            if (!this.runDetail.screenshots) this.runDetail.screenshots = []
            this.runDetail.screenshots.push(data)
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

    async loadBuildRuns(buildName) {
      this.activeBuild = buildName || null
      if (!buildName) return
      try {
        const res = await fetch(`/api/builds/${encodeURIComponent(buildName)}/runs`)
        if (res.ok) {
          const rows = await res.json()
          // Merge build runs into store.runs (avoid duplicates)
          const existingIds = new Set(this.runs.map((r) => r.id))
          const newRuns = rows
            .filter((r) => !existingIds.has(r.run_id))
            .map((r) => ({
              id: r.run_id,
              scenarioName: r.scenario || r.worker_id.slice(-8),
              buildName: r.build_name || null,
              workerId: r.worker_id,
              status: r.status === 'completed' ? 'passed' : r.status,
              startTime: new Date(r.started_at).getTime(),
              endTime: r.finished_at ? new Date(r.finished_at).getTime() : null,
              hasError: r.status === 'failed',
              videoUrl: r.video_filename ? `/videos/${r.video_filename}` : null,
              commandCount: r.command_count || 0,
            }))
          if (newRuns.length) this.runs.unshift(...newRuns)
        }
      } catch (e) {
        console.warn('[store] could not load build runs:', e)
      }
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
            screenshots: (data.screenshots || []).map((s) => ({ ...s, workerId: data.worker_id, timestamp: Number(s.timestamp) })),
            videoUrl: data.video_filename ? `/videos/${data.video_filename}` : null,
          }
          // Also update the run entry in the list so the sidebar knows about the video
          const run = this.runs.find((r) => r.id === newId)
          if (run && data.video_filename) {
            run.videoUrl = `/videos/${data.video_filename}`
          }
        }
      } catch (e) {
        console.warn('[store] could not load run detail:', e)
        this.runDetail = { commands: [], logs: [] }
      }
    },
  },
})
