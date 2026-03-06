<script setup>
import { ref, onMounted } from 'vue'

const wsUrl = ref(window.location.origin.replace(/^http/, 'ws') + '/playwright')
const copied = ref(false)

function copy() {
  navigator.clipboard.writeText(wsUrl.value)
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}
</script>

<template>
  <div>
    <h2 class="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
      Connection
    </h2>

    <p class="text-xs text-slate-400 mb-2">
      Use this WebSocket URL in your <code class="text-slate-300">playwright.connect()</code> call:
    </p>

    <div class="flex gap-2 items-center">
      <code class="flex-1 text-xs bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-blue-300 break-all">
        {{ wsUrl }}
      </code>
      <button
        @click="copy"
        class="shrink-0 text-xs bg-slate-700 hover:bg-slate-600 text-slate-200 rounded px-2 py-1.5 transition-colors"
      >
        {{ copied ? 'Copied!' : 'Copy' }}
      </button>
    </div>

    <p class="text-xs text-slate-600 mt-3">
      Scale workers: <code class="text-slate-500">docker compose up --scale worker=N</code>
    </p>
  </div>
</template>
