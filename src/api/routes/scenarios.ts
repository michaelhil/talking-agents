// ============================================================================
// Scenario REST routes.
//
// GET    /api/scenarios                     → catalog: every loaded scenario
// GET    /api/scenarios/:pack/:name         → full source + parsed metadata
// POST   /api/scenarios/:pack/:name/run     → start a run; body { allowInstall?: boolean }
// POST   /api/scenarios/runs/:runId/advance → user clicked Next on a guide
// POST   /api/scenarios/runs/:runId/stop    → cancel
// GET    /api/scenarios/runs/:runId         → run state
// POST   /api/scenarios/reload              → rescan installed packs
//
// Pack-install consent: install-pack ops inside a scenario require the run
// caller to pass `allowInstall: true`. The UI sets this only after the
// share-link consent dialog is accepted. Anonymous visitors can run any
// scenario — the consent gate is for the install side-effect, not the run
// itself.
// ============================================================================

import { json, errorResponse, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'

export const scenarioRoutes: ReadonlyArray<RouteEntry> = [
  // --- Catalog ---
  {
    method: 'GET',
    pattern: /^\/api\/scenarios$/,
    handler: (_req, _match, { system }) =>
      json({
        scenarios: system.scenarioStore.list().map(s => ({
          id: s.id,
          pack: s.pack,
          name: s.name,
          title: s.title,
          description: s.description ?? '',
          // 'tutorial' is the conservative default for uncategorized entries.
          // Demos panel uses this to group cards (Demos / Tutorials / Onboarding).
          category: s.category ?? 'tutorial',
          opCount: s.ops.length,
          // De-duplicated list of op kinds present in the scenario. The
          // share-link consent dialog uses this to decide whether to surface
          // an "allow pack installs" checkbox — far more reliable than
          // regex-matching the raw markdown source.
          opKinds: [...new Set(s.ops.map(o => o.kind))],
        })),
      }),
  },
  {
    method: 'POST',
    pattern: /^\/api\/scenarios\/reload$/,
    handler: async (_req, _match, { system, broadcast }) => {
      const ids = await system.scenarioStore.reload()
      broadcast({ type: 'scenario_catalog_changed' })
      return json({ loaded: ids.length, ids })
    },
  },

  // --- Run lifecycle ---
  // Order matters in the route table — the more-specific runs/:id matchers
  // come before the generic /:pack/:name matcher so 'runs' isn't parsed as
  // a pack namespace.
  {
    method: 'GET',
    pattern: /^\/api\/scenarios\/runs\/([^/]+)$/,
    handler: (_req, match, { system }) => {
      const runId = decodeURIComponent(match[1]!)
      const run = system.scenarioRunner.getRun(runId)
      if (!run) return errorResponse(`run ${runId} not found`, 404)
      return json({
        runId: run.runId,
        scenarioId: run.scenarioId,
        title: run.title,
        status: run.status,
        currentOpIndex: run.currentOpIndex,
        totalOps: run.totalOps,
        startedAt: run.startedAt,
        ...(run.endedAt ? { endedAt: run.endedAt } : {}),
        ...(run.failureReason ? { failureReason: run.failureReason } : {}),
        ...(run.awaitingWait ? { awaitingWait: run.awaitingWait } : {}),
      })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/scenarios\/runs\/([^/]+)\/advance$/,
    handler: (_req, match, { system }) => {
      const runId = decodeURIComponent(match[1]!)
      const result = system.scenarioRunner.advance(runId)
      if (!result.ok) return errorResponse(result.reason ?? 'advance failed', 400)
      return json({ advanced: true })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/scenarios\/runs\/([^/]+)\/stop$/,
    handler: (_req, match, { system }) => {
      const runId = decodeURIComponent(match[1]!)
      const result = system.scenarioRunner.stop(runId)
      if (!result.ok) return errorResponse(result.reason ?? 'stop failed', 400)
      return json({ stopped: true })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/scenarios\/([^/]+)\/([^/]+)\/run$/,
    handler: async (req, match, { system }) => {
      const pack = decodeURIComponent(match[1]!)
      const name = decodeURIComponent(match[2]!)
      const id = `${pack}/${name}`
      const scenario = system.scenarioStore.get(id)
      if (!scenario) return errorResponse(`scenario ${id} not found`, 404)
      const body = await parseBody(req)
      const allowInstall = body.allowInstall === true
      // currentRoom: name of the room the user has open at run-start.
      // Scenarios that target __CURRENT_ROOM__ resolve to this; unset
      // values fall back to the first existing room (see ops.ts).
      const currentRoom = typeof body.currentRoom === 'string' && body.currentRoom.trim()
        ? body.currentRoom.trim()
        : undefined
      // model: user's pick from the run dialog. Replaces __DEFAULT_MODEL__
      // in any spawn-agent op for this run. Unset = resolve at run-time
      // via the system's current curated default (see ops.ts:resolveModel).
      const model = typeof body.model === 'string' && body.model.trim()
        ? body.model.trim()
        : undefined
      const result = await system.scenarioRunner.run(scenario, {
        allowInstall,
        ...(currentRoom ? { currentRoom } : {}),
        ...(model ? { model } : {}),
      })
      if (!result.ok) return errorResponse(result.reason ?? 'run failed', 400)
      return json({ runId: result.runId })
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/scenarios\/([^/]+)\/([^/]+)$/,
    handler: (_req, match, { system }) => {
      const pack = decodeURIComponent(match[1]!)
      const name = decodeURIComponent(match[2]!)
      const id = `${pack}/${name}`
      const s = system.scenarioStore.get(id)
      if (!s) return errorResponse(`scenario ${id} not found`, 404)
      return json({
        id: s.id,
        pack: s.pack,
        name: s.name,
        title: s.title,
        description: s.description ?? '',
        narration: s.narration,
        source: s.source,
        opCount: s.ops.length,
        opKinds: [...new Set(s.ops.map(o => o.kind))],
      })
    },
  },
]
