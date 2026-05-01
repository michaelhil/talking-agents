// Canonical-form name folding — the single source of truth for "do these two
// strings match?" across the geodata system. Used by the local store index,
// the resolver's strict-match check, and any UI search box.
//
// The fold:
//   1. Lowercase
//   2. NFD normalise (decompose accents into base+combining chars)
//   3. Strip combining marks (\p{Diacritic})  — handles é, ü, å (a+ring), etc.
//   4. Apply explicit base-letter folds — ø, æ, ß, etc. are *not* decomposable
//      in Unicode; they need a manual table.
//   5. Collapse whitespace runs to single spaces
//   6. Trim
//
// Examples:
//   "Tromsø"             → "tromso"
//   "Bergen, Norway"     → "bergen, norway"   (punctuation kept — meaningful)
//   "  ENGM  "           → "engm"
//   "São Paulo"          → "sao paulo"
//   "København"          → "kobenhavn"
//
// Punctuation is intentionally preserved: "St. Louis" vs "St Louis" should be
// different until we have evidence they shouldn't.

const BASE_FOLDS: Record<string, string> = {
  'ø': 'o',  // Norwegian/Danish o-slash
  'æ': 'ae', // Norwegian/Danish ash
  'ß': 'ss', // German sharp s
  'đ': 'd',  // Vietnamese/Croatian crossed d
  'ł': 'l',  // Polish stroked l
  'ı': 'i',  // Turkish dotless i
}

const FOLD_RE = new RegExp(`[${Object.keys(BASE_FOLDS).join('')}]`, 'g')

export const canonical = (s: string): string =>
  s.toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(FOLD_RE, (c) => BASE_FOLDS[c] ?? c)
    .replace(/\s+/g, ' ')
    .trim()
