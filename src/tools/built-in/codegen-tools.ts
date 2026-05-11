// ============================================================================
// Code Generation Tools — Runtime skill and tool authoring by agents.
//
// write_skill: Creates a skill directory with SKILL.md.
// write_tool: Writes a complete .ts module into a skill's tools/ directory.
// test_tool: Runs a registered tool with sample input.
// list_skills: Lists all loaded skills with their bundled tools.
//
// Code generation intelligence lives in the skill-builder skill
// (skills/skill-builder/tools/generate_tool_code.ts), not here.
// These tools are mechanical — filesystem, registry, validation.
// ============================================================================

import type { Tool, ToolRegistry } from '../../core/types/tool.ts'
import type { SkillStore } from '../../skills/loader.ts'
import { VALID_NAME, isTool } from '../loader.ts'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

type RefreshAllFn = () => Promise<void>

export const createWriteSkillTool = (
  store: SkillStore,
  skillsDir: string,
): Tool => ({
  name: 'write_skill',
  description: 'Create a SKILL.md — a behavioural prompt template injected into agent context. Bundled tools come later via write_tool.',
  usage: 'Create reusable behavioural instructions. Body is markdown. Add bundled tools later with write_tool.',
  returns: 'Object with the skill name and directory path.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$' },
      description: { type: 'string', description: 'When this skill should be used' },
      body: { type: 'string', description: 'Markdown body' },
      scope: {
        type: 'array',
        items: { type: 'string' },
        description: 'Room names. Omit for global.',
      },
    },
    required: ['name', 'description', 'body'],
  },
  execute: async (params) => {
    const name = params.name as string
    const description = params.description as string
    const body = params.body as string
    const scope = params.scope as string[] | undefined

    if (!name || !description || !body) {
      return { success: false, error: 'name, description, and body are required' }
    }

    if (!VALID_NAME.test(name)) {
      return { success: false, error: `Invalid skill name "${name}" — use letters, digits, underscores, hyphens` }
    }

    if (store.get(name)) {
      return { success: false, error: `Skill "${name}" already exists` }
    }

    const dirPath = join(skillsDir, name)
    await mkdir(dirPath, { recursive: true })

    const scopeLine = scope && scope.length > 0
      ? `\nscope: [${scope.join(', ')}]`
      : ''
    const content = `---\nname: ${name}\ndescription: ${description}${scopeLine}\n---\n\n${body}\n`

    const filePath = join(dirPath, 'SKILL.md')
    try {
      await writeFile(filePath, content, 'utf-8')
    } catch (err) {
      return { success: false, error: `Failed to write SKILL.md: ${err instanceof Error ? err.message : String(err)}` }
    }

    store.register({
      name, description, body,
      scope: scope ?? [],
      tools: [],
      allowedToolNames: [],
      dirPath,
    })

    return { success: true, data: { name, path: dirPath } }
  },
})

export const createWriteToolTool = (
  registry: ToolRegistry,
  store: SkillStore,
  refreshAll: RefreshAllFn,
): Tool => ({
  name: 'write_tool',
  description: 'Write a TypeScript tool module into a skill\'s tools/ dir. Imported, validated, and registered immediately.',
  usage: 'Use after generate_tool_code has produced the source code. Pass the code string directly — do not modify it. The code must be a complete .ts module that exports a tool object as default.',
  returns: 'Object with the registered tool name, skill, and file path.',
  parameters: {
    type: 'object',
    properties: {
      skill: { type: 'string', description: 'Owning skill (must exist).' },
      name: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$' },
      code: { type: 'string', description: 'Complete .ts module exporting a Tool as default.' },
    },
    required: ['skill', 'name', 'code'],
  },
  execute: async (params) => {
    const skillName = params.skill as string
    const name = params.name as string
    const code = params.code as string

    if (!skillName || !name || !code) {
      return { success: false, error: 'skill, name, and code are required' }
    }

    const skill = store.get(skillName)
    if (!skill) {
      return { success: false, error: `Skill "${skillName}" not found — create it first with write_skill` }
    }

    if (!VALID_NAME.test(name)) {
      return { success: false, error: `Invalid tool name "${name}" — use letters, digits, underscores, hyphens` }
    }

    const toolsDir = join(skill.dirPath, 'tools')
    await mkdir(toolsDir, { recursive: true })

    const filePath = join(toolsDir, `${name}.ts`)

    try {
      await writeFile(filePath, code, 'utf-8')
    } catch (err) {
      return { success: false, error: `Failed to write file: ${err instanceof Error ? err.message : String(err)}` }
    }

    // Dynamic import + validation
    let mod: { default?: unknown }
    try {
      mod = await import(`${filePath}?t=${Date.now()}`)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      await unlink(filePath).catch(() => {})
      return { success: false, error: `Import failed (file deleted): ${errMsg}\n\nGenerated code:\n${code}` }
    }

    const tool = mod.default
    if (!isTool(tool)) {
      await unlink(filePath).catch(() => {})
      return { success: false, error: `Module does not export a valid Tool (needs name, description, parameters, execute). File deleted.\n\nGenerated code:\n${code}` }
    }

    registry.registerWithSource(tool as Tool, {
      kind: 'skill-bundled',
      path: filePath,
      skill: skillName,
    })

    // Update skill's tool list if this is a new tool
    if (!skill.tools.includes(name)) {
      store.register({ ...skill, tools: [...skill.tools, name] })
    }

    try {
      await refreshAll()
    } catch (err) {
      console.error(`[codegen] Failed to refresh agents after registering "${name}":`, err)
    }

    return { success: true, data: { name, skill: skillName, path: filePath } }
  },
})

export const createTestToolTool = (
  registry: ToolRegistry,
): Tool => ({
  name: 'test_tool',
  description: 'Run a registered tool with sample input. Verifies a freshly-authored tool works.',
  returns: 'The tool\'s result — either { success: true, data: ... } or { success: false, error: "..." }.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      input: { type: 'object' },
    },
    required: ['name', 'input'],
  },
  execute: async (params, context) => {
    const name = params.name as string
    const input = params.input as Record<string, unknown>

    if (!name) return { success: false, error: 'name is required' }

    const tool = registry.get(name)
    if (!tool) return { success: false, error: `Tool "${name}" not found in registry` }

    try {
      return await tool.execute(input ?? {}, context)
    } catch (err) {
      return { success: false, error: `Tool threw: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
})

export const createListSkillsTool = (store: SkillStore): Tool => ({
  name: 'list_skills',
  description: 'List loaded skills with description, scope, and bundled tools.',
  returns: 'Array of skill objects with name, description, scope, and tools.',
  parameters: {},
  execute: async () => ({
    success: true,
    data: store.list().map(s => ({
      name: s.name,
      description: s.description,
      scope: s.scope.length > 0 ? s.scope : 'global',
      tools: s.tools,
    })),
  }),
})
