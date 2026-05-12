import { describe, expect, test } from 'bun:test'
import {
  procedureLookupTool,
  PWR_EOP_SOURCE_URL,
  PWR_EOP_SOURCE_LABEL,
  type ProcedureLookupResult,
} from './procedure-lookup.ts'

const ctx = { callerId: 'test', callerName: 'test' }

describe('procedure_lookup', () => {
  test('returns structured data + a ready-to-paste mermaid fence', async () => {
    const res = await procedureLookupTool.execute({ id: 'E-0' }, ctx)
    expect(res.success).toBe(true)
    const out = res.data as ProcedureLookupResult
    expect(out.procedureId).toBe('E-0')
    expect(out.title).toContain('Reactor Trip')
    expect(out.appliesTo).toContain('Westinghouse')
    expect(out.steps.length).toBeGreaterThanOrEqual(10)
    expect(out.steps[0]!.title).toBeTruthy()

    // diagramFence is a COMPLETE fenced block — agent pastes verbatim,
    // post-render processor picks it up. Must open and close cleanly.
    expect(out.diagramFence.startsWith('```mermaid\n')).toBe(true)
    expect(out.diagramFence.endsWith('\n```')).toBe(true)
    expect(out.diagramFence).toContain('flowchart TD')
    expect(out.diagramFence).toContain('S1')
  })

  test('source citation uses samsinn:// scheme (self-contained, not fictional)', async () => {
    const res = await procedureLookupTool.execute({ id: 'E-0' }, ctx)
    const out = res.data as ProcedureLookupResult
    expect(out.source.url).toBe(PWR_EOP_SOURCE_URL)
    expect(out.source.url.startsWith('samsinn://')).toBe(true)
    expect(out.source.label).toBe(PWR_EOP_SOURCE_LABEL)
  })

  test('mermaid drops manual-recovery "T" nodes (in step body, not diagram)', async () => {
    const res = await procedureLookupTool.execute({ id: 'E-0' }, ctx)
    const out = res.data as ProcedureLookupResult
    // No T_<n>_<i>_<len> orphan nodes — they used to bloat the diagram.
    expect(out.diagramFence).not.toMatch(/\sT\d+_\d+_\d+\[/)
  })

  test('mermaid dedups external dispatch targets across branches', async () => {
    const res = await procedureLookupTool.execute({ id: 'E-0' }, ctx)
    const out = res.data as ProcedureLookupResult
    // Each EXT_* node is declared exactly once even if multiple branches
    // dispatch to it. Count `EXT_<name>[` declarations vs distinct names.
    const declarations = out.diagramFence.match(/EXT_[A-Za-z0-9_]+\[/g) ?? []
    const uniqueIds = new Set(declarations)
    expect(declarations.length).toBe(uniqueIds.size)
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
})
