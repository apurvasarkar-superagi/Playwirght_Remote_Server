<script setup>
import { watch, nextTick, ref, computed, onMounted, onUnmounted } from 'vue'
import { useStore } from '../store.js'
import WorkerStream from './WorkerStream.vue'

const store = useStore()
const activeTab = ref('commands') // 'commands' | 'logs'
const searchQuery = ref('')

// ── Resizable split panel ─────────────────────────────────────────────────────
const leftPanelWidth = ref(40) // percentage
const isDragging = ref(false)
const containerRef = ref(null)

function startDrag(e) {
  isDragging.value = true
  e.preventDefault()
}

function onDrag(e) {
  if (!isDragging.value || !containerRef.value) return
  const rect = containerRef.value.getBoundingClientRect()
  const pct = ((e.clientX - rect.left) / rect.width) * 100
  leftPanelWidth.value = Math.min(Math.max(pct, 20), 80)
}

function stopDrag() {
  isDragging.value = false
}

onMounted(() => {
  document.addEventListener('mousemove', onDrag)
  document.addEventListener('mouseup', stopDrag)
})
onUnmounted(() => {
  document.removeEventListener('mousemove', onDrag)
  document.removeEventListener('mouseup', stopDrag)
})

// ── Log scroll ────────────────────────────────────────────────────────────────
const logEl = ref(null)
const pinToBottom = ref(true)

watch(
  () => store.filteredLogs.length,
  async () => {
    if (activeTab.value !== 'logs' || !pinToBottom.value) return
    await nextTick()
    if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
  }
)

// ── Command scroll ────────────────────────────────────────────────────────────
const cmdEl = ref(null)
const pinCmdToBottom = ref(true)

watch(
  () => store.filteredCommands.length,
  async () => {
    if (activeTab.value !== 'commands' || !pinCmdToBottom.value) return
    await nextTick()
    if (cmdEl.value) cmdEl.value.scrollTop = cmdEl.value.scrollHeight
  }
)

function onScroll() {
  const el = logEl.value
  if (!el) return
  pinToBottom.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 20
}

function onCmdScroll() {
  const el = cmdEl.value
  if (!el) return
  pinCmdToBottom.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 20
}

function scrollCmdToTop() {
  if (cmdEl.value) cmdEl.value.scrollTop = 0
}

function scrollCmdToEnd() {
  if (cmdEl.value) cmdEl.value.scrollTop = cmdEl.value.scrollHeight
}

// ── Filtered commands with search ─────────────────────────────────────────────
const displayCommands = computed(() => {
  const cmds = store.filteredCommands
  if (!searchQuery.value) return cmds
  const q = searchQuery.value.toLowerCase()
  return cmds.filter(c =>
    c.label.toLowerCase().includes(q) ||
    (c.param && c.param.toLowerCase().includes(q)) ||
    (c.error && c.error.toLowerCase().includes(q))
  )
})

// ── Elapsed time from first command ───────────────────────────────────────────
const firstCmdTime = computed(() => {
  const cmds = store.filteredCommands
  return cmds.length ? cmds[0].timestamp : null
})

function elapsed(ts) {
  if (!firstCmdTime.value) return ''
  const ms = ts - firstCmdTime.value
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const ss = s % 60
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}:${String(Math.floor((ms % 1000) / 10)).padStart(2, '0')}`
}

// ── Formatting helpers ────────────────────────────────────────────────────────
const fmt = (ts) => {
  try {
    const d = new Date(Number(ts))
    if (isNaN(d.getTime())) return '--:--:--.---'
    return d.toISOString().slice(11, 23)
  } catch {
    return '--:--:--.---'
  }
}
const shortId = (id) => id.slice(-6)

const workerColor = (() => {
  const palette = ['text-blue-400', 'text-purple-400', 'text-cyan-400', 'text-orange-400', 'text-pink-400']
  const map = {}
  let i = 0
  return (id) => {
    if (!map[id]) map[id] = palette[i++ % palette.length]
    return map[id]
  }
})()

const workerBadgeColor = (() => {
  const palette = [
    'bg-blue-900 text-blue-300 border-blue-700',
    'bg-purple-900 text-purple-300 border-purple-700',
    'bg-cyan-900 text-cyan-300 border-cyan-700',
    'bg-orange-900 text-orange-300 border-orange-700',
    'bg-pink-900 text-pink-300 border-pink-700',
  ]
  const map = {}
  let i = 0
  return (id) => {
    if (!map[id]) map[id] = palette[i++ % palette.length]
    return map[id]
  }
})()

function cmdBadgeColor(label) {
  if (label.startsWith('Navigate') || label === 'Reload Page' || label === 'Navigate Back' || label === 'Navigate Forward')
    return 'bg-blue-900 text-blue-200'
  if (['Click', 'Double Click', 'Tap', 'Hover', 'Check', 'Uncheck', 'Select Option', 'Key Press'].includes(label))
    return 'bg-green-900 text-green-200'
  if (['Fill', 'Type'].includes(label))
    return 'bg-emerald-900 text-emerald-200'
  if (label.startsWith('Execute') || label.startsWith('Wait'))
    return 'bg-yellow-900 text-yellow-200'
  if (label === 'Screenshot' || label === 'Save as PDF')
    return 'bg-purple-900 text-purple-200'
  return 'bg-slate-700 text-slate-300'
}
</script>

<template>
  <div ref="containerRef" class="h-full flex overflow-hidden bg-slate-950" :class="{ 'select-none': isDragging }">

    <!-- Left panel: Commands / Logs -->
    <div class="h-full flex flex-col min-h-0 overflow-hidden" :style="{ width: leftPanelWidth + '%' }">

      <!-- Tabs row -->
      <div class="border-b border-slate-700 shrink-0">
        <div class="flex items-center">
          <button
            @click="activeTab = 'commands'"
            :class="[
              'px-4 py-2.5 text-sm font-medium border-b-2 transition-colors',
              activeTab === 'commands'
                ? 'border-blue-500 text-slate-100'
                : 'border-transparent text-slate-500 hover:text-slate-300',
            ]"
          >All Commands</button>
          <button
            @click="activeTab = 'logs'"
            :class="[
              'px-4 py-2.5 text-sm font-medium border-b-2 transition-colors',
              activeTab === 'logs'
                ? 'border-blue-500 text-slate-100'
                : 'border-transparent text-slate-500 hover:text-slate-300',
            ]"
          >Logs</button>
        </div>
      </div>

      <!-- Search bar (commands only) -->
      <div v-show="activeTab === 'commands'" class="px-3 py-2 border-b border-slate-800 shrink-0">
        <div class="flex items-center gap-2 bg-slate-800 rounded px-3 py-1.5">
          <svg class="w-3.5 h-3.5 text-slate-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
          </svg>
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Search Commands"
            class="bg-transparent text-sm text-slate-200 placeholder-slate-500 outline-none w-full"
          />
        </div>
      </div>

      <!-- Command count + scroll controls -->
      <div v-show="activeTab === 'commands'" class="px-4 py-2 border-b border-slate-800 flex items-center justify-between shrink-0">
        <span class="text-sm font-semibold text-slate-300">{{ displayCommands.length }} Commands</span>
        <div class="flex items-center gap-1">
          <span class="text-xs text-slate-500 mr-2">Scroll to:</span>
          <button @click="scrollCmdToEnd" class="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-slate-200" title="Scroll to bottom">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3"/></svg>
          </button>
          <button @click="scrollCmdToTop" class="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-slate-200" title="Scroll to top">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 10l7-7m0 0l7 7m-7-7v18"/></svg>
          </button>
        </div>
      </div>

      <!-- Live Logs view -->
      <div
        v-show="activeTab === 'logs'"
        ref="logEl"
        class="flex-1 overflow-y-auto p-3 font-mono text-xs leading-relaxed min-h-0"
        @scroll="onScroll"
      >
        <div
          v-for="(line, i) in store.filteredLogs"
          :key="i"
          class="flex gap-2 hover:bg-slate-900 px-1 rounded"
        >
          <span class="text-slate-600 shrink-0 select-none">{{ fmt(line.timestamp) }}</span>
          <span :class="['shrink-0 select-none', workerColor(line.workerId)]">[{{ shortId(line.workerId) }}]</span>
          <span class="text-slate-300 break-all">{{ line.message }}</span>
        </div>
        <div v-if="!store.filteredLogs.length" class="text-slate-400 italic">
          Waiting for logs... Run your tests to see activity here.
        </div>
      </div>

      <!-- Commands view -->
      <div
        v-show="activeTab === 'commands'"
        ref="cmdEl"
        class="flex-1 overflow-y-auto min-h-0"
        @scroll="onCmdScroll"
      >
        <div v-if="!displayCommands.length" class="p-4 text-slate-400 italic text-sm">
          {{ searchQuery ? 'No matching commands.' : 'No commands recorded yet. Run your tests to see steps here.' }}
        </div>

        <div
          v-for="(cmd, i) in displayCommands"
          :key="i"
          :class="[
            'flex items-center gap-3 px-4 py-2.5 border-b text-sm',
            cmd.error
              ? 'border-red-900/60 bg-red-950/30 hover:bg-red-950/50'
              : 'border-slate-800/60 hover:bg-slate-900/80',
          ]"
        >
          <!-- Status icon -->
          <span v-if="cmd.error" class="text-red-400 shrink-0 text-xs">&#x2715;</span>
          <span v-else class="text-green-500 shrink-0 text-xs">&#x2713;</span>

          <!-- Command label -->
          <span class="text-sm text-slate-200 font-medium shrink-0">{{ cmd.label }}</span>

          <!-- Param badge -->
          <span v-if="cmd.param" :class="['text-xs px-1.5 py-0.5 rounded font-mono shrink-0', cmdBadgeColor(cmd.label)]">
            {{ cmd.param }}
          </span>

          <!-- Spacer -->
          <span class="flex-1"></span>

          <!-- Elapsed time -->
          <span class="text-xs text-slate-500 font-mono shrink-0">{{ elapsed(cmd.timestamp) }}</span>

          <!-- Error row below (if error) -->
          <div v-if="cmd.error" class="absolute"></div>
        </div>
      </div>
    </div>

    <!-- Resizable drag handle -->
    <div
      class="shrink-0 w-1.5 cursor-col-resize bg-slate-700 hover:bg-blue-500 active:bg-blue-400 transition-colors"
      @mousedown="startDrag"
    ></div>

    <!-- Right panel: Video / Stream -->
    <div class="flex-1 flex flex-col overflow-hidden min-w-0 min-h-0">
      <div class="px-4 py-2.5 border-b border-slate-700 flex items-center gap-2 shrink-0">
        <span class="text-sm font-medium text-slate-300">Video</span>
        <span v-if="store.busyWorkerStreams.length" class="flex items-center gap-1.5 ml-1">
          <span class="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse"></span>
          <span class="text-xs text-slate-500">{{ store.busyWorkerStreams.length }} live</span>
        </span>
      </div>
      <div class="flex-1 overflow-hidden min-h-0">
        <WorkerStream />
      </div>
    </div>

  </div>
</template>
