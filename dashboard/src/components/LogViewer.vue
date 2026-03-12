<script setup>
import { watch, nextTick, ref } from 'vue'
import { useStore } from '../store.js'

const store = useStore()
const activeTab = ref('commands') // 'commands' | 'logs'

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
  <div class="h-full flex flex-col bg-slate-950 border-t border-slate-700">

    <!-- Header bar -->
    <div class="px-4 py-2 border-b border-slate-800 flex items-center gap-3 shrink-0">

      <!-- Tabs -->
      <div class="flex gap-0.5 bg-slate-800 rounded p-0.5">
        <button
          @click="activeTab = 'commands'"
          :class="[
            'text-xs px-3 py-1 rounded transition-colors font-semibold uppercase tracking-wider flex items-center gap-1.5',
            activeTab === 'commands'
              ? 'bg-slate-600 text-slate-100'
              : 'text-slate-500 hover:text-slate-300',
          ]"
        >
          Commands
          <span
            v-if="store.filteredCommands.length"
            class="bg-blue-600 text-white text-xs font-mono px-1.5 py-0 rounded-full leading-4"
          >{{ store.filteredCommands.length }}</span>
        </button>
        <button
          @click="activeTab = 'logs'"
          :class="[
            'text-xs px-3 py-1 rounded transition-colors font-semibold uppercase tracking-wider',
            activeTab === 'logs'
              ? 'bg-slate-600 text-slate-100'
              : 'text-slate-500 hover:text-slate-300',
          ]"
        >Live Logs</button>
      </div>

      <!-- Active filter indicator -->
      <span
        v-if="store.selectedRun"
        class="text-xs text-slate-300"
      >{{ store.runs.find(r => r.id === store.selectedRun)?.scenarioName }}</span>

      <span class="ml-auto text-xs text-slate-600">
        {{ activeTab === 'logs' ? store.filteredLogs.length + ' lines' : store.filteredCommands.length + ' steps' }}
      </span>
    </div>

    <!-- Live Logs view -->
    <div
      v-show="activeTab === 'logs'"
      ref="logEl"
      class="flex-1 overflow-y-auto p-3 font-mono text-xs leading-relaxed"
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
      class="flex-1 overflow-y-auto"
      @scroll="onCmdScroll"
    >
      <!-- Empty state -->
      <div v-if="!store.filteredCommands.length" class="p-4 text-slate-400 italic text-sm">
        No commands recorded yet. Run your tests to see steps here.
      </div>

      <!-- Command rows -->
      <div
        v-for="(cmd, i) in store.filteredCommands"
        :key="i"
        :class="[
          'flex flex-col px-4 py-2 border-b text-sm',
          cmd.error
            ? 'border-red-900/60 bg-red-950/30 hover:bg-red-950/50'
            : 'border-slate-800/60 hover:bg-slate-900',
        ]"
      >
        <!-- Main row -->
        <div class="flex items-center gap-3">
          <!-- Step number -->
          <span class="text-slate-600 font-mono text-xs shrink-0 w-8 text-right select-none">{{ i + 1 }}</span>

          <!-- Timestamp -->
          <span class="text-slate-500 font-mono text-xs shrink-0 select-none">{{ fmt(cmd.timestamp) }}</span>

          <!-- Worker badge -->
          <span :class="['text-xs px-1.5 py-0.5 rounded border font-mono shrink-0', workerBadgeColor(cmd.workerId)]">
            {{ shortId(cmd.workerId) }}
          </span>

          <!-- Status icon -->
          <span v-if="cmd.error" class="text-red-400 shrink-0 select-none" title="Failed">✕</span>
          <span v-else class="text-green-500 shrink-0 select-none" title="Passed">✓</span>

          <!-- Command label badge -->
          <span :class="['text-xs px-2 py-0.5 rounded font-semibold shrink-0', cmdBadgeColor(cmd.label)]">
            {{ cmd.label }}
          </span>

          <!-- Primary param (url / selector / key) -->
          <span v-if="cmd.param" class="text-slate-300 text-xs font-mono truncate" :title="cmd.param">
            {{ cmd.param }}
          </span>
        </div>

        <!-- Error message row -->
        <div v-if="cmd.error" class="flex items-start gap-2 mt-1 pl-11">
          <span class="text-red-400 text-xs font-mono break-all" :title="cmd.error">{{ cmd.error }}</span>
        </div>
      </div>
    </div>

  </div>
</template>
