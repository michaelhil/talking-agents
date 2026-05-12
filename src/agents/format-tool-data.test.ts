import { describe, expect, test } from 'bun:test'
import { formatToolDataForLLM } from './evaluation.ts'

describe('formatToolDataForLLM', () => {
  test('passes string data verbatim — no JSON escape clutter', () => {
    const md = '```map\n{ "features": [{ "type": "marker", "lat": 60, "lng": 10 }] }\n```'
    expect(formatToolDataForLLM(md)).toBe(md)
  })

  test('preserves newlines in multi-line strings as real characters', () => {
    const out = formatToolDataForLLM('line one\nline two\nline three')
    expect(out).toBe('line one\nline two\nline three')
    expect(out).not.toContain('\\n')
  })

  test('pretty-prints object data with real newlines and indent', () => {
    const out = formatToolDataForLLM({ a: 1, nested: { b: 'two' } })
    expect(out).toContain('\n')               // real newlines, not escapes
    expect(out).toContain('  "a": 1')         // indent
    expect(out).toContain('  "nested": {')
  })

  test('null/undefined collapse to empty string (not the literal "null")', () => {
    expect(formatToolDataForLLM(null)).toBe('')
    expect(formatToolDataForLLM(undefined)).toBe('')
  })

  test('arrays pretty-print with indent', () => {
    const out = formatToolDataForLLM([{ id: 1 }, { id: 2 }])
    expect(out).toContain('\n')
    expect(out).toContain('"id": 1')
  })

  test('primitives that arent strings serialize cleanly', () => {
    expect(formatToolDataForLLM(42)).toBe('42')
    expect(formatToolDataForLLM(true)).toBe('true')
  })

  test('circular references fall back to String() rather than throwing', () => {
    const circ: Record<string, unknown> = { a: 1 }
    circ.self = circ
    // Don't crash. Output is best-effort — we just want a non-throwing path.
    expect(() => formatToolDataForLLM(circ)).not.toThrow()
  })
})
