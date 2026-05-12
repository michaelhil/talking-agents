import { describe, expect, test } from 'bun:test'
import { procedureLookupTool, PWR_EOP_WIKI_URL } from './procedure-lookup.ts'

const ctx = { callerId: 'test', callerName: 'test' }

describe('procedure_lookup', () => {
  test('looks up E-0 and returns three structured fields', async () => {
    const res = await procedureLookupTool.execute({ id: 'E-0' }, ctx)
    expect(res.success).toBe(true)
    const out = res.data as { stepsMarkdown: string; mermaidSource: string; wikiUrl: string }
    expect(out.stepsMarkdown).toContain('Reactor Trip or Safety Injection')
    expect(out.stepsMarkdown).toContain('Step 1:')
    expect(out.stepsMarkdown).toContain('Step 10:')
    expect(out.mermaidSource).toContain('flowchart TD')
    expect(out.mermaidSource).toContain('S1')
    expect(out.wikiUrl).toBe(`${PWR_EOP_WIKI_URL}/blob/main/E-0.md`)
  })

  test('case-insensitive id lookup', async () => {
    const res = await procedureLookupTool.execute({ id: 'e-0' }, ctx)
    expect(res.success).toBe(true)
  })

  test('unknown id returns structured error listing available', async () => {
    const res = await procedureLookupTool.execute({ id: 'X-99' }, ctx)
    expect(res.success).toBe(false)
    expect(res.error).toContain('X-99')
    expect(res.error).toContain('Available')
    expect(res.error).toContain('E-0')
  })

  test('mermaid output renders dispatch branches as external nodes', async () => {
    const res = await procedureLookupTool.execute({ id: 'E-0' }, ctx)
    const out = res.data as { mermaidSource: string }
    // E-0 dispatches to ECA-0.0, ES-0.1, FR-H.1, ES-1.2, E-1, E-2, E-3 — at least
    // a few of these should appear as labeled external nodes.
    expect(out.mermaidSource).toContain('EXT_')
    expect(out.mermaidSource).toContain('classDef external')
  })
})
