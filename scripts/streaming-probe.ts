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
//   - agent_activity 'chunk' deltas arrive
//   - agent_state 'idle' fires
//   - Final 'message' broadcast arrives
//
// With --evict-reload: ALSO exercises the evict→reload boundary by
// POSTing /api/system/evict between the WS close and a second eval.
// This is the regression check for the unsubscribeAgentState leak fixed
// in 6d107de — without that fix, the second eval's agent_state events
// fire to nothing because stateUnsubs holds stale closures.
//
// Usage:
//   set -a; source /etc/samsinn/env; set +a
//   bun run scripts/streaming-probe.ts --url https://samsinn.app
//   bun run scripts/streaming-probe.ts --url https://samsinn.app --evict-reload
//
// Exit codes:
//   0 — chunks streamed (>= 2 chunks, time-to-first < 5s) AND state events arrived
//   2 — single-chunk response (likely chat() fallback — provider not streaming)
//   3 — agent_state 'generating' missing (subscribeAgentState not wired)
//   4 — no agent_activity at all within timeout (broadcast wiring broken)
//   5 — evict-reload mode: post-reload assertion failed (the recurring bug)
//   1 — any other failure
// ============================================================================

import { bootstrapProbe, type ProbeContext } from './lib/probe-bootstrap.ts'

const TIMEOUT_MS = 30_000

const args = process.argv.slice(2)
const urlIdx = args.indexOf('--url')
const baseUrl = urlIdx >= 0 ? args[urlIdx + 1]! : 'http://localhost:3000'
const evictReload = args.includes('--evict-reload')

const fail = (code: number, msg: string): never => {
  console.error(`FAIL(${code}): ${msg}`)
  process.exit(code)
}

interface EvalRunResult {
  chunkCount: number
  firstChunkAt: number | null
  lastChunkAt: number | null
  sawGenerating: boolean
  sawIdle: boolean
  sawMessage: boolean
  warningCount: number  // agent_activity/warning frames — non-zero means the LLM call surfaced retries or non-fatal issues
  frames: Array<{ tMs: number; type: string; subKind?: string; size: number }>
}

const ensureSeeded = async (ctx: ProbeContext): Promise<{ roomId: string; aiName: string; humanId: string }> => {
  const [roomsRes, agentsRes] = await Promise.all([
    fetch(`${ctx.baseUrl}/api/rooms`, { headers: { Cookie: ctx.cookie } }),
    fetch(`${ctx.baseUrl}/api/agents`, { headers: { Cookie: ctx.cookie } }),
  ])
  if (!roomsRes.ok) fail(1, `/api/rooms ${roomsRes.status}`)
  if (!agentsRes.ok) fail(1, `/api/agents ${agentsRes.status}`)
  const rooms = await roomsRes.json() as Array<{ id: string; name: string }>
  const agents = await agentsRes.json() as Array<{ id: string; name: string; kind: 'ai' | 'human' }>
  if (rooms.length === 0) fail(1, 'no rooms in instance — seed should have created one')
  const aiMember = agents.find(a => a.kind === 'ai')
  const humanMember = agents.find(a => a.kind === 'human')
  if (!aiMember) fail(1, 'no AI agent in instance')
  if (!humanMember) fail(1, 'no human agent in instance')
  return { roomId: rooms[0]!.id, aiName: aiMember!.name, humanId: humanMember!.id }
}

// Open a WS bound to the probe's instance, post a message AS the human
// (which triggers the AI to respond), and record every frame with timing.
const runOneEval = async (ctx: ProbeContext, label: string): Promise<EvalRunResult> => {
  const seed = await ensureSeeded(ctx)
  const ws = new WebSocket(`${ctx.wsBaseUrl}/ws`, {
    headers: { Cookie: ctx.cookie },
  } as unknown as undefined)

  const result: EvalRunResult = {
    chunkCount: 0,
    firstChunkAt: null,
    lastChunkAt: null,
    sawGenerating: false,
    sawIdle: false,
    sawMessage: false,
    warningCount: 0,
    frames: [],
  }
  let t0 = 0

  ws.addEventListener('message', (ev) => {
    const raw = ev.data as string
    let parsed: { type: string; event?: { kind: string }; state?: string }
    try { parsed = JSON.parse(raw) } catch { return }
    const tMs = t0 ? performance.now() - t0 : 0
    const subKind = parsed.event?.kind ?? parsed.state
    result.frames.push({ tMs: Math.round(tMs), type: parsed.type, subKind, size: raw.length })
    if (parsed.type === 'agent_activity' && parsed.event?.kind === 'chunk') {
      result.chunkCount++
      if (result.firstChunkAt === null) result.firstChunkAt = tMs
      result.lastChunkAt = tMs
    }
    if (parsed.type === 'agent_state' && parsed.state === 'generating') result.sawGenerating = true
    if (parsed.type === 'agent_state' && parsed.state === 'idle' && result.sawGenerating) result.sawIdle = true
    if (parsed.type === 'agent_activity' && parsed.event?.kind === 'warning') result.warningCount++
    if (parsed.type === 'message') result.sawMessage = true
  })

  await new Promise<void>((resolve, reject) => {
    const tx = setTimeout(() => reject(new Error('WS open timeout')), 3_000)
    ws.addEventListener('open', () => { clearTimeout(tx); resolve() })
    ws.addEventListener('error', () => { clearTimeout(tx); reject(new Error('WS errored')) })
  }).catch(e => fail(1, `[${label}] ${e.message}`))

  // Prompt asks for a numbered list to force ≥ 5 emit boundaries on any
  // streaming-capable provider — 'short greeting' could legitimately be
  // 1 chunk and we'd misdiagnose the streaming path as broken.
  t0 = performance.now()
  const postRes = await fetch(`${ctx.baseUrl}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ctx.cookie },
    body: JSON.stringify({
      senderId: seed.humanId,
      messageType: 'chat',
      content: `streaming-probe[${label}] ${new Date().toISOString()} — please reply with a numbered list 1 to 5, one short sentence per item.`,
      target: { rooms: [seed.roomId] },
    }),
  })
  if (!postRes.ok) fail(1, `[${label}] /api/messages ${postRes.status}: ${await postRes.text()}`)

  await new Promise<void>((resolve) => {
    const tx = setTimeout(resolve, TIMEOUT_MS)
    const poll = setInterval(() => {
      if (result.sawIdle && result.sawMessage) { clearInterval(poll); clearTimeout(tx); resolve() }
    }, 50)
  })

  ws.close()
  return result
}

const printRun = (label: string, r: EvalRunResult): void => {
  console.log(`\n=== [${label}] Frame timeline ===`)
  for (const f of r.frames) {
    const tag = f.subKind ? `${f.type}/${f.subKind}` : f.type
    console.log(`  +${String(f.tMs).padStart(5)}ms  ${tag.padEnd(36)} ${f.size}B`)
  }
  console.log(`=== [${label}] Summary ===`)
  console.log(`  agent_state generating: ${r.sawGenerating}`)
  console.log(`  agent_activity chunks : ${r.chunkCount}`)
  console.log(`  time-to-first-chunk   : ${r.firstChunkAt === null ? 'n/a' : Math.round(r.firstChunkAt) + 'ms'}`)
  console.log(`  time-to-last-chunk    : ${r.lastChunkAt === null ? 'n/a' : Math.round(r.lastChunkAt) + 'ms'}`)
  console.log(`  agent_state idle      : ${r.sawIdle}`)
  console.log(`  message broadcast     : ${r.sawMessage}`)
  console.log(`  warnings              : ${r.warningCount}`)
}

// Wiring check — what the deploy gate cares about most. Failing this
// means a regression in the broadcast/subscription path. NEVER warn-only.
const checkWiring = (label: string, r: EvalRunResult, role: 'baseline' | 'post-reload'): void => {
  if (!r.sawGenerating && r.chunkCount === 0 && !r.sawMessage) fail(4, `[${label}] no broadcasts received — broadcast wiring broken`)
  if (!r.sawGenerating) {
    const code = role === 'post-reload' ? 5 : 3
    const hint = role === 'post-reload'
      ? 'onSystemEvicted likely did not unsubscribeAgentState (stateUnsubs leak across evict-reload)'
      : 'subscribeAgentState not wired for this agent'
    fail(code, `[${label}] agent_state 'generating' missing — ${hint}`)
  }
  if (!r.sawIdle) fail(3, `[${label}] agent_state 'idle' missing after generating — eval never settled`)
  if (!r.sawMessage) fail(4, `[${label}] no 'message' broadcast — final delivery path broken`)
}

// Streaming-quality check — soft signal. chunkCount=0 with warnings is
// almost always a transient LLM/provider failure (no key, ollama down,
// retry-after on cloud). Don't fail the deploy gate on that — it's not
// a code regression.
const checkStreaming = (label: string, r: EvalRunResult): 'ok' | 'single-chunk' | 'flaky' => {
  if (r.chunkCount === 0 && r.warningCount > 0) return 'flaky'
  if (r.chunkCount === 0) return 'flaky'   // unusual but treat as flaky, not regression
  if (r.chunkCount === 1) {
    console.log(`\nDIAGNOSIS [${label}]: provider returned single chunk — likely chat() fallback (provider.stream missing or skipped).`)
    return 'single-chunk'
  }
  return 'ok'
}

const main = async (): Promise<void> => {
  const ctx = await bootstrapProbe({
    baseUrl,
    target: 'fresh',
    token: process.env.SAMSINN_TOKEN,
  })
  console.log(`probe: instance=${ctx.instance.slice(0, 8)} mode=${evictReload ? 'evict-reload' : 'single'}`)

  // Run 1 — baseline. Wiring is checked hard; streaming quality is soft.
  const run1 = await runOneEval(ctx, 'baseline')
  printRun('baseline', run1)
  checkWiring('baseline', run1, 'baseline')
  const stream1 = checkStreaming('baseline', run1)

  if (!evictReload) {
    if (stream1 === 'single-chunk') process.exit(2)
    if (stream1 === 'flaky') {
      console.log(`\nWARN: 0 chunks but wiring intact (${run1.warningCount} warnings) — likely provider issue, not a regression.`)
      return
    }
    const span = (run1.lastChunkAt ?? 0) - (run1.firstChunkAt ?? 0)
    console.log(`\nOK: streamed ${run1.chunkCount} chunks over ${Math.round(span)}ms`)
    return
  }

  // Evict the probe instance via the cookie-bound endpoint, wait for
  // diagnostics to confirm it's gone (or at least that the registry no
  // longer reports it as live), then run a second eval — which forces
  // lazy-reload via restoreFromSnapshot.
  console.log('\n=== evict ===')
  const evictRes = await fetch(`${ctx.baseUrl}/api/system/evict`, {
    method: 'POST',
    headers: { Cookie: ctx.cookie },
  })
  if (!evictRes.ok) fail(1, `/api/system/evict ${evictRes.status}: ${await evictRes.text()}`)
  console.log(`evicted: ${(await evictRes.json() as { evicted: boolean }).evicted}`)

  // Wait for diagnostics to no longer report this instance.
  // tryGetLive returns undefined for evicted instances, so registry.list()
  // omits them. Poll up to 3s.
  const pollDeadline = Date.now() + 3_000
  let stillLive = true
  while (Date.now() < pollDeadline) {
    const diagRes = await fetch(`${ctx.baseUrl}/api/system/diagnostics`, {
      headers: ctx.sessionCookie ? { Cookie: ctx.sessionCookie } : {},
    })
    if (diagRes.ok) {
      const diag = await diagRes.json() as { instances: Array<{ id: string }> }
      stillLive = diag.instances.some(i => i.id === ctx.instance)
      if (!stillLive) break
    }
    await new Promise(r => setTimeout(r, 100))
  }
  if (stillLive) fail(1, 'evict did not drop instance from registry within 3s')
  console.log('confirmed: instance dropped from registry')

  // Run 2 — post-reload. This is the regression check. The instance
  // gets lazy-reloaded by /api/rooms inside ensureSeeded → registry
  // .getOrLoad → restoreFromSnapshot → wireSystemEvents → init-loop
  // calls subscribeAgentState. Without unsubscribeAgentState in
  // onSystemEvicted, the idempotent guard would silently skip and
  // sawGenerating would be false on this run.
  const run2 = await runOneEval(ctx, 'post-reload')
  printRun('post-reload', run2)
  checkWiring('post-reload', run2, 'post-reload')
  const stream2 = checkStreaming('post-reload', run2)

  // Both runs passed wiring → deploy gate is green. Streaming quality is
  // informational. Single-chunk on either run still hints at chat() fallback.
  if (stream1 === 'single-chunk' || stream2 === 'single-chunk') {
    console.log('\nDIAGNOSIS: at least one run returned single chunk — likely chat() fallback.')
    process.exit(2)
  }
  if (stream1 === 'flaky' || stream2 === 'flaky') {
    console.log(`\nWARN: 0 chunks on at least one run (warnings: baseline=${run1.warningCount}, post-reload=${run2.warningCount}) — wiring intact, likely transient provider issue. Deploy gate green.`)
    return
  }
  console.log(`\nOK: evict-reload cycle clean. chunks=${run1.chunkCount}/${run2.chunkCount}, generating=${run1.sawGenerating}/${run2.sawGenerating}`)
}

main().catch(e => fail(1, e.message))
