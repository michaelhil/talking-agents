// Pack framework types — a Pack is a git-cloned directory at
// ~/.samsinn/packs/<name>/ containing an optional pack.json manifest plus
// tools/, skills/, scripts/, geodata/ subdirs. The directory name is the
// canonical namespace.

// External link to a wiki the pack author wants to surface. samsinn does
// not fetch or parse wiki content — it just shows the link in the pack
// panel. People view + edit on GitHub Pages / Vercel like any static
// site. (If an agent genuinely needs to read a page, web_fetch covers it.)
export interface WikiRef {
  readonly name: string           // display name (non-empty)
  readonly url: string            // http(s) URL
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
