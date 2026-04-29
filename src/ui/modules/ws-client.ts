// ============================================================================
// WebSocket Client — Connection lifecycle, reconnection, and message dispatch.
//
// Reconnect uses exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (cap). Reset
// on successful onopen. Replaces the previous fixed-2s retry which hammered
// the server at 30 attempts/min when down.
//
// Custom close codes (4xxx range, server-defined): 4001 = "instance
// unavailable" (transient — eviction-in-progress; backoff still applies but
// the next reconnect generally succeeds). No close-code branching here:
// browsers don't expose HTTP 401 responses to onclose, and surfacing custom
// close codes via toasts is a separate UX concern.
// ============================================================================

// === Connect + Reconnect ===

const BACKOFF_SCHEDULE_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]

export interface WSClient {
  send: (data: unknown) => void
}

export const createWSClient = (
  sessionToken: string,
  onMessage: (msg: unknown) => void,
  onStatusChange: (connected: boolean) => void,
): WSClient => {
  let ws: WebSocket | null = null
  let attempt = 0

  const nextDelayMs = (): number =>
    BACKOFF_SCHEDULE_MS[Math.min(attempt, BACKOFF_SCHEDULE_MS.length - 1)]!

  const connect = () => {
    const params = new URLSearchParams()
    if (sessionToken) params.set('session', sessionToken)

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${protocol}//${location.host}/ws?${params}`)

    ws.onopen = () => {
      attempt = 0  // reset backoff on successful connect
      onStatusChange(true)
    }

    ws.onclose = () => {
      onStatusChange(false)
      const delay = nextDelayMs()
      attempt++
      setTimeout(connect, delay)
    }

    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data))
      } catch { /* ignore parse errors */ }
    }
  }

  connect()

  return {
    send: (data: unknown) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data))
      }
    },
  }
}
