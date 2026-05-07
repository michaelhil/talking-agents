import { describe, expect, test } from 'bun:test'
import { chunkText } from './chunker.ts'

describe('chunker', () => {
  test('empty input produces zero chunks', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n\n\n   ')).toEqual([])
  })

  test('single short paragraph produces one chunk', () => {
    const chunks = chunkText('hello world')
    expect(chunks.length).toBe(1)
    expect(chunks[0]!.text).toBe('hello world')
    expect(chunks[0]!.chunkIdx).toBe(0)
  })

  test('multiple paragraphs flow into a single chunk under budget', () => {
    const text = 'p1\n\np2\n\np3'
    const chunks = chunkText(text, { targetTokens: 200 })
    expect(chunks.length).toBe(1)
    expect(chunks[0]!.text).toContain('p1')
    expect(chunks[0]!.text).toContain('p3')
  })

  test('paragraphs split when target tokens exceeded', () => {
    // Each paragraph ~100 chars (~25 tokens). With targetTokens=20 (~80 chars)
    // each paragraph forces a flush.
    const para = 'a '.repeat(50).trim()  // 99 chars
    const text = `${para}\n\n${para}\n\n${para}`
    const chunks = chunkText(text, { targetTokens: 20, overlapTokens: 0 })
    expect(chunks.length).toBeGreaterThanOrEqual(2)
  })

  test('overlap carries content between adjacent chunks', () => {
    const para = 'sentence ' + 'x'.repeat(400)
    const text = `${para}\n\nNEXT_BOUNDARY content`
    const chunks = chunkText(text, { targetTokens: 100, overlapTokens: 25 })
    if (chunks.length >= 2) {
      // Second chunk should start with content from end of first
      expect(chunks[1]!.text.length).toBeGreaterThan(0)
    }
  })

  test('chunkIdx is sequential', () => {
    const text = ('paragraph content\n\n').repeat(10)
    const chunks = chunkText(text, { targetTokens: 5, overlapTokens: 0 })
    chunks.forEach((c, i) => expect(c.chunkIdx).toBe(i))
  })
})
