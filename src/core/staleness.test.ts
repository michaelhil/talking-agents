import { describe, test, expect } from 'bun:test'
import { findStalestAgent } from './staleness.ts'
import type { Message } from './types.ts'

const msg = (senderId: string, content = 'hi'): Message => ({
  id: crypto.randomUUID(),
  senderId,
  content,
  timestamp: Date.now(),
  type: 'chat',
})

describe('findStalestAgent', () => {
  test('returns undefined when participating set is empty', () => {
    const messages = [msg('a'), msg('b')]
    expect(findStalestAgent(messages, new Set())).toBeUndefined()
  })

  test('returns the only participant when one agent', () => {
    const messages = [msg('a'), msg('b')]
    expect(findStalestAgent(messages, new Set(['a']))).toBe('a')
  })

  test('returns agent who has never spoken (maximally stale)', () => {
    const messages = [msg('a'), msg('b')]
    expect(findStalestAgent(messages, new Set(['a', 'b', 'c']))).toBe('c')
  })

  test('returns agent with oldest last message', () => {
    // C spoke first, then D, then A — C is stalest
    const messages = [msg('c'), msg('d'), msg('a')]
    expect(findStalestAgent(messages, new Set(['a', 'c', 'd']))).toBe('c')
  })

  test('handles agents with multiple messages — uses last occurrence', () => {
    // A spoke, then B, then A again — B is stalest (A spoke more recently)
    const messages = [msg('a'), msg('b'), msg('a')]
    expect(findStalestAgent(messages, new Set(['a', 'b']))).toBe('b')
  })

  test('excludes specified agent', () => {
    const messages = [msg('c'), msg('b'), msg('a')]
    // C is stalest but excluded — B is next
    expect(findStalestAgent(messages, new Set(['a', 'b', 'c']), 'c')).toBe('b')
  })

  test('returns undefined when all participants are excluded', () => {
    const messages = [msg('a')]
    expect(findStalestAgent(messages, new Set(['a']), 'a')).toBeUndefined()
  })

  test('handles empty message array — returns any participant (never spoken)', () => {
    const result = findStalestAgent([], new Set(['a', 'b']))
    expect(result).toBeDefined()
    expect(['a', 'b']).toContain(result)
  })

  test('non-participating agents are ignored', () => {
    // D spoke longest ago but is not participating
    const messages = [msg('d'), msg('a'), msg('b'), msg('c')]
    expect(findStalestAgent(messages, new Set(['a', 'b', 'c']))).toBe('a')
  })

  test('pass messages count for staleness', () => {
    const passMsg: Message = { ...msg('a'), type: 'pass', content: '[pass] nothing to add' }
    // A passed (most recent), B spoke before — A is fresher, B is stalest
    const messages = [msg('b'), passMsg]
    expect(findStalestAgent(messages, new Set(['a', 'b']))).toBe('b')
  })

  test('worked example from design doc: C-A-B-D order', () => {
    // History: C, D, A, then B and D post new messages
    const messages = [msg('c'), msg('d'), msg('a'), msg('b'), msg('d')]
    const participating = new Set(['a', 'b', 'c', 'd'])

    // C is stalest (index 0)
    expect(findStalestAgent(messages, participating)).toBe('c')

    // After C responds: C,D,A,B,D,C — exclude C, A is stalest (index 2)
    const afterC = [...messages, msg('c')]
    expect(findStalestAgent(afterC, participating, 'c')).toBe('a')

    // After A responds: C,D,A,B,D,C,A — exclude A, B is stalest (index 3)
    const afterA = [...afterC, msg('a')]
    expect(findStalestAgent(afterA, participating, 'a')).toBe('b')

    // After B responds: C,D,A,B,D,C,A,B — exclude B, D is stalest (index 4)
    const afterB = [...afterA, msg('b')]
    expect(findStalestAgent(afterB, participating, 'b')).toBe('d')
  })
})
