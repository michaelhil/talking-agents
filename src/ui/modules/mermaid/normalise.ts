// Normalises LLM-generated Mermaid source to what Mermaid 11 actually accepts.
//
// Pure function. No DOM, no network, no side effects. All regex-heavy, so
// every branch should have a test case in normalise.test.ts.
//
// Rules applied in order:
//   1. Strip trailing `;` from each line. Accepted in older mermaid, rejected
//      in strict parses. Semicolons mid-line (e.g. in labels) are preserved.
//   2. Quote the body of `[...]`, `(...)`, `{...}` when it contains a char
//      Mermaid treats as control (`/ # < >`). Leaves already-quoted bodies
//      alone.
//   3. Convert bare quoted node references — `"Foo / Bar" --> X` — into
//      synthetic `nN["Foo / Bar"]` definitions with ID reuse for subsequent
//      mentions. Mermaid requires node refs to be identifiers, not quoted
//      strings. Edge-label quotes (`A -- "label" --> B`) are NOT rewritten.

const NEEDS_QUOTING = /[\/#<>]/

// Max source length accepted. Matches Mermaid's default `maxTextSize` so our
// cap doesn't lie ahead of mermaid's. Callers detect exceeds-cap and route
// to the fallback UI — normalise() itself still runs on oversized input
// (harmless; cheap), but callers should check first.
export const MAX_MERMAID_SOURCE = 50_000

export const normaliseMermaidSource = (src: string): string => {
  // 1. Strip trailing semicolons from each line.
  const lines = src.split('\n').map(line => line.replace(/;\s*$/, ''))
  let normalised = lines.join('\n')

  // 2. Quote label bodies that contain special chars. Matches [...], (...),
  //    {...}. Already-quoted bodies are left alone.
  normalised = normalised.replace(
    /(\[|\(|\{)([^\[\]\(\)\{\}"\n]+?)(\]|\)|\})/g,
    (match, open: string, body: string, close: string) => {
      const trimmed = body.trim()
      if (trimmed.startsWith('"') && trimmed.endsWith('"')) return match
      if (!NEEDS_QUOTING.test(body)) return match
      return `${open}"${body.trim()}"${close}`
    },
  )

  // 3. Bare-quoted references. Two-phase: mark every `"..."` with a sentinel,
  //    restore the ones that turn out to be inside brackets (produced by
  //    step 2), then expand the remaining sentinels into synthetic node
  //    definitions. Edge-label quotes (preceded by `-- ` or followed by
  //    ` -->`) are never marked in the first place.
  const labelToId = new Map<string, string>()
  const synthId = (label: string): string => {
    const existing = labelToId.get(label)
    if (existing) return existing
    const id = `n${labelToId.size + 1}`
    labelToId.set(label, id)
    return id
  }

  // A quoted string is a bare node reference ONLY when it isn't in one of
  // these mermaid contexts where `"..."` is already structurally meaningful:
  //   A --"label"--> B           (between `--` and `--`)
  //   A -->|"label"| B           (pipe-delimited edge label)
  //   click X "url" _blank       (link directive — URL inside quotes)
  // Anything else is treated as a bare node ref and replaced with a
  // synthetic id (`n1["..."]`).
  normalised = normalised.replace(
    /"([^"\n]+)"/g,
    (match, label: string, offset: number, full: string): string => {
      const before = full.slice(Math.max(0, offset - 8), offset)
      const after = full.slice(offset + match.length, offset + match.length + 8)
      const isDashEdgeStart = /--\s*$/.test(before)
      const isDashEdgeEnd = /^\s*--/.test(after)
      const isPipeEdgeStart = /\|\s*$/.test(before)
      const isPipeEdgeEnd = /^\s*\|/.test(after)
      if (isDashEdgeStart && isDashEdgeEnd) return match
      if (isPipeEdgeStart && isPipeEdgeEnd) return match
      // Click directive: line starts with `click <id> ` and the quoted
      // string is followed by an optional second string and/or a target
      // keyword (_blank/_self/_parent/_top). Detect by scanning back to
      // start-of-line.
      const lineStart = full.lastIndexOf('\n', offset - 1) + 1
      const linePrefix = full.slice(lineStart, offset)
      if (/^\s*click\s+\S+\s*/.test(linePrefix)) return match
      // Comment / callback: same context — leave alone.
      if (/^\s*%%/.test(linePrefix)) return match
      return `__MM_LABEL__${synthId(label)}__MM_END__`
    },
  )

  // Restore bracketed sentinels to their original quoted form (step 2
  // produced `["Foo"]` which got sentinel-ified; restore).
  normalised = normalised.replace(
    /(\[|\(|\{)__MM_LABEL__n(\d+)__MM_END__(\]|\)|\})/g,
    (_m, open: string, n: string, close: string) => {
      const label = [...labelToId.entries()].find(([, id]) => id === `n${n}`)?.[0] ?? ''
      return `${open}"${label}"${close}`
    },
  )

  // Remaining sentinels are bare references — expand to `id["label"]` on
  // first occurrence, bare `id` on subsequent references.
  const definedIds = new Set<string>()
  normalised = normalised.replace(
    /__MM_LABEL__(n\d+)__MM_END__/g,
    (_m, id: string) => {
      const label = [...labelToId.entries()].find(([, v]) => v === id)?.[0] ?? ''
      if (definedIds.has(id)) return id
      definedIds.add(id)
      return `${id}["${label}"]`
    },
  )

  return normalised
}

// Pass-through. Fallback cards show the full source so the user can debug
// what broke. The fallback wrapper has its own `max-h` + overflow-scroll;
// no need to amputate the content.
export const truncateForDisplay = (src: string): string => src
