// ============================================================================
// Memory Tools — Per-agent persistent storage: notes log and key-value facts.
//
// Storage layout:
//   ~/.samsinn/memory/<sanitized-name>/notes.log  — append-only timestamped log
//   ~/.samsinn/memory/<sanitized-name>/facts.json — key-value JSON object
// ============================================================================

import type { Tool, ToolContext, ToolResult } from '../src/core/types.ts'
import { mkdir, appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const sanitizeName = (name: string): string => name.replace(/[^a-zA-Z0-9]/g, '_')

const memoryDir = (callerName: string): string =>
  join(homedir(), '.samsinn', 'memory', sanitizeName(callerName))

const notesPath = (callerName: string): string =>
  join(memoryDir(callerName), 'notes.log')

const factsPath = (callerName: string): string =>
  join(memoryDir(callerName), 'facts.json')

const ensureDir = async (callerName: string): Promise<void> => {
  await mkdir(memoryDir(callerName), { recursive: true })
}

const readFacts = async (callerName: string): Promise<Record<string, string>> => {
  try {
    const raw = await readFile(factsPath(callerName), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>
    }
    return {}
  } catch {
    return {}
  }
}

const writeFacts = async (callerName: string, facts: Record<string, string>): Promise<void> => {
  await ensureDir(callerName)
  await writeFile(factsPath(callerName), JSON.stringify(facts, null, 2), 'utf-8')
}

const thinkTool: Tool = {
  name: 'think',
  description: 'Reason through a problem privately before taking action. The thought is not shared or stored.',
  usage: 'Use to reason through a problem privately before taking action. The thought is not shown to other participants.',
  returns: '{ thought: string }',
  parameters: {
    type: 'object',
    properties: {
      reasoning: { type: 'string', description: 'Private reasoning or chain of thought' },
    },
    required: ['reasoning'],
  },
  execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
    const reasoning = params.reasoning as string | undefined
    if (!reasoning) return { success: false, error: '"reasoning" is required' }
    return { success: true, data: { thought: reasoning } }
  },
}

const noteTool: Tool = {
  name: 'note',
  description: 'Record an observation, finding, or conclusion to the personal notes log for future reference.',
  usage: 'Record observations, findings, or conclusions for future reference across sessions.',
  returns: '{ logged: true }',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The note content to record' },
    },
    required: ['content'],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    const content = params.content as string | undefined
    if (!content) return { success: false, error: '"content" is required' }
    await ensureDir(context.callerName)
    const line = `${new Date().toISOString()}\t${content}\n`
    await appendFile(notesPath(context.callerName), line, 'utf-8')
    return { success: true, data: { logged: true } }
  },
}

const myNotesTool: Tool = {
  name: 'my_notes',
  description: 'Read recent entries from the personal notes log.',
  usage: 'Retrieve previously recorded notes for context. Use limit to control how many recent entries to retrieve.',
  returns: 'Array of { timestamp: string, content: string }',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of recent entries to return (default 20)' },
    },
    required: [],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    const limit = typeof params.limit === 'number' ? params.limit : 20
    let raw: string
    try {
      raw = await readFile(notesPath(context.callerName), 'utf-8')
    } catch {
      return { success: true, data: [] }
    }
    const lines = raw.split('\n').filter(l => l.trim().length > 0)
    const recent = lines.slice(-limit)
    const entries = recent.map(line => {
      const tabIdx = line.indexOf('\t')
      if (tabIdx === -1) return { timestamp: '', content: line }
      return { timestamp: line.slice(0, tabIdx), content: line.slice(tabIdx + 1) }
    })
    return { success: true, data: entries }
  },
}

const rememberTool: Tool = {
  name: 'remember',
  description: 'Store a named fact or conclusion for retrieval in future sessions.',
  usage: 'Store a fact or conclusion for later retrieval across sessions.',
  returns: '{ key: string, value: string }',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'A short identifier for the fact' },
      value: { type: 'string', description: 'The fact or value to store' },
    },
    required: ['key', 'value'],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    const key = params.key as string | undefined
    const value = params.value as string | undefined
    if (!key) return { success: false, error: '"key" is required' }
    if (value === undefined || value === null) return { success: false, error: '"value" is required' }
    const facts = await readFacts(context.callerName)
    facts[key] = value
    await writeFacts(context.callerName, facts)
    return { success: true, data: { key, value } }
  },
}

const recallTool: Tool = {
  name: 'recall',
  description: 'Retrieve a previously stored fact by key.',
  usage: 'Look up a specific named fact stored with remember.',
  returns: '{ key: string, value: string | null }',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'The key of the fact to retrieve' },
    },
    required: ['key'],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    const key = params.key as string | undefined
    if (!key) return { success: false, error: '"key" is required' }
    const facts = await readFacts(context.callerName)
    const value = Object.prototype.hasOwnProperty.call(facts, key) ? facts[key] ?? null : null
    return { success: true, data: { key, value } }
  },
}

const forgetTool: Tool = {
  name: 'forget',
  description: 'Remove a stored fact by key.',
  usage: 'Delete a fact that is no longer accurate or needed.',
  returns: '{ key: string, removed: boolean }',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'The key of the fact to remove' },
    },
    required: ['key'],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    const key = params.key as string | undefined
    if (!key) return { success: false, error: '"key" is required' }
    const facts = await readFacts(context.callerName)
    const removed = Object.prototype.hasOwnProperty.call(facts, key)
    if (removed) {
      delete facts[key]
      await writeFacts(context.callerName, facts)
    }
    return { success: true, data: { key, removed } }
  },
}

export default [thinkTool, noteTool, myNotesTool, rememberTool, recallTool, forgetTool]
