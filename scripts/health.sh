#!/usr/bin/env bash
# Codebase health audit — runs the curated tool set, writes a markdown report
# under .health/, updates .health/last-run.txt with the timestamp + summary.
#
# Verification of which tools are kept lives in .health/spike-results.md.
# Tooling and config rationale: see CLAUDE.md and .dependency-cruiser.cjs.
#
# Run:  bun run health
# Or:   bash scripts/health.sh

set -u  # NOT -e: tools are allowed to exit non-zero (findings are findings)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p .health

DATE="$(date +%F)"
TS="$(date '+%Y-%m-%d %H:%M:%S')"
OUT=".health/${DATE}.md"

# --- Tool runs (capture into temp; we'll fold into the report at the end) ---
TMPDIR_HEALTH="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_HEALTH"' EXIT

run_tsc() {
  bun run check >"$TMPDIR_HEALTH/tsc.txt" 2>&1
  echo "$?"
}

run_typecov() {
  bunx -y type-coverage@latest --strict --ignore-catch --at-least 98 \
    >"$TMPDIR_HEALTH/typecov.txt" 2>&1
  echo "$?"
}

run_escape_hatches() {
  grep -rnE '@ts-(ignore|expect-error|nocheck)|\bas any\b|as unknown as' src/ \
    >"$TMPDIR_HEALTH/escape.txt" 2>&1 || true
  wc -l <"$TMPDIR_HEALTH/escape.txt" | tr -d ' '
}

# --- Anti-pattern grep counters ---
#
# Counters for failure-mode patterns documented in .health/suppressed.md's
# `## anti-patterns` section. Same shape as run_escape_hatches: grep, write
# to temp, return count. The dated report shows each count + the top
# offenders so drift above baseline is obvious.
#
# Each counter EXCLUDES test files — that's where deliberate noise lives
# (mocks, stub error handlers, "trigger the catch" assertions). New
# patterns added here MUST come with a paired suppression entry in
# .health/suppressed.md naming the known false-positives.

run_silent_catches() {
  # `catch {}` or `catch (...) {}` or `catch (...) { /* ignore */ }` in
  # production. Eyeball-grep for the swallow shape; tighter AST analysis
  # would catch more but would also be a separate tool surface to maintain.
  grep -rnE 'catch[[:space:]]*(\([^)]*\))?[[:space:]]*\{[[:space:]]*(/\*[^*]*\*+/[[:space:]]*)?\}' src/ \
    | grep -vE '\.test\.ts:' \
    >"$TMPDIR_HEALTH/silent_catches.txt" 2>&1 || true
  wc -l <"$TMPDIR_HEALTH/silent_catches.txt" | tr -d ' '
}

run_stale_doc_phrases() {
  # Phrases that often outlive their truth. Scope: src/ + README.md only.
  # Excludes .health/ (entries here use these phrases historically and
  # legitimately) and docs/ (changelog-style content has these by design).
  {
    grep -rnE "today'?s behavior|in the current pass|not yet implemented|for now we|FIXME|HACK" src/ 2>/dev/null
    grep -nE "today'?s behavior|in the current pass|not yet implemented|for now we|FIXME|HACK" README.md 2>/dev/null \
      | sed 's|^|README.md:|'
  } >"$TMPDIR_HEALTH/stale_phrases.txt" 2>&1 || true
  wc -l <"$TMPDIR_HEALTH/stale_phrases.txt" | tr -d ' '
}

run_depcruise() {
  bunx -y dependency-cruiser@latest "src/**/*.ts" --output-type err \
    >"$TMPDIR_HEALTH/depcruise.txt" 2>&1
  echo "$?"
}

run_knip() {
  bunx -y knip@latest --reporter compact \
    >"$TMPDIR_HEALTH/knip.txt" 2>&1 || true
}

# --- Run them ---
echo "Running health audit (~30-60s)..."
TSC_RC=$(run_tsc)
TYPECOV_RC=$(run_typecov)
ESCAPE_COUNT=$(run_escape_hatches)
SILENT_CATCH_COUNT=$(run_silent_catches)
STALE_PHRASE_COUNT=$(run_stale_doc_phrases)
DC_RC=$(run_depcruise)
run_knip

# --- Largest source files ---
LARGEST=$(find src -name "*.ts" -not -name "*.test.ts" -exec wc -l {} + 2>/dev/null \
  | sort -rn | head -16)

# --- Extract summary numbers ---
TYPECOV_LINE=$(grep -oE '[0-9]+\.[0-9]+%' "$TMPDIR_HEALTH/typecov.txt" | head -1)
DC_SUMMARY=$(grep -E '^✘|x [0-9]+ dependency violations' "$TMPDIR_HEALTH/depcruise.txt" | head -1)
KNIP_TOTALS=$(grep -E 'Unused (files|exports|dependencies|types)' "$TMPDIR_HEALTH/knip.txt" | head -10)

# --- Write report ---
{
  echo "# Samsinn health — $TS"
  echo
  echo "## Summary"
  echo
  echo "- Typecheck: $([ "$TSC_RC" = 0 ] && echo '✅ pass' || echo '❌ fail')"
  echo "- Type coverage: ${TYPECOV_LINE:-unknown}"
  echo "- Escape hatches (\`as any\` / \`@ts-ignore\` etc): $ESCAPE_COUNT"
  echo "- Silent-catch swallows in production: $SILENT_CATCH_COUNT"
  echo "- Stale documentation phrases: $STALE_PHRASE_COUNT"
  echo "- Dependency-cruiser: ${DC_SUMMARY:-no violations}"
  echo
  echo "## 1. Typecheck (bun run check)"
  echo '```'
  tail -5 "$TMPDIR_HEALTH/tsc.txt"
  echo '```'
  echo
  echo "## 2. Type coverage"
  echo '```'
  tail -3 "$TMPDIR_HEALTH/typecov.txt"
  echo '```'
  echo
  echo "## 3. Escape hatches"
  echo '```'
  if [ "$ESCAPE_COUNT" -gt 0 ]; then
    head -30 "$TMPDIR_HEALTH/escape.txt"
    [ "$ESCAPE_COUNT" -gt 30 ] && echo "... ($ESCAPE_COUNT total)"
  else
    echo "clean"
  fi
  echo '```'
  echo
  echo "## 3b. Anti-patterns (see .health/suppressed.md \`## anti-patterns\`)"
  echo
  echo "### Silent-catch swallows in production ($SILENT_CATCH_COUNT)"
  echo '```'
  if [ "$SILENT_CATCH_COUNT" -gt 0 ]; then
    head -30 "$TMPDIR_HEALTH/silent_catches.txt"
    [ "$SILENT_CATCH_COUNT" -gt 30 ] && echo "... ($SILENT_CATCH_COUNT total)"
  else
    echo "clean"
  fi
  echo '```'
  echo
  echo "### Stale documentation phrases ($STALE_PHRASE_COUNT)"
  echo '```'
  if [ "$STALE_PHRASE_COUNT" -gt 0 ]; then
    head -30 "$TMPDIR_HEALTH/stale_phrases.txt"
    [ "$STALE_PHRASE_COUNT" -gt 30 ] && echo "... ($STALE_PHRASE_COUNT total)"
  else
    echo "clean"
  fi
  echo '```'
  echo
  echo "## 4. Dependency cycles + boundaries (dependency-cruiser)"
  echo '```'
  tail -60 "$TMPDIR_HEALTH/depcruise.txt"
  echo '```'
  echo
  echo "## 5. Dead exports (knip)"
  echo '```'
  head -80 "$TMPDIR_HEALTH/knip.txt"
  echo '```'
  echo
  echo "## 6. Largest source files"
  echo '```'
  echo "$LARGEST"
  echo '```'
} >"$OUT"

# --- Update last-run.txt (one-line summary for SessionStart hook) ---
{
  echo "$TS"
  echo "tsc: $([ "$TSC_RC" = 0 ] && echo pass || echo FAIL) · type-cov: ${TYPECOV_LINE:-?} · escape-hatches: $ESCAPE_COUNT · silent-catches: $SILENT_CATCH_COUNT · stale-phrases: $STALE_PHRASE_COUNT · dep-cruiser: ${DC_SUMMARY:-clean}"
  echo "Full report: $OUT"
} >.health/last-run.txt

echo
echo "Health report → $OUT"
cat .health/last-run.txt
