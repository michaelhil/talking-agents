// Synchronous context-window lookup tests. The async path that hits
// /api/show or /models is not exercised here — getContextWindowSync is
// the hot path (called by ai-agent factory on every spawn) and the one
// that drives the UI's per-message %-of-context indicator.

import { describe, test, expect } from 'bun:test'
import { getContextWindowSync } from './context-window.ts'

describe('getContextWindowSync', () => {
  test('exact-match curated entry: gpt-4o', () => {
    const info = getContextWindowSync('openai', 'gpt-4o')
    expect(info.source).toBe('known_table')
    expect(info.contextMax).toBe(128_000)
  })

  test('exact-match gpt-5 family: gpt-5.4-mini', () => {
    const info = getContextWindowSync('openai', 'gpt-5.4-mini')
    expect(info.source).toBe('known_table')
    expect(info.contextMax).toBe(400_000)
  })

  test('exact-match gpt-5-nano: smaller window', () => {
    const info = getContextWindowSync('openai', 'gpt-5-nano')
    expect(info.contextMax).toBe(200_000)
  })

  test('exact-match o-series: o3-mini', () => {
    const info = getContextWindowSync('openai', 'o3-mini')
    expect(info.contextMax).toBe(200_000)
  })

  test('OpenAI dated snapshot resolves via longest-prefix fallback', () => {
    // OpenAI ships dated snapshots constantly. Without the prefix matcher
    // these all show as '?%' in the UI's per-message token indicator
    // — exactly the bug that surfaced in prod when the UI couldn't
    // resolve gpt-5.4-mini's snapshot.
    const info = getContextWindowSync('openai', 'gpt-5.4-mini-2026-03-17')
    expect(info.source).toBe('known_table')
    expect(info.contextMax).toBe(400_000)
  })

  test('longest-prefix match: gpt-5.1-mini-2026-04-01 picks the gpt-5.1-mini entry, not gpt-5.1', () => {
    // The matcher must prefer the most specific prefix. gpt-5.1 and
    // gpt-5.1-mini are different entries (both 400k in this case, but
    // the rule matters for gpt-5-nano which is 200k vs gpt-5 which is
    // 400k).
    const info = getContextWindowSync('openai', 'gpt-5.1-mini-2026-04-01')
    expect(info.contextMax).toBe(400_000)
  })

  test('longest-prefix distinguishes gpt-5-nano (200k) from gpt-5 (400k)', () => {
    const nano = getContextWindowSync('openai', 'gpt-5-nano-2026-08-07')
    expect(nano.contextMax).toBe(200_000)
    const full = getContextWindowSync('openai', 'gpt-5-2026-08-07')
    expect(full.contextMax).toBe(400_000)
  })

  test('unknown model resolves to unknown (not silently fabricated)', () => {
    const info = getContextWindowSync('openai', 'gpt-99-from-the-future')
    expect(info.source).toBe('unknown')
    expect(info.contextMax).toBe(0)
  })

  test('prefix fallback is OpenAI-only — other providers keep exact match', () => {
    // Anthropic / Gemini / Groq don't ship dated snapshots the same way,
    // and their models have stable names. Restricting the prefix matcher
    // to OpenAI prevents false matches like `claude-haiku-4-5-something`
    // accidentally getting Anthropic's 200k.
    const info = getContextWindowSync('anthropic', 'claude-haiku-4-5-something')
    expect(info.source).toBe('unknown')
  })
})
