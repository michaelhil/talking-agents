---
name: health-audit
description: Codebase health audit for Samsinn. Runs scripts/health.sh if stale (>7 days), diffs findings against .health/baseline.md, applies suppressions from .health/suppressed.md, and produces a finding-disposition table. NOT a plan critique tool — for that use claude-toolbox:stress-test. Trigger keywords:/health, "run a health audit", "check for drift", "audit the codebase", "codebase health", "tech debt scan".
---

# Samsinn Health Audit

> **First-time setup:** project-local skills are loaded at Claude Code session start. If `Skill('health-audit')` returns "Unknown skill" right after pulling this repo, **restart Claude Code** to register. The `bun run health` command and pre-push git hook work without skill registration; only the skill-driven flow needs the restart.

Apply this skill for periodic state-of-the-codebase audits. NOT for plan critique (use `claude-toolbox:stress-test` for that). NOT for refactor gating (use `refactor-guarded` for that).

## Flow

### 1. Read state

- `.health/last-run.txt` — when was the last full audit?
- Latest `.health/YYYY-MM-DD.md` — the most recent report.
- `.health/baseline.md` — the anchor.
- `.health/suppressed.md` — known-noise + deferred + anti-patterns sections.
- `CLAUDE.md` — read the `## Rejected refactors` section (grep for that exact heading; if missing, warn the user that suppressions might miss rejected-territory findings).

### 2. Decide whether to re-run

- If `.health/last-run.txt` is missing OR older than 7 days: run `bun run health` and wait. (~30-60s.)
- Otherwise use the existing report.

### 3. Compute the delta

Compare the current report against `.health/baseline.md`:

- Type-coverage % — is it higher or lower than baseline?
- Escape-hatch count — any change?
- Silent-catch count — any change? (See `## anti-patterns` for known-FP exemptions.)
- Stale-doc-phrase count — any change?
- Dep-cruiser violations — any new rule names? Any new file paths?
- Knip unused exports — any new file path entries?
- Largest-files list — any file that crossed 600 LOC since baseline?

### 4. Filter against suppressions

For each delta, check `.health/suppressed.md`:
- If the entry matches a `## known-noise` line → skip silently.
- If it matches a `## deferred` line → skip with a one-line note ("deferred until X").
- If it matches the `## anti-patterns` known-FP list → skip silently (the false positive is documented; the baseline count is the signal).
- Otherwise → carry forward as a real finding.

Also check `CLAUDE.md` `## Rejected refactors` — if a finding's "natural fix" lands in rejected territory (replace lateBinding, split createSystem, MCP/REST parity, revive artifacts), flag it as `rejected-territory` and do NOT propose it.

**Audit-the-audit reminder.** If you find yourself ignoring or routinely suppressing a *class* of findings, that's a signal the check itself may be wrong — the grep too broad, the baseline stale, the categorisation off. The right response is to propose an improvement to `scripts/health.sh` or to the suppression structure, not to silently route more findings into `## known-noise`. The audit machinery is part of the codebase and gets the same scrutiny as the code it scans.

### 5. Produce the report

Print a finding-disposition table. Categories: `real-drift`, `rejected-territory`, `deferred`, `known-noise` (omit known-noise unless user asks for full output).

| Finding | Category | Action option |
|---|---|---|
| (specific file:line or rule + count delta) | real-drift | propose / defer / mark-noise |

### 6. Ask the user via AskUserQuestion

Only for `real-drift` entries. Multi-select: which to act on this session?
- For each acted-on finding: hand off to a normal implementation flow. Do NOT auto-apply.
- For each deferred: append to `.health/suppressed.md` `## deferred` with a revisit date.
- For each marked-noise: append to `.health/suppressed.md` `## known-noise` with a one-line reason.

### 7. Baseline rotation prompt (skip-if)

If any of these is true, prompt the user to consider re-baselining:
- Real-drift count > 1.5 × baseline's total finding count, OR
- Last baseline date is older than 90 days.

If user accepts: `cp .health/<latest>.md .health/baseline.md` and commit.

## Honest limits

- This skill does NOT critique plans (use stress-test).
- This skill does NOT prevent rejected refactors (use refactor-guarded).
- This skill does NOT auto-fix anything. It surfaces and asks.
- The token cost is bounded: only the delta + summary lines are read into context, NOT the full report. If the user wants the full report, they read it from disk directly.

## Common workflow

```bash
# user: /health  (or types "run a health audit")
# skill:
#   1. checks .health/last-run.txt → 8 days old
#   2. runs `bun run health`
#   3. diffs against baseline → 3 new findings
#   4. consults suppressed.md → 1 was already deferred
#   5. presents the 2 real-drift findings as a disposition table
#   6. asks AskUserQuestion: act on which?
```
