import { io } from 'socket.io-client'

// Connects to the same host/port serving the page (gateway proxies /socket.io/ to api-manager)
export const socket = io('/', { path: '/socket.io' })
