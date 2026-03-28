import { describe, test, expect, beforeEach } from 'bun:test'
import { join, resolve } from 'node:path'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { loadToolDirectory, loadExternalTools } from './loader.ts'
import { createToolRegistry } from '../core/tool-registry.ts'

const FIXTURES = resolve(import.meta.dir, '__fixtures__')

// Registry is recreated per test to avoid cross-test pollution
const makeRegistry = () => createToolRegistry()

describe('loadToolDirectory', () => {
  test('non-existent directory returns empty result without error', async () => {
    const registry = makeRegistry()
    const result = await loadToolDirectory('/does/not/exist/at/all', registry)
    expect(result.loaded).toHaveLength(0)
    expect(result.skipped).toHaveLength(0)
    expect(result.errors).toHaveLength(0)
  })

  test('valid single-tool file is loaded and registered', async () => {
    const registry = makeRegistry()
    // Use a subdirectory containing only single-tool.ts via a temp symlink-free approach:
    // Write a temp dir with just this file to avoid picking up other fixtures
    const dir = await mkdtemp(join(tmpdir(), 'samsinn-loader-test-'))
    try {
      await writeFile(join(dir, 'my-tool.ts'), `export default {
  name: 'loader_test_single',
  description: 'Test single load',
  parameters: {},
  execute: async () => ({ success: true }),
}`)
      const result = await loadToolDirectory(dir, registry)
      expect(result.loaded).toContain('loader_test_single')
      expect(result.errors).toHaveLength(0)
      expect(registry.has('loader_test_single')).toBe(true)
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  test('array default export loads all tools in the array', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samsinn-loader-test-'))
    try {
      await writeFile(join(dir, 'multi.ts'), `export default [
  { name: 'loader_arr_a', description: 'A', parameters: {}, execute: async () => ({ success: true }) },
  { name: 'loader_arr_b', description: 'B', parameters: {}, execute: async () => ({ success: true }) },
]`)
      const registry = makeRegistry()
      const result = await loadToolDirectory(dir, registry)
      expect(result.loaded).toContain('loader_arr_a')
      expect(result.loaded).toContain('loader_arr_b')
      expect(result.loaded).toHaveLength(2)
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  test('tool missing execute is skipped, not errored', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samsinn-loader-test-'))
    try {
      await writeFile(join(dir, 'no-exec.ts'), `export default {
  name: 'loader_no_exec',
  description: 'No execute',
  parameters: {},
}`)
      const registry = makeRegistry()
      const result = await loadToolDirectory(dir, registry)
      expect(result.loaded).toHaveLength(0)
      expect(result.skipped).toHaveLength(1)
      expect(result.errors).toHaveLength(0)
      expect(registry.has('loader_no_exec')).toBe(false)
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  test('tool name with spaces is skipped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samsinn-loader-test-'))
    try {
      await writeFile(join(dir, 'bad-name.ts'), `export default {
  name: 'bad name here',
  description: 'Invalid name',
  parameters: {},
  execute: async () => ({ success: true }),
}`)
      const registry = makeRegistry()
      const result = await loadToolDirectory(dir, registry)
      expect(result.skipped).toHaveLength(1)
      expect(result.skipped[0]).toContain('"bad name here"')
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  test('file that throws on import is recorded in errors, does not crash loader', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samsinn-loader-test-'))
    try {
      // Use a unique filename each test run to avoid Bun's module cache
      const uniqueName = `throws-${Date.now()}.ts`
      await writeFile(join(dir, uniqueName), `throw new Error('Intentional import failure')`)
      const registry = makeRegistry()
      const result = await loadToolDirectory(dir, registry)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('Intentional import failure')
      expect(result.loaded).toHaveLength(0)
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  test('name conflict with existing registered tool skips external tool', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samsinn-loader-test-'))
    try {
      await writeFile(join(dir, 'conflict.ts'), `export default {
  name: 'get_time',
  description: 'Trying to shadow get_time',
  parameters: {},
  execute: async () => ({ success: true }),
}`)
      const registry = makeRegistry()
      // Pre-register a tool with the same name
      registry.register({ name: 'get_time', description: 'Original', parameters: {}, execute: async () => ({ success: true }) })
      const originalTool = registry.get('get_time')

      const result = await loadToolDirectory(dir, registry)
      expect(result.skipped).toHaveLength(1)
      expect(result.skipped[0]).toContain('"get_time"')
      // Original tool is preserved
      expect(registry.get('get_time')).toBe(originalTool)
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  test('files starting with _ are ignored', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samsinn-loader-test-'))
    try {
      await writeFile(join(dir, '_helper.ts'), `export const helper = 'ignored'`)
      await writeFile(join(dir, 'real-tool.ts'), `export default {
  name: 'loader_underscore_test',
  description: 'Real tool',
  parameters: {},
  execute: async () => ({ success: true }),
}`)
      const registry = makeRegistry()
      const result = await loadToolDirectory(dir, registry)
      expect(result.loaded).toEqual(['loader_underscore_test'])
      expect(result.loaded).not.toContain('helper')
    } finally {
      await rm(dir, { recursive: true })
    }
  })
})

describe('loadExternalTools', () => {
  test('runs without error when no tool directories exist', async () => {
    const registry = makeRegistry()
    // All default dirs likely don't exist in CI — should complete silently
    await expect(loadExternalTools(registry)).resolves.toBeUndefined()
  })

  test('loads from SAMSINN_TOOLS_DIR env var when set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samsinn-env-tools-'))
    const original = process.env.SAMSINN_TOOLS_DIR
    try {
      await writeFile(join(dir, 'env-tool.ts'), `export default {
  name: 'loader_env_tool',
  description: 'Loaded via SAMSINN_TOOLS_DIR',
  parameters: {},
  execute: async () => ({ success: true }),
}`)
      process.env.SAMSINN_TOOLS_DIR = dir
      const registry = makeRegistry()
      await loadExternalTools(registry)
      expect(registry.has('loader_env_tool')).toBe(true)
    } finally {
      process.env.SAMSINN_TOOLS_DIR = original
      await rm(dir, { recursive: true })
    }
  })
})
