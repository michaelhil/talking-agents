// ============================================================================
// Compute Tools — Mathematical evaluation, JSON path extraction, table formatting.
// ============================================================================

import type { Tool, ToolResult } from '../src/core/types.ts'

// Only allow safe arithmetic characters: digits, operators, parens, spaces,
// decimal points, percent, scientific notation (e/E), and commas (for readability).
const SAFE_EXPR = /^[0-9+\-*/.()%\s,eE*]+$/

const calculateTool: Tool = {
  name: 'calculate',
  description: 'Evaluate a mathematical expression and return the numeric result.',
  usage: 'Evaluate mathematical expressions exactly. Always use instead of estimating arithmetic.',
  returns: '{ result: number }',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'A mathematical expression to evaluate, e.g. "(3 + 4) * 2"' },
    },
    required: ['expression'],
  },
  execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
    const expression = params.expression as string | undefined
    if (!expression) return { success: false, error: '"expression" is required' }

    if (!SAFE_EXPR.test(expression)) {
      return { success: false, error: `Invalid expression: contains disallowed characters. Only digits, +, -, *, /, ., (, ), %, spaces, commas, and e/E are allowed.` }
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const result: unknown = new Function('return (' + expression + ')')()
      if (typeof result !== 'number' || !isFinite(result)) {
        return { success: false, error: `Expression did not produce a finite number: ${String(result)}` }
      }
      return { success: true, data: { result } }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Evaluation failed' }
    }
  },
}

// Walk a path like "a.b.c" or "a[0].b" against a parsed JSON value.
const walkPath = (value: unknown, path: string): unknown => {
  // Tokenize: split on dots, expand bracket notation into separate tokens.
  const tokens: string[] = []
  const segments = path.split('.')
  for (const seg of segments) {
    // Handle bracket notation, e.g. "items[0]" → "items", "0"
    const bracketMatch = seg.match(/^([^\[]*)((?:\[\d+\])*)$/)
    if (!bracketMatch) {
      tokens.push(seg)
      continue
    }
    if (bracketMatch[1]) tokens.push(bracketMatch[1])
    const brackets = bracketMatch[2] ?? ''
    const indices = [...brackets.matchAll(/\[(\d+)\]/g)].map(m => m[1] ?? '')
    for (const idx of indices) tokens.push(idx)
  }

  let current = value
  for (const token of tokens) {
    if (token === '') continue
    if (current === null || current === undefined) return undefined
    if (typeof current !== 'object') return undefined
    if (Array.isArray(current)) {
      const idx = parseInt(token, 10)
      if (isNaN(idx)) return undefined
      current = current[idx]
    } else {
      current = (current as Record<string, unknown>)[token]
    }
  }
  return current
}

const jsonExtractTool: Tool = {
  name: 'json_extract',
  description: 'Extract a specific field from a JSON string using a dot-notation path.',
  usage: 'Extract a specific field from JSON data returned by other tools.',
  returns: '{ value: unknown }',
  parameters: {
    type: 'object',
    properties: {
      json: { type: 'string', description: 'A JSON string to parse' },
      path: { type: 'string', description: 'Dot-notation path to the value, e.g. "user.address.city" or "items[0].name"' },
    },
    required: ['json', 'path'],
  },
  execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
    const jsonStr = params.json as string | undefined
    const path = params.path as string | undefined
    if (!jsonStr) return { success: false, error: '"json" is required' }
    if (!path) return { success: false, error: '"path" is required' }

    let parsed: unknown
    try {
      parsed = JSON.parse(jsonStr)
    } catch (err) {
      return { success: false, error: `Failed to parse JSON: ${err instanceof Error ? err.message : String(err)}` }
    }

    const value = walkPath(parsed, path)
    return { success: true, data: { value: value === undefined ? null : value } }
  },
}

const formatTableTool: Tool = {
  name: 'format_table',
  description: 'Format data as a GitHub-flavored Markdown table.',
  usage: 'Build properly formatted Markdown tables. Never construct tables manually — always use this tool to avoid formatting errors.',
  returns: 'Markdown table string',
  parameters: {
    type: 'object',
    properties: {
      headers: {
        type: 'array',
        items: { type: 'string' },
        description: 'Column header names',
      },
      rows: {
        type: 'array',
        items: {
          type: 'array',
          items: { type: 'string' },
        },
        description: 'Table rows; each row is an array of cell strings',
      },
    },
    required: ['headers', 'rows'],
  },
  execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
    const headers = params.headers as string[] | undefined
    const rows = params.rows as string[][] | undefined

    if (!headers || !Array.isArray(headers) || headers.length === 0) {
      return { success: false, error: '"headers" must be a non-empty array of strings' }
    }
    if (!rows || !Array.isArray(rows)) {
      return { success: false, error: '"rows" must be an array of arrays' }
    }

    const colCount = headers.length

    // Escape pipe characters within cell content
    const escapeCell = (cell: string): string => cell.replace(/\|/g, '\\|').replace(/\n/g, ' ')

    const headerRow = '| ' + headers.map(escapeCell).join(' | ') + ' |'
    const separatorRow = '| ' + headers.map(() => '---').join(' | ') + ' |'
    const dataRows = rows.map(row => {
      const cells = Array.from({ length: colCount }, (_, i) => escapeCell(row[i] ?? ''))
      return '| ' + cells.join(' | ') + ' |'
    })

    const table = [headerRow, separatorRow, ...dataRows].join('\n')
    return { success: true, data: table }
  },
}

export default [calculateTool, jsonExtractTool, formatTableTool]
