<script setup>
import { onMounted, onUnmounted, ref, computed } from 'vue'
import { useStore } from './store.js'
import LogViewer from './components/LogViewer.vue'

const store = useStore()
onMounted(() => store.init())

// ── Live duration timer ───────────────────────────────────────────────────────
const now = ref(Date.now())
const timer = setInterval(() => { now.value = Date.now() }, 1000)
onUnmounted(() => clearInterval(timer))

function fmtDuration(run) {
  const ms = (run.endTime || now.value) - run.startTime
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleTimeString()
}

// ── Parallels dropdown ───────────────────────────────────────────────────────
const dropdownOpen = ref(false)
const dropdownRef = ref(null)

function toggleDropdown() { dropdownOpen.value = !dropdownOpen.value }

function handleOutsideClick(e) {
  if (dropdownRef.value && !dropdownRef.value.contains(e.target)) {
    dropdownOpen.value = false
  }
}

onMounted(() => document.addEventListener('mousedown', handleOutsideClick))
onUnmounted(() => document.removeEventListener('mousedown', handleOutsideClick))

const usagePct = () =>
  store.workers.length ? (store.busyWorkers / store.workers.length) * 100 : 0

// ── Sidebar ──────────────────────────────────────────────────────────────────
const sidebarOpen = ref(true)

// ── Selected run detail ──────────────────────────────────────────────────────
const selectedRunObj = computed(() => store.runs.find(r => r.id === store.selectedRun))
</script>

<template>
  <div class="h-screen bg-slate-900 text-slate-100 flex flex-col overflow-hidden">

    <!-- Header -->
    <header class="bg-slate-800 border-b border-slate-700 px-4 py-3 flex items-center justify-between shrink-0">
      <div class="flex items-center gap-3">
        <!-- Sidebar toggle -->
        <button
          @click="sidebarOpen = !sidebarOpen"
          class="p-1.5 rounded hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors"
          :title="sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M4 6h16M4 12h16M4 18h16"/>
          </svg>
        </button>

        <span
          class="w-2.5 h-2.5 rounded-full"
          :class="store.connected ? 'bg-green-500' : 'bg-red-500 animate-pulse'"
        ></span>
        <h1 class="text-lg font-bold tracking-tight">Playwright Cluster</h1>
      </div>

      <!-- Parallels Available dropdown -->
      <div ref="dropdownRef" class="relative">
        <button
          @click="toggleDropdown"
          class="flex items-center gap-2.5 bg-slate-700 hover:bg-slate-600 border border-slate-600 rounded-full px-4 py-1.5 text-sm transition-colors select-none"
        >
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

          <svg
            class="w-3.5 h-3.5 text-slate-500 transition-transform duration-200"
            :class="dropdownOpen ? 'rotate-180' : ''"
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
          </svg>
        </button>

        <!-- Dropdown panel -->
        <div
          v-if="dropdownOpen"
          class="absolute right-0 mt-2 w-72 bg-slate-800 border border-slate-700 rounded-lg shadow-2xl z-50 overflow-hidden"
        >
          <div class="px-4 py-2.5 border-b border-slate-700">
            <span class="text-xs font-semibold uppercase tracking-wider text-slate-400">Usage Breakdown</span>
          </div>
          <div class="px-4 py-3">
            <div class="flex items-center justify-between mb-2">
              <span class="text-sm text-slate-200 font-medium">Playwright Workers</span>
              <span class="text-sm font-mono text-slate-400">{{ store.busyWorkers }}/{{ store.workers.length }}</span>
            </div>
            <div class="h-1.5 bg-slate-700 rounded-full overflow-hidden mb-3">
              <div
                class="h-full rounded-full transition-all duration-500"
                :class="usagePct() > 80 ? 'bg-red-500' : usagePct() > 50 ? 'bg-yellow-500' : 'bg-blue-500'"
                :style="{ width: usagePct() + '%' }"
              ></div>
            </div>
            <div class="flex flex-col gap-1.5">
              <div class="flex items-center justify-between text-sm">
                <div class="flex items-center gap-2">
                  <span class="w-2.5 h-2.5 rounded-sm bg-blue-500 shrink-0"></span>
                  <span class="text-slate-400">Running</span>
                </div>
                <span class="font-mono font-semibold text-slate-200">{{ store.busyWorkers }}</span>
              </div>
              <div class="flex items-center justify-between text-sm">
                <div class="flex items-center gap-2">
                  <span class="w-2.5 h-2.5 rounded-sm border border-slate-500 shrink-0"></span>
                  <span class="text-slate-400">Available</span>
                </div>
                <span class="font-mono font-semibold text-green-400">{{ store.idleWorkers }}</span>
              </div>
              <div class="flex items-center justify-between text-sm">
                <div class="flex items-center gap-2">
                  <span class="w-2.5 h-2.5 rounded-sm bg-yellow-500/40 border border-yellow-600 shrink-0"></span>
                  <span class="text-slate-400">In Queue</span>
                </div>
                <span class="font-mono font-semibold text-yellow-400">{{ store.waitingCount }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>

    <!-- Selected run detail bar (like LambdaTest top metadata) -->
    <div v-if="selectedRunObj" class="bg-slate-800/60 border-b border-slate-700 px-5 py-2.5 shrink-0">
      <div class="flex items-center gap-3 mb-1.5">
        <!-- Status badge -->
        <span
          :class="[
            'text-xs font-bold uppercase px-2.5 py-0.5 rounded',
            selectedRunObj.status === 'running' ? 'bg-yellow-500/20 text-yellow-300 border border-yellow-600' :
            selectedRunObj.status === 'passed' ? 'bg-green-500/20 text-green-300 border border-green-600' :
            'bg-red-500/20 text-red-300 border border-red-600',
          ]"
        >{{ selectedRunObj.status === 'running' ? 'Running' : selectedRunObj.status === 'passed' ? 'Passed' : 'Failed' }}</span>
        <!-- Test name -->
        <h2 class="text-sm font-semibold text-slate-100">{{ selectedRunObj.scenarioName }}</h2>
      </div>
      <div class="flex items-center gap-5 text-xs text-slate-400">
        <span class="flex items-center gap-1.5">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          <span class="text-slate-300 font-medium">{{ fmtDuration(selectedRunObj) }}</span>
        </span>
        <span class="flex items-center gap-1.5">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
          1920x1080
        </span>
        <span>Worker: <span class="text-slate-300 font-mono">{{ selectedRunObj.workerId?.slice(-6) }}</span></span>
        <span v-if="selectedRunObj.startTime">Started: {{ fmtTime(selectedRunObj.startTime) }}</span>
      </div>
    </div>

    <!-- Body -->
    <div class="flex flex-1 overflow-hidden">

      <!-- Collapsable sidebar -->
      <aside
        class="shrink-0 border-r border-slate-700 flex flex-col overflow-hidden transition-all duration-300"
        :class="sidebarOpen ? 'w-72' : 'w-0 border-r-0'"
      >
        <div class="w-72 flex-1 flex flex-col min-h-0">

          <!-- Sidebar header -->
          <div class="px-4 py-3 border-b border-slate-700 shrink-0 flex items-center justify-between">
            <span class="text-xs font-semibold uppercase tracking-wider text-slate-400">Tests</span>
            <div class="flex items-center gap-2">
              <span
                v-if="store.waitingCount"
                class="flex items-center gap-1 text-xs bg-yellow-900/60 text-yellow-300 px-2 py-0.5 rounded-full font-mono"
              >
                <span class="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse"></span>
                {{ store.waitingCount }} queued
              </span>
              <span class="text-xs font-mono text-slate-600">{{ store.runs.length }}</span>
            </div>
          </div>

          <!-- Scrollable run list -->
          <div class="flex-1 overflow-y-auto min-h-0">
            <button
              v-for="run in store.runs"
              :key="run.id"
              @click="store.selectRun(run.id)"
              :class="[
                'flex items-start gap-3 px-4 py-3 border-b border-slate-800 text-left transition-colors w-full',
                store.selectedRun === run.id
                  ? 'bg-slate-700'
                  : 'hover:bg-slate-800',
                run.status === 'failed' ? 'border-l-2 border-l-red-600' : '',
                run.status === 'passed' ? 'border-l-2 border-l-green-600' : '',
                run.status === 'running' ? 'border-l-2 border-l-yellow-500' : '',
              ]"
            >
              <!-- Status icon -->
              <span class="shrink-0 w-4 flex justify-center pt-0.5">
                <span v-if="run.status === 'running'" class="w-2 h-2 rounded-full bg-yellow-400 animate-pulse mt-1 block"></span>
                <span v-else-if="run.status === 'passed'" class="text-green-400 text-sm leading-none">&#x2713;</span>
                <span v-else class="text-red-400 text-sm leading-none">&#x2715;</span>
              </span>

              <!-- Scenario name + duration -->
              <span class="flex flex-col flex-1 min-w-0">
                <span class="text-sm text-slate-200 leading-snug break-words">{{ run.scenarioName }}</span>
                <span class="text-xs text-slate-500 mt-0.5 font-mono">{{ fmtDuration(run) }}</span>
              </span>
            </button>

            <!-- Empty state -->
            <div v-if="!store.runs.length" class="px-4 py-6 text-xs text-slate-600 italic">
              No tests run yet. Start a scenario to see it here.
            </div>
          </div>

        </div>
      </aside>

      <!-- Main content -->
      <main class="flex-1 flex flex-col overflow-hidden">
        <LogViewer />
      </main>
    </div>

  </div>
</template>
