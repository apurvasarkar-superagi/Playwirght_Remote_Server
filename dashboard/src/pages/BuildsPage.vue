<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useStore } from '../store.js'

const router = useRouter()
const store = useStore()
const searchQuery = ref('')

onMounted(() => {
  store.init()
})

// Live timer so durations tick for running builds
const now = ref(Date.now())
const timer = setInterval(() => { now.value = Date.now() }, 1000)
onUnmounted(() => clearInterval(timer))

// Derive builds directly from store.runs (reactive, no re-fetch needed)
const buildsList = computed(() => {
  const byBuild = {}
  const singles = []

  for (const r of store.runs) {
    if (r.buildName) {
      if (!byBuild[r.buildName]) {
        byBuild[r.buildName] = {
          type: 'build',
          build_name: r.buildName,
          runs: [],
        }
      }
      byBuild[r.buildName].runs.push(r)
    } else {
      singles.push({
        type: 'run',
        run_id: r.id,
        build_name: r.scenarioName || null,
        run_count: 1,
        command_count: r.commandCount || 0,
        started_at: r.startTime,
        finished_at: r.endTime,
        status: r.status === 'passed' ? 'completed' : r.status,
        passed_count: r.status === 'passed' ? 1 : 0,
        failed_count: r.status === 'failed' ? 1 : 0,
        running_count: r.status === 'running' ? 1 : 0,
      })
    }
  }

  const builds = Object.values(byBuild).map((g) => {
    const runs = g.runs
    return {
      type: 'build',
      build_name: g.build_name,
      run_count: runs.length,
      command_count: runs.reduce((sum, r) => sum + (r.commandCount || 0), 0),
      started_at: Math.min(...runs.map((r) => r.startTime)),
      finished_at: runs.every((r) => r.endTime) ? Math.max(...runs.map((r) => r.endTime)) : null,
      status: runs.some((r) => r.status === 'running') ? 'running'
        : runs.some((r) => r.status === 'failed') ? 'failed' : 'completed',
      passed_count: runs.filter((r) => r.status === 'passed').length,
      failed_count: runs.filter((r) => r.status === 'failed').length,
      running_count: runs.filter((r) => r.status === 'running').length,
    }
  })

  return [...builds, ...singles].sort((a, b) => b.started_at - a.started_at)
})

// Group builds by date label (Today, Yesterday, or formatted date)
const groupedBuilds = computed(() => {
  const todayDate = new Date()
  const today = new Date(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate())
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)

  const filtered = searchQuery.value
    ? buildsList.value.filter(b => {
        const q = searchQuery.value.toLowerCase()
        const name = (b.build_name || '').toLowerCase()
        return name.includes(q)
      })
    : buildsList.value

  const groups = {}
  for (const build of filtered) {
    const d = new Date(build.started_at)
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate())
    let label
    if (day.getTime() === today.getTime()) label = 'Today'
    else if (day.getTime() === yesterday.getTime()) label = 'Yesterday'
    else label = day.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })

    if (!groups[label]) groups[label] = { label, sortKey: day.getTime(), builds: [] }
    groups[label].builds.push(build)
  }

  return Object.values(groups).sort((a, b) => b.sortKey - a.sortKey)
})

function displayName(b) {
  return b.build_name || (b.run_id ? `Run ${b.run_id.slice(0, 8)}` : 'Untitled')
}

function statusIcon(b) {
  if (b.status === 'running') return 'running'
  if (b.status === 'failed') return 'failed'
  if (b.status === 'completed') return 'passed'
  return b.status
}

function fmtDuration(b) {
  if (!b.started_at) return '--'
  const start = typeof b.started_at === 'number' ? b.started_at : new Date(b.started_at).getTime()
  const end = b.finished_at
    ? (typeof b.finished_at === 'number' ? b.finished_at : new Date(b.finished_at).getTime())
    : now.value
  const s = Math.floor((end - start) / 1000)
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

function fmtTimeAgo(b) {
  if (!b.started_at) return ''
  const start = typeof b.started_at === 'number' ? b.started_at : new Date(b.started_at).getTime()
  const ms = now.value - start
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins} minute${mins > 1 ? 's' : ''} ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} hour${hrs > 1 ? 's' : ''} ago`
  const days = Math.floor(hrs / 24)
  return `${days} day${days > 1 ? 's' : ''} ago`
}

function openBuild(b) {
  if (b.type === 'build') {
    router.push({ name: 'dashboard', query: { build: b.build_name } })
  } else {
    store.selectRun(b.run_id)
    router.push({ name: 'dashboard-run', params: { runId: b.run_id } })
  }
}
</script>

<template>
  <div class="h-screen bg-slate-900 text-slate-100 flex flex-col overflow-hidden">

    <!-- Header -->
    <header class="bg-slate-800 border-b border-slate-700 px-6 py-3 flex items-center justify-between shrink-0">
      <div class="flex items-center gap-3">
        <span
          class="w-2.5 h-2.5 rounded-full"
          :class="store.connected ? 'bg-green-500' : 'bg-red-500 animate-pulse'"
        ></span>
        <h1 class="text-lg font-bold tracking-tight">Automation</h1>
      </div>

      <!-- Parallels pill -->
      <div class="flex items-center gap-2.5 bg-slate-700 border border-slate-600 rounded-full px-4 py-1.5 text-sm">
        <span class="text-slate-400">Parallels Available</span>
        <span class="flex items-center gap-1">
          <svg class="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18"/>
          </svg>
          <strong class="text-slate-100 font-mono">{{ store.idleWorkers }}</strong>
        </span>
        <span v-if="store.busyWorkers" class="flex items-center gap-1">
          <span class="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse"></span>
          <strong class="text-yellow-300 font-mono">{{ store.busyWorkers }}</strong>
        </span>
      </div>
    </header>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto px-6 py-5">

      <!-- Page title + search -->
      <div class="flex items-center justify-between mb-5">
        <div class="flex items-center gap-2">
          <svg class="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/>
          </svg>
          <h2 class="text-xl font-semibold">Builds</h2>
        </div>
        <div class="relative">
          <svg class="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
          </svg>
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Search Builds by Build Name"
            class="bg-slate-800 border border-slate-700 rounded-lg pl-10 pr-4 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-slate-500 w-80"
          />
        </div>
      </div>

      <!-- Empty state -->
      <div v-if="!groupedBuilds.length" class="text-center py-20 text-slate-500">
        <p class="text-lg">No builds found</p>
        <p class="text-sm mt-1">Run a test with <code class="text-slate-400">--build_id=MyBuild</code> to see it here.</p>
      </div>

      <!-- Date groups -->
      <div v-else v-for="group in groupedBuilds" :key="group.label" class="mb-6">
        <!-- Date header -->
        <div class="flex items-center gap-3 mb-3">
          <div class="w-2 h-2 rounded-full bg-slate-600"></div>
          <h3 class="text-sm font-semibold text-slate-400 uppercase tracking-wider">{{ group.label }}</h3>
        </div>

        <!-- Build cards -->
        <div class="space-y-2">
          <button
            v-for="(b, i) in group.builds"
            :key="b.build_name || b.run_id || i"
            @click="openBuild(b)"
            class="w-full bg-slate-800 hover:bg-slate-750 border border-slate-700 hover:border-slate-600 rounded-lg px-5 py-4 flex items-center gap-4 transition-colors text-left group"
          >
            <!-- Status icon -->
            <span class="shrink-0">
              <span v-if="statusIcon(b) === 'running'" class="flex items-center justify-center w-6 h-6">
                <span class="w-3 h-3 rounded-full bg-yellow-400 animate-pulse"></span>
              </span>
              <span v-else-if="statusIcon(b) === 'passed'" class="flex items-center justify-center w-6 h-6 rounded-full bg-green-500/20">
                <svg class="w-3.5 h-3.5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/>
                </svg>
              </span>
              <span v-else class="flex items-center justify-center w-6 h-6 rounded-full bg-red-500/20">
                <svg class="w-3.5 h-3.5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </span>
            </span>

            <!-- Build info -->
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium text-slate-100 group-hover:text-white truncate">
                {{ displayName(b) }}
              </div>
              <div class="flex items-center gap-4 mt-1 text-xs text-slate-500">
                <!-- Run count (for grouped builds) -->
                <span v-if="b.run_count > 1" class="flex items-center gap-1">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16"/>
                  </svg>
                  {{ b.run_count }} runs
                </span>
                <!-- Command count -->
                <span class="flex items-center gap-1">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                  </svg>
                  {{ b.command_count }}
                </span>
                <!-- Duration -->
                <span class="flex items-center gap-1">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
                  </svg>
                  {{ fmtDuration(b) }}
                </span>
                <!-- Time ago -->
                <span>{{ fmtTimeAgo(b) }}</span>
              </div>
            </div>

            <!-- Status bar (mini progress) -->
            <div class="shrink-0 w-36 flex items-center gap-2">
              <div class="flex-1 h-2 bg-slate-700 rounded-full overflow-hidden flex">
                <div
                  v-if="b.passed_count"
                  class="h-full bg-green-500"
                  :style="{ width: (b.passed_count / b.run_count * 100) + '%' }"
                ></div>
                <div
                  v-if="b.failed_count"
                  class="h-full bg-red-500"
                  :style="{ width: (b.failed_count / b.run_count * 100) + '%' }"
                ></div>
                <div
                  v-if="b.running_count"
                  class="h-full bg-yellow-500 animate-pulse"
                  :style="{ width: (b.running_count / b.run_count * 100) + '%' }"
                ></div>
              </div>
            </div>

            <!-- Three-dot menu placeholder -->
            <span class="shrink-0 text-slate-600 group-hover:text-slate-400">
              <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <circle cx="12" cy="5" r="1.5"/>
                <circle cx="12" cy="12" r="1.5"/>
                <circle cx="12" cy="19" r="1.5"/>
              </svg>
            </span>
          </button>
        </div>
      </div>

    </div>
  </div>
</template>
