import { describe, test, expect, afterAll } from 'bun:test'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import tools from './memory.ts'

const ctx = { callerId: 'test-id', callerName: 'TestAgent_memory_' + Date.now() }

const sanitizeName = (name: string): string => name.replace(/[^a-zA-Z0-9]/g, '_')
const testMemoryDir = join(homedir(), '.samsinn', 'memory', sanitizeName(ctx.callerName))

afterAll(async () => {
  await rm(testMemoryDir, { recursive: true, force: true })
})

const toolMap = Object.fromEntries(tools.map(t => [t.name, t]))

describe('think', () => {
  test('returns success with the reasoning echoed back', async () => {
    const tool = toolMap['think']
    expect(tool).toBeDefined()
    const result = await tool!.execute({ reasoning: 'I should check the database first.' }, ctx)
    expect(result.success).toBe(true)
  })
})

describe('note + my_notes', () => {
  test('note appends an entry and my_notes retrieves it', async () => {
    const note = toolMap['note']
    const myNotes = toolMap['my_notes']
    expect(note).toBeDefined()
    expect(myNotes).toBeDefined()

    const content = 'Observed: system is running smoothly at ' + Date.now()
    const writeResult = await note!.execute({ content }, ctx)
    expect(writeResult.success).toBe(true)
    expect((writeResult.data as { logged: boolean }).logged).toBe(true)

    const readResult = await myNotes!.execute({ limit: 10 }, ctx)
    expect(readResult.success).toBe(true)
    const entries = readResult.data as Array<{ timestamp: string; content: string }>
    expect(Array.isArray(entries)).toBe(true)
    expect(entries.some(e => e.content === content)).toBe(true)
  })

  test('my_notes returns empty array when log does not exist', async () => {
    const freshCtx = { callerId: 'fresh-id', callerName: 'NeverWrittenAgent_' + Date.now() }
    const myNotes = toolMap['my_notes']
    const result = await myNotes!.execute({}, freshCtx)
    expect(result.success).toBe(true)
    expect(result.data).toEqual([])
  })
})

describe('remember + recall + forget', () => {
  test('remember stores a fact and recall retrieves it', async () => {
    const remember = toolMap['remember']
    const recall = toolMap['recall']
    expect(remember).toBeDefined()
    expect(recall).toBeDefined()

    const remResult = await remember!.execute({ key: 'project_name', value: 'Samsinn' }, ctx)
    expect(remResult.success).toBe(true)
    expect((remResult.data as { key: string; value: string }).key).toBe('project_name')

    const recResult = await recall!.execute({ key: 'project_name' }, ctx)
    expect(recResult.success).toBe(true)
    const recData = recResult.data as { key: string; value: string }
    expect(recData.key).toBe('project_name')
    expect(recData.value).toBe('Samsinn')
  })

  test('recall returns null value for a missing key', async () => {
    const recall = toolMap['recall']
    const result = await recall!.execute({ key: 'does_not_exist_xyz' }, ctx)
    expect(result.success).toBe(true)
    const data = result.data as { key: string; value: string | null }
    expect(data.key).toBe('does_not_exist_xyz')
    expect(data.value).toBeNull()
  })

  test('forget removes the key and recall returns null afterwards', async () => {
    const remember = toolMap['remember']
    const recall = toolMap['recall']
    const forget = toolMap['forget']
    expect(forget).toBeDefined()

    await remember!.execute({ key: 'temp_fact', value: 'temporary' }, ctx)

    const forgetResult = await forget!.execute({ key: 'temp_fact' }, ctx)
    expect(forgetResult.success).toBe(true)
    const forgetData = forgetResult.data as { key: string; removed: boolean }
    expect(forgetData.removed).toBe(true)

    const recallResult = await recall!.execute({ key: 'temp_fact' }, ctx)
    expect(recallResult.success).toBe(true)
    const recallData = recallResult.data as { key: string; value: string | null }
    expect(recallData.value).toBeNull()
  })

  test('forget on a non-existent key returns removed: false', async () => {
    const forget = toolMap['forget']
    const result = await forget!.execute({ key: 'never_existed_abc' }, ctx)
    expect(result.success).toBe(true)
    const data = result.data as { removed: boolean }
    expect(data.removed).toBe(false)
  })
})
