<script setup>
import { useStore } from '../store.js'
const store = useStore()

const statusBadge = (s) => ({
  waiting:   'bg-slate-700 text-slate-300',
  active:    'bg-blue-900 text-blue-300',
  completed: 'bg-green-900 text-green-300',
  failed:    'bg-red-900 text-red-300',
}[s] ?? 'bg-slate-700 text-slate-400')

const duration = (job) => {
  if (!job.processedOn) return '—'
  const end = job.finishedOn ?? Date.now()
  const ms = end - job.processedOn
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

const relTime = (ts) => {
  if (!ts) return '—'
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}
</script>

<template>
  <div class="h-full">
    <div class="px-4 py-3 border-b border-slate-700 flex items-center gap-2">
      <h2 class="text-xs font-semibold uppercase tracking-wider text-slate-500">
        Jobs ({{ store.jobs.length }})
      </h2>
    </div>

    <table class="w-full text-sm">
      <thead>
        <tr class="text-xs uppercase text-slate-500 border-b border-slate-700">
          <th class="text-left px-4 py-2 font-medium">Name</th>
          <th class="text-left px-4 py-2 font-medium">Status</th>
          <th class="text-left px-4 py-2 font-medium">Duration</th>
          <th class="text-left px-4 py-2 font-medium">Submitted</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="job in store.jobs"
          :key="job.id"
          class="border-b border-slate-800 hover:bg-slate-800 cursor-pointer transition-colors"
          :class="{ 'bg-slate-800': store.selectedJobId === job.id }"
          @click="store.selectJob(job.id)"
        >
          <td class="px-4 py-2.5">
            <div class="font-medium text-slate-200 truncate max-w-xs">{{ job.name }}</div>
            <div class="text-xs text-slate-500 font-mono">#{{ job.id }}</div>
          </td>
          <td class="px-4 py-2.5">
            <span :class="['text-xs font-semibold px-2 py-0.5 rounded-full', statusBadge(job.status)]">
              {{ job.status }}
            </span>
          </td>
          <td class="px-4 py-2.5 text-slate-400 font-mono text-xs">{{ duration(job) }}</td>
          <td class="px-4 py-2.5 text-slate-500 text-xs">{{ relTime(job.timestamp) }}</td>
        </tr>
        <tr v-if="!store.jobs.length">
          <td colspan="4" class="px-4 py-8 text-center text-slate-600 italic text-sm">
            No jobs yet — submit one using the form
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
