<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { useStore } from './store.js'
import LogViewer from './components/LogViewer.vue'

const store = useStore()
onMounted(() => store.init())

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
</script>

<template>
  <div class="min-h-screen bg-slate-900 text-slate-100 flex flex-col">

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
            </div>
          </div>
        </div>
      </div>
    </header>

    <!-- Body -->
    <div class="flex flex-1 overflow-hidden">

      <!-- Collapsable sidebar -->
      <aside
        class="shrink-0 border-r border-slate-700 flex flex-col overflow-hidden transition-all duration-300"
        :class="sidebarOpen ? 'w-72' : 'w-0 border-r-0'"
      >
        <div class="w-72 flex-1 flex flex-col overflow-y-auto">
          <!-- Empty — ready for new content -->
        </div>
      </aside>

      <!-- Main content -->
      <main class="flex-1 flex flex-col overflow-hidden">
        <LogViewer />
      </main>
    </div>

  </div>
</template>
