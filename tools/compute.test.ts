import { describe, test, expect } from 'bun:test'
import tools from './compute.ts'

const ctx = { callerId: 'test-id', callerName: 'TestAgent' }

const toolMap = Object.fromEntries(tools.map(t => [t.name, t]))

describe('calculate', () => {
  const calc = toolMap['calculate']

  test('basic addition: 2+2 = 4', async () => {
    const result = await calc!.execute({ expression: '2+2' }, ctx)
    expect(result.success).toBe(true)
    expect((result.data as { result: number }).result).toBe(4)
  })

  test('multiplication: 6 * 7 = 42', async () => {
    const result = await calc!.execute({ expression: '6 * 7' }, ctx)
    expect(result.success).toBe(true)
    expect((result.data as { result: number }).result).toBe(42)
  })

  test('division: 10 / 4 = 2.5', async () => {
    const result = await calc!.execute({ expression: '10 / 4' }, ctx)
    expect(result.success).toBe(true)
    expect((result.data as { result: number }).result).toBe(2.5)
  })

  test('expression with parentheses: (3 + 4) * 2 = 14', async () => {
    const result = await calc!.execute({ expression: '(3 + 4) * 2' }, ctx)
    expect(result.success).toBe(true)
    expect((result.data as { result: number }).result).toBe(14)
  })

  test('complex expression: 100 / (5 + 5) * 3', async () => {
    const result = await calc!.execute({ expression: '100 / (5 + 5) * 3' }, ctx)
    expect(result.success).toBe(true)
    expect((result.data as { result: number }).result).toBe(30)
  })

  test('rejects expression with letters', async () => {
    const result = await calc!.execute({ expression: 'Math.random()' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })

  test('rejects expression with semicolons', async () => {
    const result = await calc!.execute({ expression: '1; process.exit(0)' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })

  test('returns error for missing expression', async () => {
    const result = await calc!.execute({}, ctx)
    expect(result.success).toBe(false)
  })
})

describe('json_extract', () => {
  const extract = toolMap['json_extract']

  test('extracts a top-level field', async () => {
    const json = JSON.stringify({ name: 'Alice', age: 30 })
    const result = await extract!.execute({ json, path: 'name' }, ctx)
    expect(result.success).toBe(true)
    expect((result.data as { value: unknown }).value).toBe('Alice')
  })

  test('extracts a nested field with dot notation', async () => {
    const json = JSON.stringify({ user: { address: { city: 'Oslo' } } })
    const result = await extract!.execute({ json, path: 'user.address.city' }, ctx)
    expect(result.success).toBe(true)
    expect((result.data as { value: unknown }).value).toBe('Oslo')
  })

  test('extracts an array element with bracket notation', async () => {
    const json = JSON.stringify({ items: ['a', 'b', 'c'] })
    const result = await extract!.execute({ json, path: 'items[1]' }, ctx)
    expect(result.success).toBe(true)
    expect((result.data as { value: unknown }).value).toBe('b')
  })

  test('extracts nested field after array index', async () => {
    const json = JSON.stringify({ results: [{ title: 'Paper One' }, { title: 'Paper Two' }] })
    const result = await extract!.execute({ json, path: 'results[0].title' }, ctx)
    expect(result.success).toBe(true)
    expect((result.data as { value: unknown }).value).toBe('Paper One')
  })

  test('returns null for missing path', async () => {
    const json = JSON.stringify({ a: 1 })
    const result = await extract!.execute({ json, path: 'b.c.d' }, ctx)
    expect(result.success).toBe(true)
    expect((result.data as { value: unknown }).value).toBeNull()
  })

  test('returns error for invalid JSON', async () => {
    const result = await extract!.execute({ json: 'not json', path: 'x' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })
})

describe('format_table', () => {
  const table = toolMap['format_table']

  test('produces a valid markdown table with correct column count', async () => {
    const headers = ['Name', 'Age', 'City']
    const rows = [
      ['Alice', '30', 'Oslo'],
      ['Bob', '25', 'Bergen'],
    ]
    const result = await table!.execute({ headers, rows }, ctx)
    expect(result.success).toBe(true)
    const output = result.data as string
    expect(typeof output).toBe('string')

    const lines = output.split('\n')
    // header row + separator row + 2 data rows = 4 lines
    expect(lines.length).toBe(4)

    // Header row has correct columns
    expect(lines[0]).toContain('Name')
    expect(lines[0]).toContain('Age')
    expect(lines[0]).toContain('City')

    // Separator row has dashes
    expect(lines[1]).toContain('---')

    // Each row starts and ends with pipe
    for (const line of lines) {
      expect(line.startsWith('|')).toBe(true)
      expect(line.endsWith('|')).toBe(true)
    }
  })

  test('handles empty rows array', async () => {
    const result = await table!.execute({ headers: ['A', 'B'], rows: [] }, ctx)
    expect(result.success).toBe(true)
    const output = result.data as string
    const lines = output.split('\n')
    // header + separator only
    expect(lines.length).toBe(2)
  })

  test('returns error for missing headers', async () => {
    const result = await table!.execute({ headers: [], rows: [] }, ctx)
    expect(result.success).toBe(false)
  })

  test('escapes pipe characters in cell content', async () => {
    const result = await table!.execute({ headers: ['Col'], rows: [['a | b']] }, ctx)
    expect(result.success).toBe(true)
    const output = result.data as string
    expect(output).toContain('\\|')
  })
})
