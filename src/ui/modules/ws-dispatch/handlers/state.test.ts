// Snapshot-handler stale-cache eviction tests.
//
// Background: the server sends a `snapshot` WS event on every WS open
// (initial + reconnect). Before this fix, the snapshot handler refreshed
// rooms/agents/transients but left `$roomMessages` untouched. If the
// server's authoritative state diverged from the client cache (e.g. server
// restart, instance eviction), the UI showed phantom messages forever.
//
// These tests pin the listener-semantics contract: cached rooms are
// cleared via `setKey(roomId, [])` (which fires the renderer's diff path)
// — NOT bare `set({})` (which leaves `changedKey` undefined and the
// renderer skips DOM removal).

import { describe, expect, test, beforeEach } from 'bun:test'
import { stateHandlers } from './state.ts'
import { $roomMessages, $rooms, $selectedRoomId, $agents } from '../../stores.ts'
import type { WSOutbound } from '../../../../core/types/ws-protocol.ts'

type Snapshot = Extract<WSOutbound, { readonly type: 'snapshot' }>

const mkRoom = (id: string, name: string) => ({
  id,
  name,
  createdAt: 0,
  createdBy: 'test',
}) as unknown as Snapshot['rooms'][number]

const mkMsg = (id: string, roomId: string) => ({
  id,
  roomId,
  senderId: 's',
  senderName: 'S',
  content: 'hi',
  timestamp: 0,
  type: 'chat' as const,
})

describe('stateHandlers.snapshot — stale cache eviction', () => {
  beforeEach(() => {
    $roomMessages.set({})
    $rooms.set({})
    $selectedRoomId.set(null)
    $agents.set({})
  })

  test('clears each previously-cached room via setKey (fires the listener)', () => {
    $roomMessages.setKey('r1', [mkMsg('m1', 'r1') as never])
    $roomMessages.setKey('r2', [mkMsg('m2', 'r2') as never])

    const snap: Snapshot = {
      type: 'snapshot',
      rooms: [mkRoom('r1', 'R1')],
      agents: [],
      roomStates: {},
    }

    // Spy on setKey to prove we used the per-key API, not a bare `set`.
    const setKeyCalls: Array<{ key: string; value: unknown }> = []
    const origSetKey = $roomMessages.setKey
    $roomMessages.setKey = ((key: string, value: unknown) => {
      setKeyCalls.push({ key, value })
      return origSetKey.call($roomMessages, key as never, value as never)
    }) as typeof $roomMessages.setKey

    stateHandlers.snapshot!(snap as never)

    expect($roomMessages.get()).toEqual({ r1: [], r2: [] })
    expect(setKeyCalls.some(c => c.key === 'r1' && Array.isArray(c.value) && (c.value as unknown[]).length === 0)).toBe(true)
    expect(setKeyCalls.some(c => c.key === 'r2' && Array.isArray(c.value) && (c.value as unknown[]).length === 0)).toBe(true)

    $roomMessages.setKey = origSetKey
  })

  test('triggers fetchRoomMessages for the selected room', async () => {
    $rooms.setKey('r1', { id: 'r1', name: 'R1', createdAt: 0, createdBy: 't' } as never)
    $selectedRoomId.set('r1')

    const fetchCalls: string[] = []
    const origFetch = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      fetchCalls.push(url)
      return Promise.resolve(new Response(JSON.stringify({
        profile: { id: 'r1', name: 'R1' },
        messages: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    }) as typeof fetch

    const snap: Snapshot = {
      type: 'snapshot',
      rooms: [mkRoom('r1', 'R1')],
      agents: [],
      roomStates: {},
    }
    stateHandlers.snapshot!(snap as never)
    // fetch is fired but not awaited inside the handler; give it a tick.
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(fetchCalls.some(u => u.includes('/api/rooms/R1'))).toBe(true)

    globalThis.fetch = origFetch
  })

  test('no fetch when no room is selected', () => {
    $selectedRoomId.set(null)

    const fetchCalls: string[] = []
    const origFetch = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      fetchCalls.push(url)
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as typeof fetch

    const snap: Snapshot = {
      type: 'snapshot',
      rooms: [],
      agents: [],
      roomStates: {},
    }
    stateHandlers.snapshot!(snap as never)

    expect(fetchCalls.filter(u => u.includes('/api/rooms/'))).toEqual([])

    globalThis.fetch = origFetch
  })
})

// ---------------------------------------------------------------------------
// PR 4 — thinking persistence on the assistant message bubble.
// $liveThinking accumulates deltas during gen; the agent_activity handler
// appends to it on `kind: 'thinking'`. The `message` handler transfers it
// to $messageThinking keyed by m.id BEFORE setting $roomMessages so the
// synchronous renderMessage listener can pick it up. Cancel/abort cleanup
// is in app-thinking.ts's clearThinkingIndicator (not exercised here).
// ---------------------------------------------------------------------------

import { $liveThinking, $messageThinking } from '../../stores.ts'

describe('stateHandlers — thinking persistence (PR 4)', () => {
  beforeEach(() => {
    $roomMessages.set({})
    $liveThinking.set({})
    $messageThinking.set({})
    $agents.set({})
    // $agentIdByName is computed off $agents, no separate reset needed
  })

  test('thinking event appends to $liveThinking', () => {
    $agents.setKey('agent-1', { id: 'agent-1', name: 'Aiden', state: 'generating', kind: 'ai' } as never)
    stateHandlers.agent_activity!({
      type: 'agent_activity',
      agentName: 'Aiden',
      event: { kind: 'thinking', delta: 'step 1...' },
    } as never)
    stateHandlers.agent_activity!({
      type: 'agent_activity',
      agentName: 'Aiden',
      event: { kind: 'thinking', delta: ' step 2.' },
    } as never)
    expect($liveThinking.get()['agent-1']).toBe('step 1... step 2.')
  })

  test('message event transfers $liveThinking → $messageThinking keyed by msg.id, clears live', () => {
    $agents.setKey('agent-1', { id: 'agent-1', name: 'Aiden', state: 'generating' } as never)
    $liveThinking.setKey('agent-1', 'the reasoning')

    stateHandlers.message!({
      type: 'message',
      message: {
        id: 'msg-42', roomId: 'room-1', senderId: 'agent-1', senderName: 'Aiden',
        content: 'the answer', timestamp: 0, type: 'chat',
      },
    } as never)

    expect($messageThinking.get()['msg-42']).toBe('the reasoning')
    expect($liveThinking.get()['agent-1']).toBeUndefined()
  })

  test('message with no accumulated thinking → $messageThinking unchanged', () => {
    $agents.setKey('agent-1', { id: 'agent-1', name: 'Aiden', state: 'generating' } as never)
    stateHandlers.message!({
      type: 'message',
      message: {
        id: 'msg-42', roomId: 'room-1', senderId: 'agent-1', senderName: 'Aiden',
        content: 'the answer', timestamp: 0, type: 'chat',
      },
    } as never)
    expect($messageThinking.get()['msg-42']).toBeUndefined()
  })

  test('transfer runs BEFORE $roomMessages.setKey so synchronous renderMessage can read it', () => {
    $agents.setKey('agent-1', { id: 'agent-1', name: 'Aiden', state: 'generating' } as never)
    $liveThinking.setKey('agent-1', 'pre-transfer reasoning')

    let seenWhenRoomMessagesFired: string | undefined
    const unsub = $roomMessages.listen(() => {
      seenWhenRoomMessagesFired = $messageThinking.get()['msg-99']
    })

    stateHandlers.message!({
      type: 'message',
      message: {
        id: 'msg-99', roomId: 'room-1', senderId: 'agent-1', senderName: 'Aiden',
        content: 'final', timestamp: 0, type: 'chat',
      },
    } as never)

    unsub()
    // At the moment the listener fired (synchronously off setKey), the
    // thinking had to already be in $messageThinking.
    expect(seenWhenRoomMessagesFired).toBe('pre-transfer reasoning')
  })
})
