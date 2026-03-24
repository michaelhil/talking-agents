// ============================================================================
// WebSocket Client — Connection lifecycle, reconnection, and message dispatch.
// ============================================================================

// === Connect + Reconnect ===

export interface WSClient {
  send: (data: unknown) => void
}

export const createWSClient = (
  name: string,
  sessionToken: string,
  onMessage: (msg: unknown) => void,
  onStatusChange: (connected: boolean) => void,
): WSClient => {
  let ws: WebSocket | null = null

  const connect = () => {
    const params = new URLSearchParams({ name })
    if (sessionToken) params.set('session', sessionToken)

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${protocol}//${location.host}/ws?${params}`)

    ws.onopen = () => onStatusChange(true)

    ws.onclose = () => {
      onStatusChange(false)
      setTimeout(connect, 2000)
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
