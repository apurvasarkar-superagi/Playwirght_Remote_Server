import { createRouter, createWebHistory } from 'vue-router'
import BuildsPage from './pages/BuildsPage.vue'
import DashboardPage from './pages/DashboardPage.vue'

const routes = [
  { path: '/', redirect: '/builds' },
  { path: '/builds', name: 'builds', component: BuildsPage },
  { path: '/dashboard', name: 'dashboard', component: DashboardPage },
  { path: '/dashboard/:runId', name: 'dashboard-run', component: DashboardPage, props: true },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})
