// Pack framework types — a Pack is a git-cloned directory at
// ~/.samsinn/packs/<name>/ containing an optional pack.json manifest plus
// tools/ and skills/ subdirs. The directory name is the canonical namespace.

export interface PackManifest {
  readonly name?: string          // display name; defaults to directory basename
  readonly description?: string
}

export interface Pack {
  readonly namespace: string      // directory basename — used as `<ns>_<tool>` / `<ns>/<skill>`
  readonly dirPath: string        // absolute path to ~/.samsinn/packs/<namespace>
  readonly manifest: PackManifest // parsed pack.json (or {} if absent/invalid)
}
