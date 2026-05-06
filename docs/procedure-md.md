# Procedure Markdown (procmd) — structured procedural knowledge in wikis

Procmd is a markdown convention for storing procedural knowledge — emergency
operating procedures, cockpit checklists, conduct-of-operations manuals, IT
runbooks — as wiki pages that are simultaneously **human-readable**,
**LLM-authorable**, and **machine-traversable** as a guardrail.

Single source of truth: the same markdown document is what a human reads,
what an LLM author writes, and what a parser converts into a step graph an
agent can walk one step at a time. There is no separate "logic language."

Procmd lives **inside existing samsinn wikis** as a convention. A wiki page
is a procedure when its frontmatter declares `type: procedure`. Procedures
can cross-reference each other via standard wikilinks; the resulting page
graph is a hypertext of procedures linked to procedures. With v0.2, edge
labels and frontmatter taxonomy turn that hypertext into a queryable
knowledge graph.

## Status

This document specifies **procmd v0.4**. Samsinn-side runtime support
(executor tool, agent guardrail traversal, render integration) is out of
scope for v0.2; see [Deferred](#deferred--out-of-scope-for-v02) at the
bottom.

**Breaking changes are allowed between v0.x minor versions until v1.0.**
v0.2 introduces small grammar tightenings and is not backward-compatible
with v0.1 — corpora must migrate by bumping `procedure-md: 0.1` to `0.2`
in frontmatter and addressing any validator errors. Migration is
mechanical. After v1.0, breaking changes require a major bump.

## Semantic model

Procmd's primitives come from PROforma, a clinical-guideline modeling
language developed at Cancer Research UK. A procedure decomposes into four
task primitives:

| Primitive | What it is | Procmd surface |
|---|---|---|
| **Plan** | Composite container with sub-tasks, ordering, lifecycle conditions | The procedure itself; nested sub-steps |
| **Decision** | Choice point with candidate branches and rationale | A step whose body lists `→` branches |
| **Action** | Effector — does something in the world | A step body using `Action:` |
| **Enquiry** | Gathers data | A step body using `Check:` |

Primitive inference rules (formalized in v0.2):

- A step with `→` branches is a **Decision**.
- A step body led by `Check:` (or its synonyms) is an **Enquiry**.
- A step body led by `Action:` is an **Action**.
- A step containing sub-steps (`### Step …`) is a **Plan**.
- A step with mixed bodies (e.g. Check informing an immediate Action and
  branches) is treated as a Decision; the Action runs as part of the
  decision evaluation.

Explicit `[<primitive>]` tag in the step heading overrides inference (see
[Step structure](#step-structure)).

See [Semantics for future executors](#semantics-for-future-executors) for
the full lifecycle model. v0.2 does not enforce lifecycle; it defines it
for future runtimes.

## File format

A procedure page has YAML frontmatter, an H1 title (free-form), and one
or more `## Step` headings. Cross-references between steps and between
procedures use standard `[[wikilinks]]`.

### Frontmatter

```yaml
---
type: procedure
procedure-md: 0.4
procedure-id: E-0
title: Reactor Trip or Safety Injection
profile: nuclear-erg
applies-to: Westinghouse 4-loop PWR
category: diagnostic-eop
csfs-monitored: [subcriticality, core-cooling, heat-sink, rcs-integrity, containment, rcs-inventory]
entry-triggers: [reactor-trip-signal, safety-injection-actuation]
---
```

| Field | Required | Meaning |
|---|---|---|
| `type` | yes | Must be `procedure` (see also [Profile pages](#profiles) for `procedure-profile`) |
| `procedure-md` | yes | Spec version. Validators reject mismatched versions |
| `procedure-id` | yes | Stable identifier. **Must match the filename exactly (case-sensitive, excluding `.md`)** |
| `title` | yes | Human-readable title; rendered as the page H1 if no separate H1 is provided |
| `profile` | no | Domain profile name (a `type: procedure-profile` page); enables domain synonyms and taxonomy vocabulary |
| `applies-to` | no | Free-text scope (model, system, audience). Surfaced to readers/agents as context |
| `category` | no | Procedure category. Vocabulary defined by the loaded profile (free-text if no profile loaded) |
| `csfs-monitored` | no | List of Critical Safety Function IDs this procedure monitors. Vocabulary from profile |
| `entry-triggers` | no | List of trigger names that may invoke this procedure. Vocabulary from profile |

Additional unknown frontmatter fields are preserved as page-level
annotations and not errors.

### Step structure

```markdown
## Step <label> [id: <stable-id>]
```

- `<label>` is presentation only — `1`, `3.a`, `3.b.1`, `Continuous` all valid.
- `[id: <stable-id>]` is the **stable identifier** used by all
  cross-references. IDs must be unique within a page. Required.
- **Step ID charset:** `[a-z0-9][a-z0-9-]*` — kebab-case, lowercase, no
  leading hyphen.
- Optional primitive tag: `[id: verify-rx-trip, decision]`. Tags:
  `decision`, `action`, `enquiry`, `plan`. Use only when keyword
  inference is ambiguous.

A procedure must contain **at least one `## Step` heading**. The first
step in document order is the entry point.

Sub-steps use `### Step <label> [id: <id>]`. They are part of the parent
step's Plan and inherit its abort scoping (see
[Semantics for future executors](#semantics-for-future-executors)).

### Body keywords

Each step body is plain markdown. Specific keyword-prefixed lines have
defined semantics:

| Keyword | Primitive role | Meaning |
|---|---|---|
| `Check:` | Enquiry | Gather or verify state |
| `Action:` | Action | Imperative effect — perform this |
| `When:` | lifecycle | Precondition for entry |
| `Until:` | lifecycle | Completion condition (loop exit, plan done) |
| `Abort-if:` | lifecycle | Abort condition |
| `Abort-to:` | lifecycle | Optional abort handler target (default: procedure terminates as discarded) |
| `Within:` | advisory | Time bound. Advisory in v0.2 — authoring intent only; no v0.2 runtime enforces it |
| `Concurrent: <name>` | Plan ref | Spawn sub-Plan in parallel. See [Concurrent placement](#concurrent-placement) |
| `Caution:` | annotation | Operator-facing warning. Renders as a `!!! warning` admonition |
| `Note:` | annotation | Operator-facing note. Renders as a `!!! note` admonition |
| `Because:` | argumentation | Argument for the most recent branch (rationale) |
| `Against:` | argumentation | Argument against the most recent branch |

#### Synonyms for lifecycle keywords

The following surface variants parse to the same primitive role. Use any.

| Author writes | Maps to | Notes |
|---|---|---|
| `If:` | `When:` | Precondition |
| `Once:` | `When:` | Event-trigger phrasing |
| `Unless:` | `When: NOT …` | Negated precondition |
| `While:` | `Until: NOT …` | "Continue while X" = "stop until not X" |
| `As-long-as:` | `Until: NOT …` | Same as While |
| `Bail-if:` | `Abort-if:` | Synonym |

Profiles MAY add domain synonyms but cannot redefine core synonyms.
Using both a keyword and its synonym in the same step (e.g. `When:` and
`If:` together) is a validator warning — likely author confusion.

**Branch-condition prose is unaffected.** `- If pressure drops → #step-2`
is fine; the `If` here is free-text inside a branch condition, not a
step-level keyword.

#### Open-annotation fallback

Any unknown `Foo: value` line is preserved as a step annotation,
surfaced to the agent as context, and ignored by the traversal logic.
New domains add metadata without spec changes.

#### Admonition equivalence

`Caution:` and `Note:` may be written as MkDocs-style admonitions
(`!!! warning` / `!!! note` blocks); the parser recognizes both forms.

#### Concurrent placement

`Concurrent: <name>` may appear at:

- **Procedure level** — between frontmatter and the first step. Spawns
  the named Plan when the procedure begins; default lifecycle is
  scoped to the procedure (terminates with it). Use
  `Concurrent: <name> [independent]` for monitors that outlive the
  procedure (e.g. CSF status trees).
- **Step level** — inside a step body. Spawns the Plan when the step
  becomes in-progress; lifecycle scoped to the step.

`CSF: <name>` (provided by the `nuclear-erg` profile) is a synonym for
procedure-level `Concurrent: <name> [independent]`.

### Branches (Decision primitive)

A step that branches lists candidates as markdown list items containing
`→` (Unicode right-arrow, `U+2192`). A `-` list item is a branch *iff*
it contains exactly one `→`. Items without `→` are step content.

```markdown
## Step 1 [id: verify-rx-trip]
Check: reactor trip breakers OPEN AND rod bottom lights LIT
- [Continue] Verified → #verify-turbine-trip
  Because: rapid neutron flux decrease confirmed
- [Escalate] Not verified → [[FR-S.1]]
  Because: must establish subcriticality before continuing diagnostic flow
```

A branch line containing more than one `→` is a parse error. To express
"do action then transition," use an `Action:` body line followed by a
clean single-arrow branch:

```markdown
Action: if condition X, manually do Y
- Done or X did not apply → #next-step
```

Branch target syntax:

| Form | Meaning |
|---|---|
| `→ #<step-id>` | Same-page step (renders as standard markdown anchor) |
| `→ [[<page>#<step-id>]]` | Step in another procedure |
| `→ [[<page>]]` | Other procedure, enter at first step |
| `→ END` | Procedure terminates here |

A bare `→ <target>` line outside a list is a valid **unconditional
transition** — equivalent to a single-branch list with no condition.
Use sparingly; explicit branches read better.

Wikilinks accept display text: `[[E-3|Establish Heat Sink]]` — the
target is used for resolution, the display text is presentation.
**Display text cannot contain unescaped `|` or `]]`.** Use backslash
escapes: `[[E-3|Heat\|Sink]]`.

`Because:` and `Against:` lines under a branch attach rationale.
Rationale is *unweighted* in v0.2 — agents reason over it as soft
context. Weighted argumentation is deferred.

### Edge type inference (no in-source labels)

Branches do **not** carry explicit edge labels in source. Earlier
versions (v0.2, v0.3) experimented with bracket-prefix labels; they
were dropped in v0.4 because the heuristic-derived labels added little
information beyond what target naming already conveys, and authoring /
visibility cost outweighed the value.

KG exporters compute edge types **at export time** from the target's
shape and the loaded profile's naming patterns:

| Target shape | Inferred edge type |
|---|---|
| `→ #<step-id>` (same page) | `continuesTo` |
| `→ [[<page>]]` matching profile "function-restoration" pattern (e.g. FR-x) | `escalatesTo` |
| `→ [[<page>]]` matching profile "recovery" pattern (e.g. ES-x) | `recoversVia` |
| `→ [[<page>]]` matching profile "extreme-conditions" pattern (e.g. ECA-x) | `fallbacksTo` |
| `→ [[<page>]]` matching profile "diagnostic-eop" pattern (e.g. E-x) | `delegatesTo` |
| `→ END` | `terminates` |

Profiles declare these naming patterns under `## Naming patterns`.
Without a profile, the default is `continuesTo` (same-page) or
`branchesTo` (cross-page, untyped).

**v0.3 in-source `[Label]` syntax is rejected by v0.4 validators.**
Migration: strip `[Label]` from each branch line. The KG produces the
same predicates as before via inference.

### Profiles

A profile is a wiki page that declares domain-specific synonyms and
taxonomy vocabulary. Loaded when a procedure sets `profile: <name>` in
its frontmatter.

#### Profile frontmatter

```yaml
---
type: procedure-profile
procedure-md: 0.4
profile-id: nuclear-erg
title: Nuclear Emergency Response Guidelines profile
---
```

| Field | Required | Meaning |
|---|---|---|
| `type` | yes | Must be `procedure-profile` |
| `procedure-md` | yes | Spec version. Same SUPPORTED_SPEC_VERSION rule as procedures |
| `profile-id` | yes | Stable profile identifier; matches the filename |
| `title` | yes | Human-readable title |

#### Profile body — synonym declarations

```markdown
## Synonyms

- `RNO:` ≡ `- Not <preceding-condition> →` (Westinghouse two-column convention)
- `CSF:` ≡ procedure-level `Concurrent: <name> [independent]`
```

Synonyms are listed as bullet items, each declaring an equivalence. The
left-hand side is a profile keyword; the right-hand side is the canonical
expansion. Synonym names must be unique within a profile.

#### Profile body — taxonomy vocabulary

```markdown
## Taxonomy

### Categories
- diagnostic-eop
- function-restoration
- recovery-procedure
- extreme-conditions

### CSFs
- subcriticality
- core-cooling
- heat-sink
- rcs-integrity
- containment
- rcs-inventory

### Entry triggers
- reactor-trip-signal
- safety-injection-actuation
- ...
```

Vocabulary lists declare valid values for procedure frontmatter
`category:`, `csfs-monitored:`, and `entry-triggers:` fields. The
validator checks procedure taxonomy against the loaded profile's
vocabulary.

#### Profile body — naming-pattern declarations (for edge label inference)

```markdown
## Naming patterns

- `^FR-` → Escalate (function-restoration)
- `^ES-` → Recover
- `^ECA-` → Fallback
- `^E-[0-9]` → Delegate
```

#### Profile namespacing

A procedure loads exactly one profile in v0.2 (multi-profile is
deferred). Profile synonyms cannot redefine core procmd keywords or
core synonyms (see [Synonyms](#synonyms-for-lifecycle-keywords)).

If a profile fails to load (parse error, missing file), validator
behavior degrades to syntactic-only checks with a warning. Other
procedures are not blocked.

## Frontmatter taxonomy

Three optional frontmatter fields turn a procedure into a node in a
classified knowledge graph:

- `category:` — procedure category (e.g. `diagnostic-eop`,
  `function-restoration`, `recovery-procedure`, `extreme-conditions`).
  Vocabulary from profile.
- `csfs-monitored:` — list of CSF IDs this procedure monitors. Vocabulary
  from profile.
- `entry-triggers:` — list of trigger names that may invoke this
  procedure. Vocabulary from profile.

Validator checks values against profile-declared vocabulary if a profile
is loaded. Without a profile, taxonomy fields accept any string.

## Knowledge graph export

The procedure corpus is exportable as JSON-LD for consumption by
graph databases (Neo4j, GraphDB, etc.). The export tool walks the corpus
and emits triples with the following predicates:

| Predicate | Subject → Object |
|---|---|
| `escalatesTo` | procedure → procedure |
| `delegatesTo` | procedure → procedure |
| `recoversVia` | procedure → procedure |
| `fallbacksTo` | procedure → procedure |
| `continuesTo` | step → step |
| `terminates` | step → END (literal) |
| `monitors` | procedure → CSF |
| `monitorsCsf` | procedure → CSF |
| `triggeredBy` | procedure → trigger |
| `belongsToCategory` | procedure → category |
| `hasStep` | procedure → step |
| `branchesTo` | step → step (untyped, fallback) |

JSON-LD output includes a `@context` mapping these predicates to URIs
under a stable placeholder ontology namespace
(`https://samsinn-wikis.github.io/pwr-eops/ontology/v1#`). The URI need
not resolve in v0.2; it serves as a stable identifier for the predicate
set. Formal SHACL/OWL schema is deferred.

A reference exporter for the `pwr-eops` corpus lives in that repo as
`scripts/export-kg.ts` (single TS file, no deps, runs under Bun).

## The single-source-of-truth invariant

Any proposed addition to the spec must pass this test: **a domain
expert who has never seen the parser must be able to write the value
naturally and have it parse**. Keyword names are English; values are
prose.

```yaml
When: reactor trip OR safety injection actuated     # ✅ passes — natural
When: { OR: [{ event: "trip" }, { event: "si" }] }  # ❌ fails — code leak
```

The parser cares about structural keywords. Values are prose, semantic
interpretation is the agent's job (or a tool call's, for numeric guards).
This is what keeps procmd from drifting into YAML-in-markdown.

## Semantics for future executors

This section defines the lifecycle and primitive semantics that a
runtime executor MUST implement. **v0.2 does not enforce these
semantics.** They are normative for v0.3+ runtime work and let authors
write `When:` / `Until:` / `Abort-if:` knowing what they will mean.

### Task lifecycle

Each step is a task with one of four states:

- **dormant** — not yet entered (default initial state)
- **in-progress** — currently being evaluated / executed
- **completed** — successfully finished; control passes to a branch target
- **discarded** — aborted (via `Abort-if:` triggered, or parent procedure
  discarded)

State transitions:

- dormant → in-progress: when the step is reached AND `When:` (if
  present) evaluates true
- in-progress → completed: when `Until:` (if present) becomes true, OR
  when a branch is taken
- in-progress → discarded: when `Abort-if:` becomes true
- in-progress → in-progress (no change): when `When:` is false at entry
  (executor blocks until precondition holds, or skips per executor
  policy)

### Abort handling

When `Abort-if:` triggers:

- Default: the entire procedure is discarded; control returns to the
  caller (or terminates if there is no caller).
- If `Abort-to: <target>` is set, control transfers to that target
  (a step ID or wikilink). The target step starts in dormant state.

### Sub-step inheritance

Sub-steps are part of their parent step's Plan:

- **Parent's `Abort-if:` cascades.** If parent triggers Abort-if, all
  in-progress sub-steps transition to discarded.
- **Parent's `Until:` is independent.** Parent completion does not auto-
  complete unfinished sub-steps; the executor must check sub-step
  completion before parent.
- **Sub-step's own `When:` / `Until:`** are local to the sub-step.
- **Concurrent (step-level)** spawned by a parent step is bound to the
  parent's lifecycle: parent discarded → concurrent discarded.
- **Concurrent (procedure-level, default)** is bound to the procedure's
  lifecycle.
- **Concurrent (procedure-level, `[independent]`)** outlives the
  procedure; only terminates when its own `Until:` is met or when the
  operator explicitly terminates the emergency response.

### Validator scope vs runtime scope

- **v0.2 validator** checks structural correctness only (frontmatter
  shape, step IDs unique, branch syntax, cross-page resolution,
  reachability, taxonomy against profile vocabulary, edge label
  vocabulary).
- **v0.2 validator does NOT check** lifecycle semantics, `When:` / `Until:`
  truth at any execution moment, time bounds, or cascade propagation.
- A v0.3+ runtime is the consumer of these semantics.

## Validation

A procmd validator checks **structural** correctness, not semantic
correctness. Semantic checks ("does this step actually handle the case
the source branch claims") are LLM-driven and out of scope for v0.2
validation gates.

A v0.2 validator must check:

- Frontmatter shape and required fields
- `procedure-md:` version equals `SUPPORTED_SPEC_VERSION`
- `procedure-id` matches the filename exactly (case-sensitive)
- Procedure has ≥ 1 `## Step` heading
- Step heading shape; stable IDs unique within a page
- Step ID charset: `[a-z0-9][a-z0-9-]*`
- Body keyword recognition (unknown keywords → annotations, not errors)
- Synonym recognition (`If:` parses as `When:`, etc.)
- Branch syntax: every `→` resolves to bare fragment, wikilink, or `END`
- Branch lines contain exactly one `→` (multi-arrow is a parse error)
- Cross-page link resolution: target page exists in the corpus; target
  step ID exists in the target page
- Reachability: orphan steps (no branch reaches them); branches whose
  targets are unreachable in their own page
- Procedure-level `Concurrent:` placed between frontmatter and first step
- Edge labels (when present) match the canonical vocabulary; unknown
  labels produce warnings
- Frontmatter taxonomy values match profile vocabulary if a profile is
  loaded successfully
- Profile resolution: declared synonyms recognized; profile load failures
  produce warnings, not blocking errors

A reference validator for the `pwr-eops` corpus lives in that repo as
`validate.ts` (~580 LOC, single file, no dependencies, runs under Bun).

## Reference rendering: visibility controls

This section describes a **recommended** rendering convention. It is not
part of the format spec — procmd parsers and KG exporters never need it.
It documents how the canonical pwr-eops renderer surfaces optional
content to readers, so other procmd wikis can adopt a compatible UX if
they wish.

### Toggleable categories

| Category | Source element | CSS class on render | Default |
|---|---|---|---|
| Rationale | `Because:` / `Against:` lines | `procmd-rationale` | Visible |
| Step ID suffix | Visible code-span suffix on step heading | `procmd-step-id-suffix` | Visible |

Reserved for future tag-declaration round (no toggle yet):
`procmd-tag` — equipment / signal / setpoint references.

CSF declarations, Cautions, and Notes are not togglable in the
recommended render — they carry operational importance.

### Mechanism

1. **Build-time wrap.** The renderer wraps source elements in classed
   inline elements (e.g. `<span class="procmd-edge-label">[Continue]</span>`).
   Source markdown is untouched; the wrapping happens during the
   build-time transform from source to enriched markdown.
2. **CSS defaults.** A small CSS file sets default display per class
   (e.g. `.procmd-edge-label { display: none }`).
3. **Override classes on `<html>`.** A small JS bundle reads user
   preferences from localStorage and applies override classes to
   `<html>` (e.g. `<html class="show-edge-labels">`). CSS rules like
   `html.show-edge-labels .procmd-edge-label { display: inline }`
   flip visibility per category.
4. **Eye-icon popover.** A button in the site header opens a popover
   with per-category toggles. Toggles update localStorage and apply
   classes immediately.
5. **FOUC prevention.** A small synchronous `<script>` in the page
   `<head>` reads localStorage and applies override classes before
   first paint, so user-overridden categories never flash.

The mechanism is purely browser-side. The procmd source is canonical;
no parallel rendered files exist. Reference implementation lives in
`samsinn-wikis/pwr-eops` (`overrides/visibility.css`, `overrides/visibility.js`,
`overrides/main.html` FOUC `<script>`, plus build-time wrapping in
`scripts/render-procmd.ts`).

Other consumers (samsinn UI, future llm-wiki-skills bootstrap, custom
renderers) may implement compatible behavior using the same CSS class
names.

## Versioning policy

Until v1.0, breaking changes between minor versions are allowed.
Migration is mechanical (bump frontmatter version, address validator
errors). After v1.0, breaking changes require a major bump; deprecation
of features must be announced one minor version before removal.

## Authoring guidance

- **Stable IDs are forever.** Once a step has `[id: verify-rx-trip]`,
  renaming it breaks every cross-reference. Use kebab-case slugs that
  describe the step's purpose, not its position.
- **Step labels are presentation.** `## Step 3.a` is fine; the label is
  not the identity. Cross-references never use the label.
- **Branches need conditions.** `- Verified → #step-2` reads naturally;
  `- → #step-2` is malformed (no condition). The condition is what an
  agent or operator evaluates.
- **One Check or one Action per step is preferred.** Mixed bodies are
  valid where the Check directly informs an immediate Action and the
  branches that follow.
- **Multi-arrow branches are not allowed.** To express "do action then
  transition," use an `Action:` body line plus a clean single-arrow
  branch, not `- <cond> → <action>; → <target>`.
- **`Because:` and `Against:` belong under the branch they justify.** They
  attach to the most recent branch list item.
- **Concurrent is for monitoring, not parallelism.** Use `Concurrent:`
  to spawn a status-tree-style background Plan. Do not use it to
  decompose one logical step into fan-out work — that's just sub-steps.
- **Don't pre-flatten branches into prose.** "If X then go to step 4,
  otherwise step 5" is a Decision in prose — author it as a branch list
  so the parser sees the structure.
- **Use `RNO:` when the Westinghouse two-column convention is the
  natural fit** (one positive path, one negative path with a single
  fallback). Use explicit `- Not <X> →` when the negation is one branch
  among several or carries its own rationale.
- **Profile or no profile.** Procedures without a `profile:` field are
  fully valid; profiles enable domain synonyms and taxonomy vocabulary.

## Example: a minimal procedure

```markdown
---
type: procedure
procedure-md: 0.4
procedure-id: example-engine-restart
title: Engine Restart After In-Flight Shutdown
profile: aviation-qrh
category: emergency-checklist
---

# Engine Restart After In-Flight Shutdown

## Step 1 [id: confirm-shutdown]
Check: affected engine N1 < 10% AND throttle at IDLE
Caution: confirm correct engine before any action
- Confirmed → #attempt-restart
- Not confirmed → [[engine-fire-checklist]]

## Step 2 [id: attempt-restart]
Action: ENGINE START switch — IGN/START
Within: 30s of stable airspeed
- Started (N1 increasing, EGT rising within limits) → #stabilize
- Not started → #abandon-restart
  Because: continued attempts risk hot start damage

## Step 3 [id: stabilize]
Action: monitor N1 to idle, EGT within limits
Until: stable idle for 60s
- Stable → END
- Unstable → #abandon-restart

## Step 4 [id: abandon-restart]
Action: ENGINE START switch — OFF
Note: continue single-engine operations
→ END
```

## Deferred / Out of scope for v0.2

The following are deferred to v0.3 or later:

### Samsinn-side runtime
- **Procedure executor as agent tool.** `procedure_start(name)` /
  `procedure_step(branch)` API. Agent only sees current step + valid
  branches (the actual guardrail).
- **Lifecycle enforcement.** Implementation of the
  [Semantics for future executors](#semantics-for-future-executors)
  section.
- **Procedure parse cache.** In-memory, event-driven invalidation on
  `wiki_changed`.
- **Render integration.** Samsinn UI rendering of `[[wikilinks]]` and
  same-page anchors when displaying a procedure page in chat or panel.
- **`samsinn-handbook` wiki.** A wiki holding the rendered procmd spec
  plus general samsinn introspection content, linked at agent startup.

### Spec extensions
- **Equipment / signal / setpoint declarations** at step level
  (`Signals:`, `Equipment:`, `Setpoints:`) and a `tag-catalog` page type
  with tag definitions and units. Enables linking procedures to live
  simulator data.
- **UI hide mechanism** for tag declarations and `Because:` rationale
  (operator vs reviewer vs engineering views via render-time class
  wrapping and JS toggle).
- **Weighted argumentation.** `Because (strong):` / `Because (weak):`
  with a defined recommendation rule.
- **Cross-wiki references.** Syntax for linking procedures across
  multiple wikis (e.g. `[[<wiki-id>:<page>#<step>]]`); requires
  cross-wiki indexing.
- **Hard time-bound enforcement.** `Within:` becomes runtime-checked
  rather than advisory.
- **`By: <role>` role assignment.** Operator vs supervisor vs agent —
  needed for ATC ConOps and CRM-style procedures.
- **Multi-profile loading.** A procedure loading more than one profile.
- **Mermaid auto-generation.** Render the step graph of a procedure as
  a Mermaid flowchart.

### Validation enhancements
- **Graph-level semantic checks.** Does the target step actually handle
  the case the source branch claims? LLM-driven, advisory only.

### Tooling and ecosystem
- **`llm-wiki-skills` extension.** A new `wiki-procedure` skill
  authoring procedure pages from raw sources; quality-rule extension
  for the procmd validator.
- **Profile mechanism generalization.** Cross-wiki shared profiles.
- **Validator distribution.** Reference validator currently lives
  per-wiki; if samsinn ships a procedure executor, the same parser must
  serve both.
- **Formal SHACL/OWL ontology** for the KG export predicates.

### Acknowledged debt
- **LLM-authored procedure correctness.** Structural validation (parser
  green) does not imply operational correctness. For high-stakes
  domains, a human-review workflow on top of the validator is needed.

---

*procmd v0.4 — last reviewed 2026-05-06.*
