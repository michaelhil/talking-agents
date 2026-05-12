import { describe, expect, test } from 'bun:test'
import { vatsimArrivalsTool } from './vatsim-arrivals.ts'

const ctx = { callerId: 'test', callerName: 'test' }

describe('vatsim_arrivals (offline-safe assertions)', () => {
  test('rejects malformed ICAO', async () => {
    const res = await vatsimArrivalsTool.execute({ icao: 'EGL' }, ctx)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/4-letter/)
  })

  test('rejects empty ICAO', async () => {
    const res = await vatsimArrivalsTool.execute({ icao: '' }, ctx)
    expect(res.success).toBe(false)
  })

  test('rejects non-string ICAO', async () => {
    const res = await vatsimArrivalsTool.execute({ icao: 42 }, ctx)
    expect(res.success).toBe(false)
  })

  // Live datafeed test is intentionally not run in unit tests — it would
  // hit the network and flake when VATSIM is down. The scenario integration
  // test covers the live path via a stubbed fetch.
})
