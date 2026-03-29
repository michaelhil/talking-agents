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

  test('single tool with no params formats as labeled block', () => {
    const result = formatToolDescriptions([makeTool()])
    expect(result).toBe('Available tools:\n\n[test_tool]\n  A test tool')
  })

  test('tool with parameters shows names and types in signature', () => {
    const result = formatToolDescriptions([
      makeTool({
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' }, limit: { type: 'number' } },
          required: ['query'],
        },
      }),
    ])
    expect(result).toContain('[test_tool query: string, limit?: number]')
    expect(result).toContain('A test tool')
  })

  test('tool with usage field includes it on its own line', () => {
    const result = formatToolDescriptions([
      makeTool({ usage: 'Only use when X applies.' }),
    ])
    expect(result).toContain('Usage: Only use when X applies.')
  })

  test('tool with returns field includes it on its own line', () => {
    const result = formatToolDescriptions([
      makeTool({ returns: 'An ISO timestamp string.' }),
    ])
    expect(result).toContain('Returns: An ISO timestamp string.')
  })

  test('tool without usage/returns omits those lines', () => {
    const result = formatToolDescriptions([makeTool()])
    expect(result).not.toContain('Usage:')
    expect(result).not.toContain('Returns:')
  })

  test('multiple tools are separated by blank lines', () => {
    const tools = [
      makeTool({ name: 'tool_a', description: 'First' }),
      makeTool({ name: 'tool_b', description: 'Second' }),
    ]
    const result = formatToolDescriptions(tools)
    expect(result).toContain('[tool_a]')
    expect(result).toContain('[tool_b]')
    // Blank line between blocks
    expect(result).toContain('\n\n')
    expect(result.startsWith('Available tools:\n\n')).toBe(true)
  })

  test('required params have no ? suffix, optional params do', () => {
    const result = formatToolDescriptions([
      makeTool({
        parameters: {
          type: 'object',
          properties: { req: { type: 'string' }, opt: { type: 'string' } },
          required: ['req'],
        },
      }),
    ])
    expect(result).toContain('req: string')
    expect(result).toContain('opt?: string')
    expect(result).not.toContain('req?: string')
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
