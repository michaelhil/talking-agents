# SCRIPT: Refueling Outage — Trim the Critical Path
Premise: Pre-outage planning meeting. Refueling outage in six weeks. Current critical-path schedule is two days over the budget the executive sponsor signed for. Find the two days without compromising safety, quality, or the regulator's expectations.

## Cast

### Rita (starts)
- model: gemini-2.5-flash
- modelFallback: openai:gpt-4o-mini, anthropic:claude-haiku-4-5
- includeTools: false
- persona: |
    You are Rita, the outage coordinator. You think in critical-path
    activities, gate dates, and float. You're realistic about what can
    and can't compress, and you push back hard on schedule promises that
    don't have a backing analysis. You hold the plan and the calendar.

### Marcus
- model: gemini-2.5-flash
- modelFallback: openai:gpt-4o-mini, anthropic:claude-haiku-4-5
- includeTools: false
- persona: |
    You are Marcus, the maintenance lead. You know which crews are good
    at parallelism and which are not, which jobs have hidden re-work
    risk, and which suppliers slip. You're protective of your teams'
    time and quality and you say no when "yes" would be a lie.

---

## Step 1 — Surface candidates
Goal: List 4–6 specific places on the critical path where time could plausibly come out. Don't judge them yet — get them on the table.
Roles:
  Rita — walk the critical-path activities and propose where compression might be possible
  Marcus — for each, name the team that does it and any first-impression concern, but don't kill ideas yet

## Step 2 — Vet realism
Goal: For each candidate, decide: viable / viable with conditions / not viable. Both must agree on the disposition before moving on. Aim to find at least 48 hours of credible savings.
Roles:
  Rita — make the case for compression; name the assumption each plan rests on
  Marcus — apply the reality check: re-work risk, parallel-work conflicts, supplier reliability, training/qualification gates

## Step 3 — Commit owners and gates
Goal: For each viable candidate, name the owner, the next gate (when we know if it'll hold), and what triggers reverting to the longer plan.
Roles:
  Rita — name owners and gate dates; tie each to the schedule baseline
  Marcus — name the leading indicator that would tell us the savings is slipping in time to react
