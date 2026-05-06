import { describe, test, expect } from 'bun:test'
import { createSerialiseChain } from './serialise-chain.ts'

describe('createSerialiseChain', () => {
  test('runs callbacks in submission order', async () => {
    const chain = createSerialiseChain()
    const order: number[] = []
    const tasks = [0, 1, 2, 3, 4].map(i =>
      chain.run(async () => { order.push(i); return i }),
    )
    const results = await Promise.all(tasks)
    expect(order).toEqual([0, 1, 2, 3, 4])
    expect(results).toEqual([0, 1, 2, 3, 4])
  })

  test('callbacks do not interleave (each awaits the previous)', async () => {
    const chain = createSerialiseChain()
    let inFlight = 0
    let maxConcurrent = 0
    const task = (i: number) => chain.run(async () => {
      inFlight++
      if (inFlight > maxConcurrent) maxConcurrent = inFlight
      await new Promise(r => setTimeout(r, 5))
      inFlight--
      return i
    })
    await Promise.all([task(0), task(1), task(2)])
    expect(maxConcurrent).toBe(1)
  })

  test('rejection in one call does not break subsequent calls', async () => {
    const chain = createSerialiseChain()
    const a = chain.run<number>(async () => { throw new Error('boom') })
    const b = chain.run<number>(async () => 42)
    await expect(a).rejects.toThrow('boom')
    expect(await b).toBe(42)
  })

  test('caller sees its own rejection', async () => {
    const chain = createSerialiseChain()
    const a = chain.run<number>(async () => { throw new Error('first') })
    await expect(a).rejects.toThrow('first')
  })

  test('reset() clears the chain', async () => {
    const chain = createSerialiseChain()
    const slow = chain.run(async () => {
      await new Promise(r => setTimeout(r, 50))
      return 'slow'
    })
    chain.reset()
    // After reset, a new run starts fresh — should resolve well before
    // the slow one finishes.
    const fast = chain.run(async () => 'fast')
    expect(await fast).toBe('fast')
    expect(await slow).toBe('slow')
  })
})
