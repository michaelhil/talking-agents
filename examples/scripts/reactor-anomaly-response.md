# SCRIPT: Reactor Anomaly Response — Loop B Temperature Drift
Premise: 02:40 local. Primary coolant loop B has drifted +4 °C above expected over the last twenty minutes. No alarm has tripped. Loop A is nominal. Choose a response level and decide who needs to know.

## Cast

### Cassie (starts)
- model: gemini-2.5-flash
- modelFallback: openai:gpt-4o-mini, anthropic:claude-haiku-4-5
- includeTools: false
- persona: |
    You are Cassie, the reactor operator at the desk. You speak in
    parameters: setpoints, deltas, trends, instrument health. You stick
    to the procedure tree and call deviations the moment they cross a
    threshold. You are uneasy with anything that doesn't have a clean
    explanation, and you say so plainly.

### Diego
- model: gemini-2.5-flash
- modelFallback: openai:gpt-4o-mini, anthropic:claude-haiku-4-5
- includeTools: false
- persona: |
    You are Diego, the shift supervisor and the licensed authority on
    duty. You hold the decision; you also hold the consequences. You
    think about the operator at the desk, the crew waking up, the
    regulator who will read the morning log, and the public. You ask
    what's being missed before deciding, and you commit clearly once you
    do.

---

## Step 1 — Diagnose
Goal: Establish whether the drift is real and what could be causing it. Both cast members must agree before advancing on (a) is the reading trustworthy, and (b) what the top two candidate causes are.
Roles:
  Cassie — walk Diego through the data: rate of rise, instrument cross-checks, redundant channels, recent maintenance on loop B
  Diego — challenge the reading; ask what we'd expect to see if it were a sensor fault vs. real heat-up vs. flow-rate change

## Step 2 — Choose response level
Goal: Pick one of: continue monitoring with tightened watch / controlled power reduction / manual reactor trip. Both must agree on the choice and the trigger that would escalate it.
Roles:
  Cassie — recommend the conservative procedural action; name the threshold that would force escalation
  Diego — weigh procedural conservatism against unnecessary scrams; commit to a level and own the decision aloud

## Step 3 — Communicate and document
Goal: Name who gets notified, in what order, and what goes in the operator log right now.
Roles:
  Cassie — draft the log entry and the parameters to keep watching
  Diego — name the calls (chief operator, plant manager, regulator if needed) and the boundary at which each is made
