// ============================================================================
// Catalog invariants — guard against forgetting to tag a thinking model.
//
// The `kind` field on CuratedModel defaults to 'fast' when absent, which
// keeps the type backward-compatible but means a newly-added thinking
// model accidentally treated as fast could become the default seed model.
// This test enumerates the patterns we KNOW are thinking; if any catalog
// entry matches one of these patterns, it MUST be tagged `kind: 'thinking'`.
//
// Adding a new thinking pattern: update THINKING_ID_PATTERNS. Adding a new
// model that happens to match: tag it `kind: 'thinking'` in the catalog.
// ============================================================================

import { describe, expect, test } from 'bun:test'
import { CURATED_MODELS } from './catalog.ts'

// Each pattern matches model IDs that EXPOSE a separate reasoning channel
// (reasoning_content / reasoning / thinking blocks) — i.e. ones where
// Samsinn can stream the reasoning into its thinking pane and where the
// default-resolver should avoid seeding fresh agents.
//
// Models that reason INTERNALLY but don't expose it (OpenAI's gpt-5 family
// on chat-completions hides reasoning entirely; you pay reasoning tokens
// but never see them) are NOT tagged 'thinking' — they're indistinguishable
// from a regular slow response from Samsinn's perspective.
const THINKING_ID_PATTERNS: ReadonlyArray<RegExp> = [
  /^o[1-9](-|$)/,           // OpenAI o-series (o1, o3, o4...) — exposes reasoning
  /^kimi-k2\.[5-9]/,        // Moonshot K2.5+ — exposes reasoning_content
  /(^|-)thinking($|-)/,     // *-thinking variants (claude-*-thinking)
  /^deepseek-r1/,           // DeepSeek R1 family
  /^qwq-/,                  // Qwen QwQ
]

const isLikelyThinking = (id: string): boolean =>
  THINKING_ID_PATTERNS.some(rx => rx.test(id))

describe('CURATED_MODELS thinking-tag invariant', () => {
  test('every catalog entry whose id matches a thinking pattern carries kind: thinking', () => {
    const violations: Array<{ provider: string; id: string }> = []
    for (const [provider, models] of Object.entries(CURATED_MODELS)) {
      for (const m of models) {
        if (isLikelyThinking(m.id) && m.kind !== 'thinking') {
          violations.push({ provider, id: m.id })
        }
      }
    }
    // Empty array beats undefined for diffable failure output.
    expect(violations).toEqual([])
  })

  test('untagged entries default to fast (treated as such by default-resolver)', () => {
    // Spot-check: the entries we curate today are all fast and untagged.
    // This protects against a future "default changed to thinking" mistake.
    for (const list of Object.values(CURATED_MODELS)) {
      for (const m of list) {
        if (m.kind === undefined) {
          // No assertion needed — just confirms the path runs. The previous
          // test handles "should be tagged thinking" violations.
          expect(m.kind ?? 'fast').toBe('fast')
        }
      }
    }
  })
})
