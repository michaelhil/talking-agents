// Pack framework types — a Pack is a git-cloned directory at
// ~/.samsinn/packs/<name>/ containing an optional pack.json manifest plus
// tools/, skills/, scripts/, geodata/ subdirs. The directory name is the
// canonical namespace.

// External link to a wiki the pack author wants to surface in the pack
// panel. Optionally, the pack can also declare a `source` binding —
// org/repo/branch/paths — so samsinn-side tools can fetch the wiki
// markdown directly from raw.githubusercontent. The first consumer is
// the pwr-eops pack's `procedure_lookup` tool. Without `source`, the
// WikiRef behaves as before: a display-only link.
export interface WikiSourceBinding {
  readonly org: string
  readonly repo: string
  readonly branch: string                  // typically "main"
  readonly procedureDir: string            // path within the repo, e.g. "wiki/procedures"
  readonly indexFile: string               // path to the index file with [[ID]] wikilinks (fallback for old wikis)
  readonly citationBase: string            // base URL for clickable per-procedure citations
  /**
   * Optional path to a machine-readable manifest emitted by the wiki's build
   * pipeline (e.g. `wiki/_manifest.json`). When present, the fetcher prefers
   * it over regex-scraping `indexFile`. Manifest shape is documented in the
   * pwr-eops repo at `scripts/build-manifest.ts`.
   */
  readonly manifestFile?: string
}

export interface WikiRef {
  readonly name: string                    // display name (non-empty)
  readonly url: string                     // http(s) URL (the rendered wiki home)
  readonly source?: WikiSourceBinding      // optional binding for content fetching
}

export interface PackManifest {
  readonly name?: string          // display name; defaults to directory basename
  readonly description?: string
  readonly wikis?: ReadonlyArray<WikiRef>   // external wiki links surfaced in the pack panel
  // Names of UI extensions this pack expects to be mounted in the browser when
  // the pack is installed. The server propagates this array as-is — it has no
  // authority on which extension names are recognised. The browser reconciles
  // declared names against its KNOWN_UI_EXTENSIONS map and silently no-ops on
  // unknown names (forward-compatible: a pack can declare an extension before
  // any core release knows it).
  readonly ui_extensions?: ReadonlyArray<string>
}

export interface Pack {
  readonly namespace: string      // directory basename — used as `<ns>_<tool>` / `<ns>/<skill>`
  readonly dirPath: string        // absolute path to ~/.samsinn/packs/<namespace>
  readonly manifest: PackManifest // parsed pack.json (or {} if absent/invalid)
}
