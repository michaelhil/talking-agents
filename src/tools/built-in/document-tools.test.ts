import { describe, test, expect } from 'bun:test'
import { parseStreamedBlocks } from './document-tools.ts'

describe('parseStreamedBlocks', () => {
  test('empty string → empty array', () => {
    expect(parseStreamedBlocks('')).toEqual([])
  })

  test('whitespace-only → empty array', () => {
    expect(parseStreamedBlocks('   \n  \n')).toEqual([])
  })

  test('plain line → paragraph', () => {
    const result = parseStreamedBlocks('Hello world')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ type: 'paragraph', content: 'Hello world' })
  })

  test('# prefix → heading1', () => {
    const result = parseStreamedBlocks('# Main Title')
    expect(result[0]).toEqual({ type: 'heading1', content: 'Main Title' })
  })

  test('## prefix → heading2', () => {
    const result = parseStreamedBlocks('## Section')
    expect(result[0]).toEqual({ type: 'heading2', content: 'Section' })
  })

  test('### prefix → heading3', () => {
    const result = parseStreamedBlocks('### Sub-section')
    expect(result[0]).toEqual({ type: 'heading3', content: 'Sub-section' })
  })

  test('> prefix → quote', () => {
    const result = parseStreamedBlocks('> This is a quote')
    expect(result[0]).toEqual({ type: 'quote', content: 'This is a quote' })
  })

  test('- prefix → list', () => {
    const result = parseStreamedBlocks('- List item')
    expect(result[0]).toEqual({ type: 'list', content: 'List item' })
  })

  test('* prefix → list', () => {
    const result = parseStreamedBlocks('* Another item')
    expect(result[0]).toEqual({ type: 'list', content: 'Another item' })
  })

  test('code block with fences → code', () => {
    const result = parseStreamedBlocks('```\nconst x = 1\nconst y = 2\n```')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ type: 'code', content: 'const x = 1\nconst y = 2' })
  })

  test('code block with language tag — fence still closes it', () => {
    const result = parseStreamedBlocks('```typescript\nconst x: number = 1\n```')
    expect(result[0]!.type).toBe('code')
    expect(result[0]!.content).toContain('const x')
  })

  test('multiple blocks in sequence', () => {
    const text = '# Title\n## Section\nParagraph text\n- Item one\n- Item two'
    const result = parseStreamedBlocks(text)
    expect(result).toHaveLength(5)
    expect(result[0]).toEqual({ type: 'heading1', content: 'Title' })
    expect(result[1]).toEqual({ type: 'heading2', content: 'Section' })
    expect(result[2]).toEqual({ type: 'paragraph', content: 'Paragraph text' })
    expect(result[3]).toEqual({ type: 'list', content: 'Item one' })
    expect(result[4]).toEqual({ type: 'list', content: 'Item two' })
  })

  test('blank lines between blocks are skipped', () => {
    const text = '# Title\n\nParagraph\n\n## Section'
    const result = parseStreamedBlocks(text)
    expect(result).toHaveLength(3)
    expect(result.map(b => b.type)).toEqual(['heading1', 'paragraph', 'heading2'])
  })

  test('unclosed code block — flushed as code', () => {
    const text = '```\ncode without closing fence'
    const result = parseStreamedBlocks(text)
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe('code')
    expect(result[0]!.content).toBe('code without closing fence')
  })

  test('text before and after code block', () => {
    const text = 'Before\n```\ncode\n```\nAfter'
    const result = parseStreamedBlocks(text)
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ type: 'paragraph', content: 'Before' })
    expect(result[1]).toEqual({ type: 'code', content: 'code' })
    expect(result[2]).toEqual({ type: 'paragraph', content: 'After' })
  })
})
