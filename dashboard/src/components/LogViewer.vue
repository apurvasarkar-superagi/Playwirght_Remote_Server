<script setup>
import { watch, nextTick, ref } from 'vue'
import { useStore } from '../store.js'

const store = useStore()
const logEl = ref(null)
const pinToBottom = ref(true)

watch(
  () => store.filteredLogs.length,
  async () => {
    if (!pinToBottom.value) return
    await nextTick()
    if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
  }
)

function onScroll() {
  const el = logEl.value
  if (!el) return
  pinToBottom.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 20
}

const fmt = (ts) => new Date(ts).toISOString().slice(11, 23)

const workerColor = (() => {
  const palette = ['text-blue-400', 'text-purple-400', 'text-cyan-400', 'text-orange-400', 'text-pink-400']
  const map = {}
  let i = 0
  return (id) => {
    if (!map[id]) map[id] = palette[i++ % palette.length]
    return map[id]
  }
})()

const shortId = (id) => id.slice(-6)
</script>

<template>
  <div class="h-full flex flex-col bg-slate-950 border-t border-slate-700">
    <div class="px-4 py-2 border-b border-slate-800 flex items-center gap-3 shrink-0">
      <h2 class="text-xs font-semibold uppercase tracking-wider text-slate-500">Live Logs</h2>

      <!-- Worker filter chips -->
      <div class="flex gap-1.5 flex-wrap">
        <button
          v-for="w in store.workers"
          :key="w.id"
          @click="store.setFilter(w.id)"
          :class="[
            'text-xs px-2 py-0.5 rounded-full border transition-colors',
            store.filterWorker === w.id
              ? 'border-blue-500 bg-blue-900 text-blue-200'
              : 'border-slate-700 text-slate-500 hover:border-slate-500',
          ]"
        >
          {{ shortId(w.id) }}
        </button>
      </div>

      <span class="ml-auto text-xs text-slate-600">{{ store.filteredLogs.length }} lines</span>
    </div>

    <div
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
      <div v-if="!store.filteredLogs.length" class="text-slate-600 italic">
        Waiting for logs... Run your pytest tests to see activity here.
      </div>
    </div>
  </div>
</template>
