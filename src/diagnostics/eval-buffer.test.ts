// Pure-TS tests for the eval-buffer. No DOM, no real LLM — exercises
// the event-folding logic with synthesized EvalEvent fixtures, the same
// pattern as the rest of the codebase (no mocks, real interface).

import { describe, test, expect } from 'bun:test'
import { createEvalBuffer } from './eval-buffer.ts'
import type { EvalEvent, OnEvalEvent } from '../core/types/agent-eval.ts'

const evt = (e: EvalEvent): EvalEvent => e

// Lightweight addListener stub: implements the multi-subscriber
// contract used by lateBinding.add. Real impl in main.ts.
const makeAddListener = () => {
  const listeners: OnEvalEvent[] = []
  const addListener = (cb: OnEvalEvent): (() => void) => {
    listeners.push(cb)
    return () => {
      const i = listeners.indexOf(cb)
      if (i >= 0) listeners.splice(i, 1)
    }
  }
  const fire = (agentName: string, event: EvalEvent): void => {
    for (const l of listeners) l(agentName, event)
  }
  return { addListener, fire, listenerCount: () => listeners.length }
}

describe('eval-buffer', () => {
  test('opens record on first event for a traceId', () => {
    const buf = createEvalBuffer()
    const { addListener, fire } = makeAddListener()
    buf.attach(addListener)

    fire('AI', evt({ traceId: 'tr_1', kind: 'context_ready', messages: [], model: 'gpt-4o', toolCount: 5 }))

    // Not yet closed — listRecent returns only closed records.
    expect(buf.listRecent().length).toBe(0)
    // But getByTraceId surfaces the open record.
    const rec = buf.getByTraceId('tr_1')
    expect(rec).toBeTruthy()
    expect(rec?.agentName).toBe('AI')
    expect(rec?.model).toBe('gpt-4o')
    expect(rec?.toolCount).toBe(5)
  })

  test('folds events across a full eval and closes on eval_completed', () => {
    const buf = createEvalBuffer()
    const { addListener, fire } = makeAddListener()
    buf.attach(addListener)

    fire('AI', evt({ traceId: 'tr_2', kind: 'context_ready', messages: [{ role: 'system', content: 'hi' }], model: 'gpt-4o', toolCount: 3 }))
    fire('AI', evt({ traceId: 'tr_2', kind: 'tool_start', tool: 'biometrics_start', callId: '0' }))
    fire('AI', evt({ traceId: 'tr_2', kind: 'tool_result', tool: 'biometrics_start', callId: '0', success: true }))
    fire('AI', evt({ traceId: 'tr_2', kind: 'warning', message: 'slow start' }))
    fire('AI', evt({ traceId: 'tr_2', kind: 'eval_completed', outcome: 'respond' }))

    const rec = buf.getByTraceId('tr_2')
    expect(rec).toBeTruthy()
    expect(rec?.toolCalls).toEqual([{ tool: 'biometrics_start', callId: '0', success: true }])
    expect(rec?.warnings).toEqual(['slow start'])
    expect(rec?.outcome).toBe('respond')
    expect(rec?.messages?.length).toBe(1)
    expect(buf.listRecent().length).toBe(1)
  })

  test('skips events without a traceId', () => {
    const buf = createEvalBuffer()
    const { addListener, fire } = makeAddListener()
    buf.attach(addListener)

    // Out-of-band model_fallback emitted by spawn.ts has no traceId.
    fire('AI', { kind: 'model_fallback', preferred: 'gpt-4o', effective: 'gpt-4o-mini', reason: 'rate_limit' } as EvalEvent)
    expect(buf.listRecent().length).toBe(0)
  })

  test('multiple concurrent traceIds keep separate records', () => {
    const buf = createEvalBuffer()
    const { addListener, fire } = makeAddListener()
    buf.attach(addListener)

    fire('AI', evt({ traceId: 'tr_a', kind: 'tool_start', tool: 'pass', callId: '0' }))
    fire('Observer', evt({ traceId: 'tr_b', kind: 'tool_start', tool: 'biometrics_start', callId: '0' }))
    fire('AI', evt({ traceId: 'tr_a', kind: 'eval_completed', outcome: 'pass' }))
    fire('Observer', evt({ traceId: 'tr_b', kind: 'eval_completed', outcome: 'respond' }))

    const records = buf.listRecent()
    expect(records.length).toBe(2)
    // Newest first.
    expect(records[0]?.agentName).toBe('Observer')
    expect(records[1]?.agentName).toBe('AI')
  })

  test('listRecent filters by agent name', () => {
    const buf = createEvalBuffer()
    const { addListener, fire } = makeAddListener()
    buf.attach(addListener)

    for (let i = 0; i < 3; i++) {
      fire('AI', evt({ traceId: `tr_ai_${i}`, kind: 'eval_completed', outcome: 'respond' }))
    }
    for (let i = 0; i < 2; i++) {
      fire('Observer', evt({ traceId: `tr_obs_${i}`, kind: 'eval_completed', outcome: 'respond' }))
    }

    expect(buf.listRecent({ agent: 'AI' }).length).toBe(3)
    expect(buf.listRecent({ agent: 'Observer' }).length).toBe(2)
    expect(buf.listRecent({ agent: 'nope' }).length).toBe(0)
  })

  test('ring evicts oldest when over capacity', () => {
    const buf = createEvalBuffer({ capacity: 3 })
    const { addListener, fire } = makeAddListener()
    buf.attach(addListener)

    for (let i = 0; i < 5; i++) {
      fire('AI', evt({ traceId: `tr_${i}`, kind: 'eval_completed', outcome: 'respond' }))
    }
    const records = buf.listRecent({ limit: 10 })
    expect(records.length).toBe(3)
    // The 3 newest are kept (tr_4, tr_3, tr_2).
    expect(records.map(r => r.traceId)).toEqual(['tr_4', 'tr_3', 'tr_2'])
  })

  test('limit caps listRecent output', () => {
    const buf = createEvalBuffer()
    const { addListener, fire } = makeAddListener()
    buf.attach(addListener)

    for (let i = 0; i < 10; i++) {
      fire('AI', evt({ traceId: `tr_${i}`, kind: 'eval_completed', outcome: 'respond' }))
    }
    expect(buf.listRecent({ limit: 3 }).length).toBe(3)
  })

  test('clear empties both open and closed sets', () => {
    const buf = createEvalBuffer()
    const { addListener, fire } = makeAddListener()
    buf.attach(addListener)

    fire('AI', evt({ traceId: 'tr_open', kind: 'context_ready', messages: [], model: 'gpt-4o', toolCount: 1 }))
    fire('AI', evt({ traceId: 'tr_closed', kind: 'eval_completed', outcome: 'respond' }))

    expect(buf.getByTraceId('tr_open')).toBeTruthy()
    expect(buf.listRecent().length).toBe(1)
    buf.clear()
    expect(buf.getByTraceId('tr_open')).toBeNull()
    expect(buf.getByTraceId('tr_closed')).toBeNull()
    expect(buf.listRecent().length).toBe(0)
  })

  test('records model_fallback updates the model on the open record', () => {
    const buf = createEvalBuffer()
    const { addListener, fire } = makeAddListener()
    buf.attach(addListener)

    fire('AI', evt({ traceId: 'tr_fb', kind: 'context_ready', messages: [], model: 'gpt-4o', toolCount: 0 }))
    fire('AI', evt({ traceId: 'tr_fb', kind: 'model_fallback', preferred: 'gpt-4o', effective: 'gpt-4o-mini', reason: 'rate_limit' }))
    fire('AI', evt({ traceId: 'tr_fb', kind: 'eval_completed', outcome: 'respond' }))

    const rec = buf.getByTraceId('tr_fb')
    expect(rec?.model).toBe('gpt-4o-mini')                              // updated by model_fallback
    expect(rec?.modelFallback?.preferred).toBe('gpt-4o')
    expect(rec?.modelFallback?.effective).toBe('gpt-4o-mini')
  })

  test('tool_start without tool_result leaves call entry open', () => {
    const buf = createEvalBuffer()
    const { addListener, fire } = makeAddListener()
    buf.attach(addListener)

    fire('AI', evt({ traceId: 'tr_unmatched', kind: 'tool_start', tool: 'biometrics_start', callId: '0' }))
    fire('AI', evt({ traceId: 'tr_unmatched', kind: 'eval_completed', outcome: 'error' }))

    const rec = buf.getByTraceId('tr_unmatched')
    expect(rec?.toolCalls).toEqual([{ tool: 'biometrics_start', callId: '0' }])
    expect(rec?.outcome).toBe('error')
  })

  test('out-of-order results attach to the correct call by callId', () => {
    // Forward-compat for parallel tool calls: two starts for the same tool
    // name, results delivered second-then-first. Pre-callId code matched
    // positionally and would mis-attribute. With callId both results land
    // on their correct entries.
    const buf = createEvalBuffer()
    const { addListener, fire } = makeAddListener()
    buf.attach(addListener)

    fire('AI', evt({ traceId: 'tr_par', kind: 'tool_start', tool: 'web_search', callId: '0' }))
    fire('AI', evt({ traceId: 'tr_par', kind: 'tool_start', tool: 'web_search', callId: '1' }))
    // Result for the SECOND call arrives first.
    fire('AI', evt({ traceId: 'tr_par', kind: 'tool_result', tool: 'web_search', callId: '1', success: true }))
    fire('AI', evt({ traceId: 'tr_par', kind: 'tool_result', tool: 'web_search', callId: '0', success: false, preview: 'rate limit' }))
    fire('AI', evt({ traceId: 'tr_par', kind: 'eval_completed', outcome: 'respond' }))

    const rec = buf.getByTraceId('tr_par')
    expect(rec?.toolCalls.length).toBe(2)
    // Call 0 → failure with preview. Call 1 → success.
    const c0 = rec?.toolCalls.find(t => t.callId === '0')
    const c1 = rec?.toolCalls.find(t => t.callId === '1')
    expect(c0?.success).toBe(false)
    expect(c0?.preview).toBe('rate limit')
    expect(c1?.success).toBe(true)
  })
})
