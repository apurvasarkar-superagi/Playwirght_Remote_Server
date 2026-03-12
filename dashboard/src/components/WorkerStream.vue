<script setup>
import { ref, computed } from 'vue'
import { useStore } from '../store.js'

const store = useStore()
const screenshotModal = ref(null)

const shortId = (id) => id?.slice(-6) || ''

const fmt = (ts) => {
  try {
    const d = new Date(Number(ts))
    if (isNaN(d.getTime())) return '--:--:--.---'
    return d.toISOString().slice(11, 23)
  } catch {
    return '--:--:--.---'
  }
}

// Only show stream for the selected run — don't mix all workers together
const streams = computed(() => {
  if (!store.selectedRun) return []
  if (store.activeStreamUrl) {
    const run = store.runs.find((r) => r.id === store.selectedRun)
    return [{
      workerId: run?.workerId,
      streamUrl: store.activeStreamUrl,
      scenarioName: run?.scenarioName,
    }]
  }
  return []
})

// Build noVNC viewer URL
function vncViewerUrl(streamUrl) {
  const workerIp = streamUrl.replace('/stream/', '')
  const proto = location.protocol
  const host = location.host
  const wsPath = `stream/${workerIp}`
  return `${proto}//${host}${streamUrl}/vnc_embed.html?view_only=true&reconnect_delay=2000&path=${wsPath}`
}

const screenshots = computed(() => store.filteredScreenshots)
</script>

<template>
  <div class="h-full flex flex-col bg-black">

    <!-- Live stream area -->
    <div v-if="streams.length" class="flex-1 relative min-h-0">
      <!-- Single stream: fill entire area -->
      <div v-if="streams.length === 1" class="h-full relative">
        <div class="absolute top-2 left-2 z-10 flex items-center gap-1.5 bg-black/60 backdrop-blur px-2 py-1 rounded text-xs">
          <span class="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse"></span>
          <span class="text-slate-300 font-mono">{{ shortId(streams[0].workerId) }}</span>
          <span v-if="streams[0].scenarioName" class="text-slate-500">{{ streams[0].scenarioName }}</span>
        </div>
        <iframe
          :src="vncViewerUrl(streams[0].streamUrl)"
          style="width: 100%; height: 100%; border: 0;"
          allow="fullscreen"
        ></iframe>
      </div>

      <!-- Multiple streams: grid -->
      <div v-else class="h-full p-2 flex flex-wrap gap-2 min-h-0">
        <div
          v-for="stream in streams"
          :key="stream.workerId"
          class="relative rounded overflow-hidden border border-slate-700 bg-black flex-1 min-w-[280px] min-h-0"
        >
          <div class="absolute top-2 left-2 z-10 flex items-center gap-1.5 bg-black/60 backdrop-blur px-2 py-1 rounded text-xs">
            <span class="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse"></span>
            <span class="text-slate-300 font-mono">{{ shortId(stream.workerId) }}</span>
          </div>
          <iframe
            :src="vncViewerUrl(stream.streamUrl)"
            style="width: 100%; height: 100%; border: 0;"
            allow="fullscreen"
          ></iframe>
        </div>
      </div>
    </div>

    <!-- No streams placeholder -->
    <div v-else-if="!screenshots.length" class="flex-1 flex items-center justify-center">
      <div class="text-center text-slate-600">
        <svg class="w-12 h-12 mx-auto mb-3 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
            d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/>
        </svg>
        <p class="text-sm">No active streams</p>
        <p class="text-xs mt-1">Live browser feeds appear here when workers are running tests</p>
      </div>
    </div>

    <!-- Error screenshots gallery -->
    <div v-if="screenshots.length" class="shrink-0 border-t border-slate-800 max-h-[30%] flex flex-col overflow-hidden">
      <div class="px-3 py-1.5 border-b border-slate-800 flex items-center gap-2 shrink-0">
        <svg class="w-3 h-3 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/>
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"/>
        </svg>
        <span class="text-xs font-medium text-slate-400">Error Screenshots</span>
        <span class="text-xs text-red-400 font-mono ml-auto">{{ screenshots.length }}</span>
      </div>

      <div class="flex-1 overflow-y-auto p-2">
        <div class="flex gap-2 flex-wrap">
          <div
            v-for="(ss, i) in screenshots"
            :key="i"
            class="relative rounded overflow-hidden border border-red-900/40 bg-slate-900 cursor-pointer hover:border-red-700 transition-colors w-32"
            @click="screenshotModal = ss.filename"
          >
            <img
              :src="`/screenshots/${ss.filename}`"
              :alt="`Error: ${ss.error || 'unknown'}`"
              class="w-full h-auto"
              loading="lazy"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- Screenshot modal overlay -->
    <Teleport to="body">
      <div
        v-if="screenshotModal"
        class="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8 cursor-pointer"
        @click="screenshotModal = null"
      >
        <img
          :src="`/screenshots/${screenshotModal}`"
          class="max-w-full max-h-full rounded-lg shadow-2xl"
          @click.stop
        />
        <button
          class="absolute top-4 right-4 text-white/60 hover:text-white text-2xl"
          @click="screenshotModal = null"
        >&times;</button>
      </div>
    </Teleport>

  </div>
</template>
