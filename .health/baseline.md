# Samsinn health — 2026-05-10 12:14:27

## Summary

- Typecheck: ✅ pass
- Type coverage: 98.61%
- Escape hatches (`as any` / `@ts-ignore` etc): 64
- Silent-catch swallows in production: 119 (baseline captured 2026-05-12 with the new check; most are legitimate cleanup-on-shutdown paths — see `.health/suppressed.md` `## anti-patterns`)
- Stale documentation phrases: 1 (the suppressed README.md:171 "Pack-namespaced resolution is not yet implemented" — legitimate documented limitation)
- Dependency-cruiser: x 71 dependency violations (65 errors, 6 warnings). 603 modules, 1433 dependencies cruised.

## 1. Typecheck (bun run check)
```
$ tsc --noEmit && tsc --noEmit -p tsconfig.ui.json
```

## 2. Type coverage
```
Saved lockfile
(84612 / 85799) 98.61%
type-coverage success.
```

## 3. Escape hatches
```
src/ui/lib/nanostores.ts:120:  const $map = atom(initial) as unknown as MapStore<T>
src/ui/lib/nanostores.ts:152:  // @ts-expect-error - reassigning a typed-readonly method on the atom.
src/ui/lib/nanostores.ts:202:  // @ts-expect-error - reassigning a typed-readonly method on the computed atom.
src/ui/modules/app.ts:258:    agents: agents as unknown as Record<string, AgentInfo>,
src/ui/modules/app.ts:357:        agents: $agents.get() as unknown as Record<string, AgentInfo>,
src/ui/modules/app.ts:436:        agents: $agents.get() as unknown as Record<string, AgentInfo>,
src/ui/modules/app.ts:508:  if (health) updateOllamaHealthUI(health as unknown as Record<string, unknown>, ollamaStatusDot)
src/ui/modules/map/api.ts:69:  const existing = (window as unknown as { L?: LeafletApi }).L
src/ui/modules/map/api.ts:77:    const L = (window as unknown as { L?: LeafletApi }).L
src/ui/modules/map/api.ts:88:    const Lwithicon = L as unknown as {
src/ui/modules/map/index.ts:105:  ;(tileLayer as unknown as { on: (e: string, h: () => void) => void }).on('tileerror', () => {
src/tools/built-in/recall-tool.test.ts:31:  return fn as unknown as typeof globalThis.fetch
src/tools/built-in/recall-tool.test.ts:51:  createRoom: () => ({ kind: 'created' as const, room: undefined as unknown as Room }),
src/tools/built-in/recall-tool.test.ts:55:  getRoomConfig: () => undefined as unknown as RoomConfig,
src/tools/built-in/recall-tool.test.ts:64:} as unknown as House)
src/tools/built-in/geo-tools.test.ts:258:      const e = r as unknown as { candidates: Array<{ id: string }> }
src/llm/providers-setup.ts:67:    gateways.ollama = ollama as unknown as ProviderGateway
src/llm/ollama.ts:119:    if ((request as unknown as Record<string, unknown>).keepAlive !== undefined) {
src/llm/ollama.ts:120:      body.keep_alive = (request as unknown as Record<string, unknown>).keepAlive
src/llm/openai-compatible.ts:212:  out[out.length - 1] = tail as unknown as T
src/llm/provider-gateway.test.ts:79:    gw.updateConfig({ maxConcurrent: undefined as unknown as number })
src/llm/system-wiring.test.ts:172:    const houseCallbacks = (system.house as unknown as { /* accessing via llm */ })
src/llm/provider-monitor.test.ts:22:      return id as unknown as ReturnType<typeof setTimeout>
src/core/triggers/scheduler.test.ts:75:      team: { listAgents: () => [agent as any], getAgent: () => agent as any } as any,
src/core/triggers/scheduler.test.ts:77:      house: { getRoom: () => room as any } as any,
src/core/triggers/scheduler.test.ts:97:      team: { listAgents: () => [agent as any], getAgent: () => agent as any } as any,
src/core/triggers/scheduler.test.ts:99:      house: { getRoom: () => room as any } as any,
src/core/triggers/scheduler.test.ts:118:      team: { listAgents: () => [agent as any], getAgent: () => agent as any } as any,
src/core/triggers/scheduler.test.ts:120:      house: { getRoom: () => room as any } as any,
src/core/triggers/scheduler.test.ts:148:      team: { listAgents: () => [agent as any], getAgent: () => agent as any } as any,
... (64 total)
```

## 4. Dependency cycles + boundaries (dependency-cruiser)
```
      src/api/routes/types.ts →
      src/main.ts →
      src/bootstrap.ts →
      src/api/server.ts →
      src/api/http-routes.ts
  error no-circular: src/api/http-routes.ts → 
      src/api/routes/house.ts →
      src/api/routes/types.ts →
      src/main.ts →
      src/bootstrap.ts →
      src/api/server.ts →
      src/api/http-routes.ts
  error no-circular: src/api/http-routes.ts → 
      src/api/routes/geodata.ts →
      src/api/routes/types.ts →
      src/main.ts →
      src/bootstrap.ts →
      src/api/server.ts →
      src/api/http-routes.ts
  error no-circular: src/api/http-routes.ts → 
      src/api/routes/documents.ts →
      src/api/routes/types.ts →
      src/main.ts →
      src/bootstrap.ts →
      src/api/server.ts →
      src/api/http-routes.ts
  error no-circular: src/api/http-routes.ts → 
      src/api/routes/bugs.ts →
      src/api/routes/types.ts →
      src/main.ts →
      src/bootstrap.ts →
      src/api/server.ts →
      src/api/http-routes.ts
  error no-circular: src/api/http-routes.ts → 
      src/api/routes/bookmarks.ts →
      src/api/routes/types.ts →
      src/main.ts →
      src/bootstrap.ts →
      src/api/server.ts →
      src/api/http-routes.ts
  error no-circular: src/api/http-routes.ts → 
      src/api/routes/agents.ts →
      src/main.ts →
      src/bootstrap.ts →
      src/api/server.ts →
      src/api/http-routes.ts
  error no-circular: src/api/http-routes.ts → 
      src/api/routes/agents-memory.ts →
      src/api/routes/types.ts →
      src/main.ts →
      src/bootstrap.ts →
      src/api/server.ts →
      src/api/http-routes.ts
  error no-circular: src/api/agent-tracking.ts → 
      src/main.ts →
      src/bootstrap.ts →
      src/api/agent-tracking.ts

x 71 dependency violations (65 errors, 6 warnings). 603 modules, 1433 dependencies cruised.

```

## 5. Dead exports (knip)
```
Resolving dependencies
Resolved, downloaded and extracted [2]
Saved lockfile
Unlisted binaries (3)
src/core/migrate-local-pack.ts: tar
src/tools/built-in/pack-tools.test.ts: init, branch
src/tools/built-in/pack-tools.ts: pull
Unused exports (34)
src/agents/context-builder.ts: getParticipantsForRoom
src/api/routes/documents.ts: initDocumentsLimiter
src/api/routes/instances.ts: getInstanceLimiter
src/api/ws-handler.ts: SESSION_STALE_MS
src/core/scenarios/ops.ts: opHandlers
src/core/scenarios/store.ts: MAX_SCENARIO_SOURCE_BYTES
src/core/scenarios/yaml-mini.ts: parseInlineValue, splitTopLevel, findUnquotedColon
src/core/scripts/script-md-parser.ts: VALID_CAST_NAME, RESERVED_CAST_NAMES, __test
src/core/storage/snapshot.ts: isEmptySnapshot
src/embed/embedder.ts: EmbedError
src/embed/vector-store.ts: VECTOR_STORE_LINE_VERSION
src/geo/categories.ts: loadRegistry
src/geo/types.ts: MARKER_ICONS
src/geo/upstream.ts: __resetUpstreamGates
src/llm/gateway.ts: createProviderGateway, GATEWAY_DEFAULTS, createLLMGateway
src/llm/llm-policy-store.ts: POLICY_VERSION, loadPolicy, savePolicy
src/llm/llm-service.ts: FALLBACKABLE_AGENT_CODES
src/llm/provider-probe.ts: p95
src/llm/providers-config.ts: DEFAULT_PROVIDER_ORDER
src/packs/synthetic-demos/index.ts: DEMOS_PACK_NAMESPACE
src/packs/synthetic-welcome/index.ts: WELCOME_PACK_NAMESPACE, WELCOME_DEFAULT_SCENARIO
src/tools/built-in/pack-tools.ts: __resetPackChains, createListAvailablePacksTool
src/ui/modules/map/normalise.ts: isMarkerIcon, parseMapBody, validateMapEnvelope, formatMapErrors, collectEnvelopeLatLngs
src/ui/modules/mermaid/api.ts: mermaidThemeForCurrentMode
src/ui/modules/message-header-prefs.ts: applyPrefs
src/ui/modules/modals/detail-modal.ts: escapeHtml
src/ui/modules/modals/skill-detail-modal.ts: openSkillDetailModal
src/ui/modules/ollama-dashboard.ts: updateOllamaMetricsUI, refreshOllamaUrls
src/ui/modules/panels/providers/index.ts: renderProvidersPanel
src/ui/modules/panels/summary-panel.ts: toggleSummaryGroup, openSummarySettingsModal, openSummaryInspectModal
src/ui/modules/panels/triggers-panel.ts: openTriggerForm, openAgentTriggers
src/ui/modules/prompt-toggles/shared.ts: mkGlass, applyGroupDisabled
src/ui/modules/send-as-picker.ts: createHumanInline
src/ui/modules/theme.ts: getTheme, setTheme, toggleTheme
Unused exported types (43)
src/agents/context-builder.ts: SystemSectionKey, ContextStrategy
src/agents/evaluation.ts: LLMCallMetrics
src/api/rate-limit.ts: RateLimitOk, RateLimitFail, RateLimitResult
src/api/routes/types.ts: ResetInstanceOk, ResetInstanceFail, ResetInstanceResult, EvictInstanceResult, InstanceAdmin, DiagnosticsCapability
src/api/ws-commands/types.ts: CommandHandler
src/core/instances/system-registry.ts: InstanceMeta, InstanceOnDisk
src/core/limit-metrics.ts: LimitMetricsSnapshot
src/core/render-validators/map-schema.ts: MapView
src/core/scenarios/runner.ts: ScenarioEventName
src/core/scenarios/types.ts: RunStatus
src/core/scenarios/waits.ts: ExternalWaitType
src/core/scripts/script-runner.ts: ScriptEventName
src/core/storage/snapshot.ts: RoomSnapshot, AgentSnapshot, HumanAgentSnapshot, EmbedderBindingSnapshot, DocumentStatus, DocumentSnapshot
src/core/summaries/summary-scheduler.ts: TriggerOptions
src/core/types/agent.ts: ContextPreviewSection, ContextPreview, AgentMemoryStats
src/core/types/messaging.ts: MessageErrorCode, RoomContext, AgentDeliveryStatus
src/core/types/summary.ts: SummarySchedule
src/core/types/tool.ts: ToolLLMRequest, ToolSourceKind
src/documents/types.ts: DocumentStatus
src/embed/vector-store.ts: VectorNamespace, EmbedderBinding, SearchHit, SearchOptions
src/geo/import.ts: ImportError
src/geo/types.ts: GeoProperties, GeoPoint
src/integrations/mcp/client.ts: MCPServerConfig
src/llm/circuit-breaker.ts: CircuitState
src/llm/errors.ts: OllamaErrorCode, CloudErrorCode
src/llm/gateway.ts: CircuitState, RequestStatus, RequestRecord, GatewayMetrics, LoadedModel, OllamaHealth, ProviderHealth, OllamaHealthExtra, ProviderGateway, ChatCallOptions
src/llm/llm-policy-store.ts: LLMPolicyFileShape, PolicyLoadResult
src/llm/llm-service.ts: LLMSource, LLMServiceBindOptions, LLMServiceFailure
src/llm/provider-gateway.ts: CircuitState, RequestStatus, RequestRecord, GatewayMetrics, ProviderHealth, IsPermanentError
src/llm/provider-monitor.ts: MonitorListener
src/llm/providers-config.ts: CloudProviderConfig, CloudProviderConfigWithSource
src/llm/providers-store.ts: StoredOllamaEntry
src/llm/router.ts: ProviderAttemptCode, ProviderBoundEvent, ProviderAllFailedEvent, ProviderStreamFailedEvent, ProviderRoutingListener, ContextLookupFn, RouterMetrics
src/packs/bundled-scenario-loader.ts: BundledScenarioSpec, TokenMap
src/skills/loader.ts: Skill
src/tools/built-in/index.ts: PackToolsDeps, RecallToolDeps, QueryDocumentsToolDeps
src/tools/built-in/pack-tools.ts: NotifyPacksChanged
```

## 6. Largest source files
```
   45806 total
     981 src/main.ts
     860 src/ui/modules/app.ts
     798 src/bootstrap.ts
     793 src/llm/router.ts
     740 src/agents/ai-agent.ts
     679 src/llm/openai-compatible.ts
     674 src/tools/built-in/pack-tools.ts
     649 src/agents/context-builder.ts
     609 src/core/storage/snapshot.ts
     601 src/core/instances/system-registry.ts
     559 src/core/scripts/script-runner.ts
     504 src/llm/provider-monitor.ts
     478 src/agents/evaluation.ts
     476 src/core/render-validators/map-schema.ts
     455 src/ui/modules/agent-inspector.ts
```
