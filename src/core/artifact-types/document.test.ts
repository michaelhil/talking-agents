import { describe, test, expect } from 'bun:test'
import { documentArtifactType } from './document.ts'
import type { Artifact, DocumentBody } from '../types.ts'

// === Test helpers ===

const makeDoc = (blocks: Array<{ id: string; type: string; content: string }> = []): Artifact => ({
  id: 'art-1',
  type: 'document',
  title: 'Test Document',
  body: { blocks } as unknown as Record<string, unknown>,  // DocumentBody → Record<string,unknown> via unknown
  scope: [],
  createdBy: 'test',
  createdAt: 1000,
  updatedAt: 1000,
})

const ctx = { callerId: 'agent-1', callerName: 'TestAgent' }

const getBlocks = (artifact: Artifact): Array<{ id: string; type: string; content: string }> =>
  ((artifact.body as unknown as DocumentBody).blocks ?? []) as Array<{ id: string; type: string; content: string }>

const apply = (artifact: Artifact, body: Record<string, unknown>): Artifact => {
  const result = documentArtifactType.onUpdate!(artifact, { body }, ctx)
  if (!result || !('newBody' in result) || !result.newBody) return artifact
  return { ...artifact, body: result.newBody }
}

// === insert_block ===

describe('document — insert_block', () => {
  test('insert into empty document', () => {
    const art = apply(makeDoc(), { op: 'insert_block', blockType: 'paragraph', content: 'Hello', id: 'b1' })
    const blocks = getBlocks(art)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ id: 'b1', type: 'paragraph', content: 'Hello' })
  })

  test('insert with no afterBlockId → append', () => {
    const art0 = apply(makeDoc(), { op: 'insert_block', blockType: 'paragraph', content: 'First', id: 'b1' })
    const art1 = apply(art0, { op: 'insert_block', blockType: 'paragraph', content: 'Second', id: 'b2' })
    const blocks = getBlocks(art1)
    expect(blocks[0]!.id).toBe('b1')
    expect(blocks[1]!.id).toBe('b2')
  })

  test('insert after specific block', () => {
    const art0 = apply(makeDoc(), { op: 'insert_block', blockType: 'heading1', content: 'Title', id: 'b1' })
    const art1 = apply(art0, { op: 'insert_block', blockType: 'paragraph', content: 'Intro', id: 'b2' })
    const art2 = apply(art1, { op: 'insert_block', blockType: 'heading2', content: 'Section', id: 'b3', afterBlockId: 'b1' })
    const blocks = getBlocks(art2)
    expect(blocks.map(b => b.id)).toEqual(['b1', 'b3', 'b2'])
  })

  test('insert after unknown block → append', () => {
    const art0 = apply(makeDoc(), { op: 'insert_block', blockType: 'paragraph', content: 'A', id: 'b1' })
    const art1 = apply(art0, { op: 'insert_block', blockType: 'paragraph', content: 'B', id: 'b2', afterBlockId: 'unknown' })
    const blocks = getBlocks(art1)
    expect(blocks.map(b => b.id)).toEqual(['b1', 'b2'])
  })

  test('missing blockType → no-op', () => {
    const art = apply(makeDoc(), { op: 'insert_block', content: 'Hello' })
    expect(getBlocks(art)).toHaveLength(0)
  })

  test('auto-generates id when not provided', () => {
    const art = apply(makeDoc(), { op: 'insert_block', blockType: 'paragraph', content: 'Text' })
    const blocks = getBlocks(art)
    expect(blocks[0]!.id).toBeTruthy()
    expect(blocks[0]!.id.length).toBeGreaterThan(8)
  })
})

// === update_block ===

describe('document — update_block', () => {
  test('update content', () => {
    const art0 = apply(makeDoc(), { op: 'insert_block', blockType: 'paragraph', content: 'Original', id: 'b1' })
    const art1 = apply(art0, { op: 'update_block', blockId: 'b1', content: 'Updated' })
    expect(getBlocks(art1)[0]!.content).toBe('Updated')
  })

  test('update type', () => {
    const art0 = apply(makeDoc(), { op: 'insert_block', blockType: 'paragraph', content: 'Text', id: 'b1' })
    const art1 = apply(art0, { op: 'update_block', blockId: 'b1', blockType: 'heading1' })
    expect(getBlocks(art1)[0]!.type).toBe('heading1')
    expect(getBlocks(art1)[0]!.content).toBe('Text')  // content preserved
  })

  test('update non-existent block → no-op', () => {
    const art0 = apply(makeDoc(), { op: 'insert_block', blockType: 'paragraph', content: 'A', id: 'b1' })
    const art1 = apply(art0, { op: 'update_block', blockId: 'missing', content: 'X' })
    expect(getBlocks(art1)).toHaveLength(1)
    expect(getBlocks(art1)[0]!.content).toBe('A')
  })

  test('missing blockId → no-op', () => {
    const art0 = apply(makeDoc(), { op: 'insert_block', blockType: 'paragraph', content: 'A', id: 'b1' })
    const before = getBlocks(art0)
    const art1 = apply(art0, { op: 'update_block', content: 'X' })
    expect(getBlocks(art1)).toEqual(before)
  })
})

// === delete_block ===

describe('document — delete_block', () => {
  test('delete existing block', () => {
    const art0 = apply(makeDoc(), { op: 'insert_block', blockType: 'paragraph', content: 'A', id: 'b1' })
    const art1 = apply(art0, { op: 'insert_block', blockType: 'paragraph', content: 'B', id: 'b2' })
    const art2 = apply(art1, { op: 'delete_block', blockId: 'b1' })
    const blocks = getBlocks(art2)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.id).toBe('b2')
  })

  test('delete non-existent block → no-op', () => {
    const art0 = apply(makeDoc(), { op: 'insert_block', blockType: 'paragraph', content: 'A', id: 'b1' })
    const art1 = apply(art0, { op: 'delete_block', blockId: 'unknown' })
    expect(getBlocks(art1)).toHaveLength(1)
  })

  test('missing blockId → no-op', () => {
    const art0 = apply(makeDoc(), { op: 'insert_block', blockType: 'paragraph', content: 'A', id: 'b1' })
    const art1 = apply(art0, { op: 'delete_block' })
    expect(getBlocks(art1)).toHaveLength(1)
  })
})

// === move_block ===

describe('document — move_block', () => {
  test('move to front (no afterBlockId)', () => {
    let art = makeDoc()
    art = apply(art, { op: 'insert_block', blockType: 'paragraph', content: 'A', id: 'b1' })
    art = apply(art, { op: 'insert_block', blockType: 'paragraph', content: 'B', id: 'b2', afterBlockId: 'b1' })
    art = apply(art, { op: 'insert_block', blockType: 'paragraph', content: 'C', id: 'b3', afterBlockId: 'b2' })
    art = apply(art, { op: 'move_block', blockId: 'b3' })
    expect(getBlocks(art).map(b => b.id)).toEqual(['b3', 'b1', 'b2'])
  })

  test('move after a block', () => {
    let art = makeDoc()
    art = apply(art, { op: 'insert_block', blockType: 'paragraph', content: 'A', id: 'b1' })
    art = apply(art, { op: 'insert_block', blockType: 'paragraph', content: 'B', id: 'b2', afterBlockId: 'b1' })
    art = apply(art, { op: 'insert_block', blockType: 'paragraph', content: 'C', id: 'b3', afterBlockId: 'b2' })
    // Move b1 to after b3 → [b2, b3, b1]
    art = apply(art, { op: 'move_block', blockId: 'b1', afterBlockId: 'b3' })
    expect(getBlocks(art).map(b => b.id)).toEqual(['b2', 'b3', 'b1'])
  })

  test('move non-existent block → no-op', () => {
    const art0 = apply(makeDoc(), { op: 'insert_block', blockType: 'paragraph', content: 'A', id: 'b1' })
    const art1 = apply(art0, { op: 'move_block', blockId: 'unknown' })
    expect(getBlocks(art1).map(b => b.id)).toEqual(['b1'])
  })
})

// === unknown op / no op ===

describe('document — unknown op', () => {
  test('unknown op → no-op (returns current body, no field pollution)', () => {
    const art0 = apply(makeDoc(), { op: 'insert_block', blockType: 'paragraph', content: 'A', id: 'b1' })
    const result = documentArtifactType.onUpdate!(art0, { body: { op: 'fakeop', junk: 'data' } }, ctx)
    expect(result).toBeDefined()
    const newBody = ((result as { newBody: Record<string, unknown> }).newBody) as unknown as DocumentBody
    expect(newBody.blocks).toHaveLength(1)
    expect(newBody.blocks[0]!.id).toBe('b1')
    // Junk field must not appear in body
    expect((newBody as unknown as Record<string, unknown>).junk).toBeUndefined()
  })

  test('no body in updates → returns undefined (default merge)', () => {
    const art = makeDoc()
    const result = documentArtifactType.onUpdate!(art, { title: 'New title' }, ctx)
    expect(result).toBeUndefined()
  })
})

// === formatForContext ===

describe('document — formatForContext', () => {
  test('empty document', () => {
    const result = documentArtifactType.formatForContext!(makeDoc())
    expect(result).toContain('(empty document)')
    expect(result).toContain('Test Document')
  })

  test('includes block content', () => {
    let art = makeDoc()
    art = apply(art, { op: 'insert_block', blockType: 'heading1', content: 'My Title', id: 'b1' })
    art = apply(art, { op: 'insert_block', blockType: 'paragraph', content: 'Some text', id: 'b2', afterBlockId: 'b1' })
    const result = documentArtifactType.formatForContext!(art)
    expect(result).toContain('My Title')
    expect(result).toContain('Some text')
    expect(result).toContain('2 blocks')
  })

  test('includes short block IDs for reference', () => {
    const art = apply(makeDoc(), { op: 'insert_block', blockType: 'paragraph', content: 'Text', id: 'abcdef12-0000-0000-0000-000000000000' })
    const result = documentArtifactType.formatForContext!(art)
    expect(result).toContain('abcdef12')
  })

  test('postSystemMessageOn excludes updated', () => {
    expect(documentArtifactType.postSystemMessageOn).not.toContain('updated')
    expect(documentArtifactType.postSystemMessageOn).toContain('added')
    expect(documentArtifactType.postSystemMessageOn).toContain('removed')
  })
})
