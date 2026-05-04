#!/usr/bin/env bun
// ============================================================================
// Post-restart smoke test: WS broadcast wiring is alive.
//
// What it proves: a wired instance can deliver a `message` broadcast to a
// connected WS client. Catches the silent-skip class of bug fixed in
// 5d73a8e — where streaming events were dropped on the floor for every
// non-boot instance.
//
// What it does NOT exercise: real LLM streaming, the evict→reload
// boundary, or the eval-event chunk path. For those use
// scripts/streaming-probe.ts (with --evict-reload in the deploy gate).
//
// Usage:
//   set -a; source /etc/samsinn/env; set +a
//   bun run scripts/smoke-streaming.ts
//   bun run scripts/smoke-streaming.ts --url https://samsinn.app
//
// Exit codes:
//   0 — green: broadcasts arrive within timeout
//   1 — red: missing token, auth failed, or no broadcast within timeout
// ============================================================================

import { bootstrapProbe } from './lib/probe-bootstrap.ts'

const TIMEOUT_MS = 5_000

const args = process.argv.slice(2)
const urlIdx = args.indexOf('--url')
const baseUrl = urlIdx >= 0 ? args[urlIdx + 1]! : 'http://localhost:3000'

const fail = (msg: string): never => {
  console.error(`FAIL: ${msg}`)
  process.exit(1)
}

const main = async (): Promise<void> => {
  const ctx = await bootstrapProbe({
    baseUrl,
    target: 'reuse-wired',
    token: process.env.SAMSINN_TOKEN,
  })

  const ws = new WebSocket(`${ctx.wsBaseUrl}/ws`, {
    headers: { Cookie: ctx.cookie },
  } as unknown as undefined)

  const seen = new Set<string>()
  let snapshotReceived = false
  let messageReceived = false
  ws.addEventListener('message', (ev) => {
    try {
      const data = JSON.parse(ev.data as string)
      if (data.type === 'snapshot') snapshotReceived = true
      if (data.type === 'message') messageReceived = true
      seen.add(data.type)
    } catch { /* ignore non-JSON */ }
  })

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WS did not open within 3s')), 3_000)
    ws.addEventListener('open', () => { clearTimeout(t); resolve() })
    ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('WS errored')) })
  }).catch(e => fail(e.message))

  // Find a room to send into.
  const roomsRes = await fetch(`${ctx.baseUrl}/api/rooms`, {
    headers: { Cookie: ctx.cookie },
  })
  if (!roomsRes.ok) fail(`/api/rooms returned ${roomsRes.status}`)
  const rooms = await roomsRes.json() as Array<{ id: string }>
  if (rooms.length === 0) fail('instance has no rooms — seed should have created one')

  const postRes = await fetch(`${ctx.baseUrl}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ctx.cookie },
    body: JSON.stringify({
      senderId: 'system',
      messageType: 'chat',
      content: `smoke-test ${new Date().toISOString()}`,
      target: { rooms: [rooms[0]!.id] },
    }),
  })
  if (!postRes.ok) fail(`/api/messages returned ${postRes.status}`)

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no 'message' broadcast within ${TIMEOUT_MS}ms — broadcast wiring is broken`)), TIMEOUT_MS)
    const poll = setInterval(() => {
      if (messageReceived) { clearInterval(poll); clearTimeout(t); resolve() }
    }, 50)
  })

  ws.close()

  if (!snapshotReceived) fail('no snapshot received on WS open — protocol regression')

  console.log(`OK: ws snapshot + message broadcast received (instance=${ctx.instance.slice(0, 8)}, eventTypes=${[...seen].join(',')})`)
}

main().catch(e => fail(e.message))
