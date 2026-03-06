<script setup>
import { useStore } from '../store.js'
const store = useStore()

const shortId = (id) => id.slice(-8)
</script>

<template>
  <div>
    <h2 class="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
      Nodes ({{ store.workers.length }})
    </h2>

    <div v-if="!store.workers.length" class="text-sm text-slate-600 italic">
      No workers connected
    </div>

    <div class="flex flex-col gap-1.5">
      <div
        v-for="w in store.workers"
        :key="w.id"
        class="flex items-center gap-2.5 bg-slate-800 border border-slate-700 rounded px-3 py-2"
      >
        <span
          class="w-2 h-2 rounded-full shrink-0"
          :class="w.status === 'busy' ? 'bg-yellow-400 animate-pulse' : 'bg-green-500'"
        ></span>
        <span class="text-xs font-mono text-slate-300 truncate flex-1">{{ shortId(w.id) }}</span>
        <span
          class="text-xs font-semibold"
          :class="w.status === 'busy' ? 'text-yellow-400' : 'text-green-400'"
        >
          {{ w.status === 'busy' ? 'running' : 'idle' }}
        </span>
      </div>
    </div>
  </div>
</template>
