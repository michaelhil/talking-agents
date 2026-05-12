import { describe, it, expect } from 'bun:test'
import { normaliseMermaidSource, truncateForDisplay, MAX_MERMAID_SOURCE } from './normalise.ts'

describe('normaliseMermaidSource — trailing semicolons', () => {
  it('strips trailing ; from each line', () => {
    const src = 'flowchart LR\n    A --> B;\n    B --> C;'
    const out = normaliseMermaidSource(src)
    expect(out).toBe('flowchart LR\n    A --> B\n    B --> C')
  })

  it('preserves semicolons not at line end', () => {
    const src = 'flowchart LR\n    A["foo; bar"] --> B'
    expect(normaliseMermaidSource(src)).toBe(src)
  })

  it('strips trailing ; even with trailing whitespace', () => {
    expect(normaliseMermaidSource('A --> B;   ')).toBe('A --> B')
  })
})

describe('normaliseMermaidSource — bracket label quoting', () => {
  it('quotes [body] containing /', () => {
    expect(normaliseMermaidSource('D[Divert / Abort]'))
      .toBe('D["Divert / Abort"]')
  })

  it('quotes {body} containing <', () => {
    expect(normaliseMermaidSource('C{a < b}'))
      .toBe('C{"a < b"}')
  })

  it('quotes (body) containing #', () => {
    expect(normaliseMermaidSource('E(foo#bar)'))
      .toBe('E("foo#bar")')
  })

  it('leaves plain bodies alone', () => {
    expect(normaliseMermaidSource('A[Start]')).toBe('A[Start]')
    expect(normaliseMermaidSource('B{Decision}')).toBe('B{Decision}')
    expect(normaliseMermaidSource('C(Process)')).toBe('C(Process)')
  })

  it('does not double-quote already-quoted bodies', () => {
    expect(normaliseMermaidSource('D["Divert / Abort"]'))
      .toBe('D["Divert / Abort"]')
  })

  it('quotes when body has leading whitespace before a special char', () => {
    expect(normaliseMermaidSource('X[ foo/bar ]'))
      .toBe('X["foo/bar"]')
  })
})

describe('normaliseMermaidSource — bare quoted references', () => {
  it('converts a bare quoted ref into a synthetic node definition', () => {
    const src = '"Process / Store" --> Output'
    const out = normaliseMermaidSource(src)
    expect(out).toBe('n1["Process / Store"] --> Output')
  })

  it('reuses the synthetic id on subsequent mentions', () => {
    const src = 'Input --> "Process / Store"\n"Process / Store" --> Output'
    const out = normaliseMermaidSource(src)
    expect(out).toBe('Input --> n1["Process / Store"]\nn1 --> Output')
  })

  it('assigns distinct ids to distinct labels', () => {
    const src = '"A/B" --> "C/D"'
    const out = normaliseMermaidSource(src)
    expect(out).toBe('n1["A/B"] --> n2["C/D"]')
  })

  it('leaves bracketed quoted labels alone (produced by step 2)', () => {
    const src = 'D["Divert / Abort"] --> X'
    expect(normaliseMermaidSource(src)).toBe('D["Divert / Abort"] --> X')
  })
})

describe('normaliseMermaidSource — edge-label quotes preserved (R3 bug)', () => {
  it('preserves `A -- "label" --> B` — edge label is not a node ref', () => {
    const src = 'A -- "some label" --> B'
    const out = normaliseMermaidSource(src)
    expect(out).toBe('A -- "some label" --> B')
  })

  it('preserves edge label with tighter spacing', () => {
    const src = 'A --"label"--> B'
    expect(normaliseMermaidSource(src)).toBe('A --"label"--> B')
  })

  it('preserves edge label even when the label contains /', () => {
    const src = 'A -- "if / else" --> B'
    expect(normaliseMermaidSource(src)).toBe('A -- "if / else" --> B')
  })
})

describe('normaliseMermaidSource — directives and comments', () => {
  it('leaves classDef declarations untouched', () => {
    const src = 'classDef important fill:#f00,stroke:#000\nA:::important --> B'
    expect(normaliseMermaidSource(src)).toBe(src)
  })

  it('leaves style declarations untouched', () => {
    const src = 'style A fill:#fff,stroke:#000'
    expect(normaliseMermaidSource(src)).toBe(src)
  })

  it('leaves %% comments untouched', () => {
    const src = '%% this is a comment with [brackets] and /slashes'
    expect(normaliseMermaidSource(src)).toBe(src)
  })
})

describe('normaliseMermaidSource — edge cases', () => {
  it('empty string returns empty string', () => {
    expect(normaliseMermaidSource('')).toBe('')
  })

  it('whitespace-only returns as-is', () => {
    expect(normaliseMermaidSource('\n\n   \n')).toBe('\n\n   \n')
  })

  it('preserves mermaid arrows of different styles', () => {
    expect(normaliseMermaidSource('A --> B\nC -.-> D\nE ==> F'))
      .toBe('A --> B\nC -.-> D\nE ==> F')
  })

  it('composable: quoting a bracket with / and then using that node elsewhere', () => {
    const src = 'A[foo/bar] --> B\nB --> A'
    const out = normaliseMermaidSource(src)
    expect(out).toBe('A["foo/bar"] --> B\nB --> A')
  })

  it('leaves click directive URLs alone (third edge-context case)', () => {
    const src = `flowchart TD
  A["Step 1"]
  EXT_X["X"]
  A --> EXT_X
  click EXT_X "https://example.com/proc/X" _blank`
    const out = normaliseMermaidSource(src)
    // The URL must survive intact, not be replaced by a synthetic n1["..."]
    expect(out).toContain('click EXT_X "https://example.com/proc/X" _blank')
    expect(out).not.toMatch(/n\d+\["https/)
  })

  it('leaves pipe edge labels alone (regression for the procedure_lookup bug)', () => {
    const src = 'A --> B\nA -->|"If x: continue"| B'
    const out = normaliseMermaidSource(src)
    expect(out).toContain('-->|"If x: continue"|')
    expect(out).not.toMatch(/n\d+\["If x: continue"\]/)
  })
})

describe('truncateForDisplay', () => {
  it('returns source unchanged (no artificial cap — fallback card uses overflow-scroll)', () => {
    expect(truncateForDisplay('short')).toBe('short')
    const long = 'x'.repeat(10_000)
    expect(truncateForDisplay(long)).toBe(long)
  })
})

describe('MAX_MERMAID_SOURCE constant', () => {
  it('matches mermaid default (50 KB)', () => {
    expect(MAX_MERMAID_SOURCE).toBe(50_000)
  })
})
