// Pure function — easy to verify with real message fixtures.

import { describe, expect, test } from 'bun:test'
import type { Message } from '../types/messaging.ts'
import { redactBiometricMessages } from './snapshot-redact.ts'

const baseMessage = (overrides: Partial<Message>): Message => ({
  id: 'm1',
  senderId: 'sys',
  content: 'hello',
  timestamp: 1000,
  type: 'system',
  roomId: 'r1',
  ...overrides,
})

describe('redactBiometricMessages', () => {
  test('rewrites biometric content as a stopped-state fence', () => {
    const out = redactBiometricMessages([
      baseMessage({ id: 'a', senderName: 'Observer', cause: { kind: 'biometric', name: 'cap_1' } }),
    ])
    // Plain landmark/signal JSON is stripped; what remains is a
    // parseable fenced block that the widget renders as a terminal
    // "Capture stopped" card on reload.
    expect(out[0]!.content).toContain('```biometric')
    const fenceBody = out[0]!.content.match(/```biometric\n([\s\S]*?)\n```/)?.[1] ?? ''
    const payload = JSON.parse(fenceBody) as Record<string, unknown>
    expect(payload).toEqual({
      captureId: 'cap_1',
      agentName: 'Observer',
      reason: '(not persisted)',
      state: 'stopped',
    })
  })

  test('handles missing senderName and missing cause.name defensively', () => {
    const out = redactBiometricMessages([
      baseMessage({ id: 'a', cause: { kind: 'biometric', name: '' } }),
    ])
    const fenceBody = out[0]!.content.match(/```biometric\n([\s\S]*?)\n```/)?.[1] ?? ''
    const payload = JSON.parse(fenceBody) as Record<string, unknown>
    expect(payload.captureId).toBe('unknown')
    expect(payload.agentName).toBe('agent')
    expect(payload.state).toBe('stopped')
  })

  test('preserves cause field and id continuity', () => {
    const m = baseMessage({ id: 'a', cause: { kind: 'biometric', name: 'cap_1' } })
    const out = redactBiometricMessages([m])
    expect(out[0]!.id).toBe('a')
    expect(out[0]!.cause).toEqual({ kind: 'biometric', name: 'cap_1' })
  })

  test('does not redact other cause kinds', () => {
    const out = redactBiometricMessages([
      baseMessage({ content: 'kept', cause: { kind: 'script', name: 's', step: 0 } }),
      baseMessage({ content: 'kept three', cause: { kind: 'trigger', name: 't' } }),
    ])
    expect(out[0]!.content).toBe('kept')
    expect(out[1]!.content).toBe('kept three')
  })

  test('does not redact messages without cause', () => {
    const out = redactBiometricMessages([baseMessage({ content: 'plain' })])
    expect(out[0]!.content).toBe('plain')
  })

  test('preserves order and length', () => {
    const ms = [
      baseMessage({ id: 'a', content: 'one' }),
      baseMessage({ id: 'b', content: 'two', cause: { kind: 'biometric', name: 'c' } }),
      baseMessage({ id: 'c', content: 'three' }),
    ]
    const out = redactBiometricMessages(ms)
    expect(out).toHaveLength(3)
    expect(out.map(m => m.id)).toEqual(['a', 'b', 'c'])
    expect(out[0]!.content).toBe('one')
    expect(out[2]!.content).toBe('three')
  })
})
