import { describe, test, expect } from 'bun:test'
import { formatToolDescriptions, TOOL_RESPONSE_FORMAT_SUFFIX } from './format.ts'
import type { Tool } from '../core/types.ts'

const makeTool = (overrides: Partial<Tool> = {}): Tool => ({
  name: 'test_tool',
  description: 'A test tool',
  parameters: {},
  execute: async () => ({ success: true }),
  ...overrides,
})

describe('formatToolDescriptions', () => {
  test('empty list returns empty string', () => {
    expect(formatToolDescriptions([])).toBe('')
  })

  test('tool with no parameters', () => {
    const result = formatToolDescriptions([makeTool()])
    expect(result).toBe('Available tools:\n- test_tool: A test tool No parameters.')
  })

  test('tool with parameters includes JSON schema', () => {
    const result = formatToolDescriptions([
      makeTool({ parameters: { type: 'object', properties: { query: { type: 'string' } } } }),
    ])
    expect(result).toContain('test_tool')
    expect(result).toContain('"type":"object"')
  })

  test('multiple tools each on own line', () => {
    const tools = [
      makeTool({ name: 'tool_a', description: 'First' }),
      makeTool({ name: 'tool_b', description: 'Second' }),
    ]
    const result = formatToolDescriptions(tools)
    expect(result).toContain('- tool_a: First')
    expect(result).toContain('- tool_b: Second')
    const lines = result.split('\n')
    expect(lines[0]).toBe('Available tools:')
    expect(lines).toHaveLength(3)
  })
})

describe('TOOL_RESPONSE_FORMAT_SUFFIX', () => {
  test('contains ::TOOL:: syntax instruction', () => {
    expect(TOOL_RESPONSE_FORMAT_SUFFIX).toContain('::TOOL::')
  })

  test('starts with newline for clean appending', () => {
    expect(TOOL_RESPONSE_FORMAT_SUFFIX.startsWith('\n')).toBe(true)
  })

  test('contains time/date tool reminder', () => {
    expect(TOOL_RESPONSE_FORMAT_SUFFIX).toContain('real-time information')
  })
})
