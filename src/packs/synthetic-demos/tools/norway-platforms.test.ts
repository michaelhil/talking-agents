import { describe, expect, test } from 'bun:test'
import { norwayPlatformsTool } from './norway-platforms.ts'

const ctx = { callerId: 'test', callerName: 'test' }

describe('norway_platforms', () => {
  test('no filter returns a map fence with many markers', async () => {
    const res = await norwayPlatformsTool.execute({}, ctx)
    expect(res.success).toBe(true)
    const out = res.data as string
    expect(out).toContain('```map')
    expect(out).toContain('"type": "marker"')
    expect(out).toContain('"icon": "platform"')
    // Sanity: at least 30 entries — the dataset has ~50.
    const markerCount = (out.match(/"type": "marker"/g) ?? []).length
    expect(markerCount).toBeGreaterThanOrEqual(30)
  })

  test('operator filter narrows the result', async () => {
    const res = await norwayPlatformsTool.execute({ filter: 'Equinor' }, ctx)
    expect(res.success).toBe(true)
    const out = res.data as string
    expect(out).toContain('Equinor')
    expect(out).not.toContain('ConocoPhillips')
  })

  test('non-matching filter returns a friendly message', async () => {
    const res = await norwayPlatformsTool.execute({ filter: 'zzzzz-no-match' }, ctx)
    expect(res.success).toBe(true)
    expect(res.data).toMatch(/No platforms matched/)
  })
})
