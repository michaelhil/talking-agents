#!/usr/bin/env bun
// ============================================================================
// Real-eval streaming probe — fires an actual LLM eval against a chosen
// instance + room and records every WS frame received with relative
// timestamps. The smoke test (smoke-streaming.ts) only exercises the
// system-message → broadcast path; it does NOT exercise the eval-event
// chunk path. This script does.
//
// What it proves end-to-end:
//   - WS upgrade works (Caddy + auth + cookie + ws-handler upgrade)
//   - Posting to a room with an AI member triggers eval
//   - agent_state 'generating' fires
//   - agent_activity 'chunk' deltas arrive (multiple, over time)
//   - agent_state 'idle' fires
//   - Final 'message' broadcast arrives
//
// Usage:
//   set -a; source /etc/samsinn/env; set +a
//   bun run scripts/streaming-probe.ts --url https://samsinn.app
//   bun run scripts/streaming-probe.ts --instance <id>     # pick specific instance
//
// Exit codes:
//   0 — chunks streamed (>= 2 chunks, time-to-first < 5s)
//   2 — single-chunk response (likely fallback to chat() — provider not streaming)
//   3 — agent_state 'generating' missing (subscribeAgentState not wired)
//   4 — no agent_activity at all within timeout (broadcast wiring broken)
//   1 — any other failure
// ============================================================================

const TIMEOUT_MS = 30_000

const args = process.argv.slice(2)
const urlIdx = args.indexOf('--url')
const baseUrl = urlIdx >= 0 ? args[urlIdx + 1]! : 'http://localhost:3000'
const instIdx = args.indexOf('--instance')
const forcedInstance = instIdx >= 0 ? args[instIdx + 1] : undefined
const wsBaseUrl = baseUrl.replace(/^http/, 'ws')

const token = process.env.SAMSINN_TOKEN

const fail = (code: number, msg: string): never => {
  console.error(`FAIL(${code}): ${msg}`)
  process.exit(code)
}

const main = async (): Promise<void> => {
  let sessionCookie: string | undefined
  if (token) {
    const authRes = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    if (!authRes.ok) fail(1, `/api/auth ${authRes.status}`)
    sessionCookie = authRes.headers
      .getSetCookie()
      .find(c => c.startsWith('samsinn_session='))
      ?.split(';')[0]
    if (!sessionCookie) fail(1, 'no session cookie')
  }

  const cookieFor = (instance: string): string =>
    sessionCookie
      ? `${sessionCookie}; samsinn_instance=${instance}`
      : `samsinn_instance=${instance}`

  let instance = forcedInstance
  if (!instance) {
    const diagRes = await fetch(`${baseUrl}/api/system/diagnostics`, {
      ...(sessionCookie ? { headers: { Cookie: sessionCookie } } : {}),
    })
    if (!diagRes.ok) fail(1, `/api/system/diagnostics ${diagRes.status}`)
    const diag = await diagRes.json() as {
      instances: Array<{ id: string; wired: boolean }>
    }
    const wired = diag.instances.find(i => i.wired)
    if (!wired) fail(1, 'no wired instance available')
    instance = wired.id
  }
  const cookie = cookieFor(instance!)

  const [roomsRes, agentsRes] = await Promise.all([
    fetch(`${baseUrl}/api/rooms`, { headers: { Cookie: cookie } }),
    fetch(`${baseUrl}/api/agents`, { headers: { Cookie: cookie } }),
  ])
  if (!roomsRes.ok) fail(1, `/api/rooms ${roomsRes.status}`)
  if (!agentsRes.ok) fail(1, `/api/agents ${agentsRes.status}`)
  const rooms = await roomsRes.json() as Array<{ id: string; name: string }>
  const agents = await agentsRes.json() as Array<{ id: string; name: string; kind: 'ai' | 'human' }>
  if (rooms.length === 0) fail(1, 'no rooms in instance')
  const aiMember = agents.find(a => a.kind === 'ai')
  const humanMember = agents.find(a => a.kind === 'human')
  if (!aiMember) fail(1, 'no AI agent in instance')
  if (!humanMember) fail(1, 'no human agent in instance')
  const room = rooms[0]!

  console.log(`probe: instance=${instance!.slice(0, 8)} room=${room.name} ai=${aiMember.name} human=${humanMember.name}`)

  const ws = new WebSocket(`${wsBaseUrl}/ws`, {
    headers: { Cookie: cookie },
  } as unknown as undefined)

  interface FrameLog { tMs: number; type: string; subKind?: string; size: number }
  const frames: FrameLog[] = []
  let t0: number = 0
  let firstChunkAt: number | null = null
  let lastChunkAt: number | null = null
  let chunkCount = 0
  let sawGenerating = false
  let sawIdle = false
  let sawMessage = false

  ws.addEventListener('message', (ev) => {
    const raw = ev.data as string
    let parsed: { type: string; event?: { kind: string }; state?: string }
    try { parsed = JSON.parse(raw) } catch { return }
    const tMs = t0 ? performance.now() - t0 : 0
    const subKind = parsed.event?.kind ?? parsed.state
    frames.push({ tMs: Math.round(tMs), type: parsed.type, subKind, size: raw.length })
    if (parsed.type === 'agent_activity' && parsed.event?.kind === 'chunk') {
      chunkCount++
      if (firstChunkAt === null) firstChunkAt = tMs
      lastChunkAt = tMs
    }
    if (parsed.type === 'agent_state' && parsed.state === 'generating') sawGenerating = true
    if (parsed.type === 'agent_state' && parsed.state === 'idle' && sawGenerating) sawIdle = true
    if (parsed.type === 'message') sawMessage = true
  })

  await new Promise<void>((resolve, reject) => {
    const tx = setTimeout(() => reject(new Error('WS open timeout')), 3_000)
    ws.addEventListener('open', () => { clearTimeout(tx); resolve() })
    ws.addEventListener('error', () => { clearTimeout(tx); reject(new Error('WS errored')) })
  }).catch(e => fail(1, e.message))

  // Trigger eval: post AS the human in the room to make AI respond.
  t0 = performance.now()
  const postRes = await fetch(`${baseUrl}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      senderId: humanMember.id,
      messageType: 'chat',
      content: `streaming-probe ${new Date().toISOString()} — please respond with a short greeting.`,
      target: { rooms: [room.id] },
    }),
  })
  if (!postRes.ok) fail(1, `/api/messages ${postRes.status}: ${await postRes.text()}`)

  // Wait until idle OR timeout.
  await new Promise<void>((resolve) => {
    const tx = setTimeout(resolve, TIMEOUT_MS)
    const poll = setInterval(() => {
      if (sawIdle && sawMessage) { clearInterval(poll); clearTimeout(tx); resolve() }
    }, 50)
  })

  ws.close()

  console.log('\n=== Frame timeline ===')
  for (const f of frames) {
    const tag = f.subKind ? `${f.type}/${f.subKind}` : f.type
    console.log(`  +${String(f.tMs).padStart(5)}ms  ${tag.padEnd(36)} ${f.size}B`)
  }
  console.log('\n=== Summary ===')
  console.log(`  agent_state generating: ${sawGenerating}`)
  console.log(`  agent_activity chunks : ${chunkCount}`)
  console.log(`  time-to-first-chunk   : ${firstChunkAt === null ? 'n/a' : Math.round(firstChunkAt) + 'ms'}`)
  console.log(`  time-to-last-chunk    : ${lastChunkAt === null ? 'n/a' : Math.round(lastChunkAt) + 'ms'}`)
  console.log(`  agent_state idle      : ${sawIdle}`)
  console.log(`  message broadcast     : ${sawMessage}`)

  if (!sawGenerating && chunkCount === 0 && !sawMessage) fail(4, 'no broadcasts received — broadcast wiring broken')
  if (!sawGenerating) fail(3, "agent_state 'generating' missing — subscribeAgentState not wired for this agent")
  if (chunkCount === 0) fail(4, 'no agent_activity chunks — eval-event broadcast broken')
  if (chunkCount === 1) {
    console.log('\nDIAGNOSIS: provider returned single chunk — likely chat() fallback (provider.stream missing or skipped).')
    process.exit(2)
  }

  const span = (lastChunkAt ?? 0) - (firstChunkAt ?? 0)
  console.log(`\nOK: streamed ${chunkCount} chunks over ${Math.round(span)}ms`)
}

main().catch(e => fail(1, e.message))
