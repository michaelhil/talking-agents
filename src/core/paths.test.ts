import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { samsinnHome, sharedPaths, instancePaths, trashPath, isValidInstanceId, assertValidInstanceId } from './paths.ts'
import { homedir } from 'node:os'
import { join } from 'node:path'

describe('samsinnHome', () => {
  let originalHome: string | undefined

  beforeEach(() => { originalHome = process.env.SAMSINN_HOME })
  afterEach(() => {
    if (originalHome === undefined) delete process.env.SAMSINN_HOME
    else process.env.SAMSINN_HOME = originalHome
  })

  it('defaults to ~/.samsinn when env is unset', () => {
    delete process.env.SAMSINN_HOME
    expect(samsinnHome()).toBe(join(homedir(), '.samsinn'))
  })

  it('uses SAMSINN_HOME when set', () => {
    process.env.SAMSINN_HOME = '/var/lib/samsinn'
    expect(samsinnHome()).toBe('/var/lib/samsinn')
  })

  it('treats empty SAMSINN_HOME as unset', () => {
    process.env.SAMSINN_HOME = ''
    expect(samsinnHome()).toBe(join(homedir(), '.samsinn'))
  })
})

describe('sharedPaths', () => {
  let originalHome: string | undefined
  beforeEach(() => { originalHome = process.env.SAMSINN_HOME })
  afterEach(() => {
    if (originalHome === undefined) delete process.env.SAMSINN_HOME
    else process.env.SAMSINN_HOME = originalHome
  })

  it('all derive from SAMSINN_HOME', () => {
    process.env.SAMSINN_HOME = '/tmp/x'
    expect(sharedPaths.root()).toBe('/tmp/x')
    expect(sharedPaths.providers()).toBe('/tmp/x/providers.json')
    expect(sharedPaths.packs()).toBe('/tmp/x/packs')
    expect(sharedPaths.skills()).toBe('/tmp/x/skills')
    expect(sharedPaths.tools()).toBe('/tmp/x/tools')
    expect(sharedPaths.knowledge()).toBe('/tmp/x/knowledge')
    expect(sharedPaths.adminLog()).toBe('/tmp/x/logs/admin.jsonl')
    expect(sharedPaths.instancesRoot()).toBe('/tmp/x/instances')
    expect(sharedPaths.trashRoot()).toBe('/tmp/x/instances/.trash')
  })
})

describe('instancePaths', () => {
  let originalHome: string | undefined
  beforeEach(() => { originalHome = process.env.SAMSINN_HOME })
  afterEach(() => {
    if (originalHome === undefined) delete process.env.SAMSINN_HOME
    else process.env.SAMSINN_HOME = originalHome
  })

  it('derives all per-instance paths from id', () => {
    process.env.SAMSINN_HOME = '/tmp/x'
    const p = instancePaths('abc123def456ghij')
    expect(p.root).toBe('/tmp/x/instances/abc123def456ghij')
    expect(p.snapshot).toBe('/tmp/x/instances/abc123def456ghij/snapshot.json')
    expect(p.logs).toBe('/tmp/x/instances/abc123def456ghij/logs')
    expect(p.memory).toBe('/tmp/x/instances/abc123def456ghij/memory')
  })

  it('throws on invalid id (defense-in-depth)', () => {
    process.env.SAMSINN_HOME = '/tmp/x'
    expect(() => instancePaths('../etc')).toThrow(/invalid instance id/)
    expect(() => instancePaths('')).toThrow(/invalid instance id/)
    expect(() => instancePaths('UPPERCASE12345678')).toThrow(/invalid instance id/)
  })
})

describe('assertValidInstanceId', () => {
  it('throws on invalid; passes on valid', () => {
    expect(() => assertValidInstanceId('abc123def456ghij')).not.toThrow()
    expect(() => assertValidInstanceId('../foo')).toThrow(/invalid instance id/)
    expect(() => trashPath('foo/bar')).toThrow(/invalid instance id/)
  })
})

describe('trashPath', () => {
  let originalHome: string | undefined
  beforeEach(() => { originalHome = process.env.SAMSINN_HOME })
  afterEach(() => {
    if (originalHome === undefined) delete process.env.SAMSINN_HOME
    else process.env.SAMSINN_HOME = originalHome
  })

  it('includes a timestamp suffix to disambiguate', () => {
    process.env.SAMSINN_HOME = '/tmp/x'
    expect(trashPath('abc123def456ghij', 1234567890))
      .toBe('/tmp/x/instances/.trash/abc123def456ghij-1234567890')
  })
})

describe('isValidInstanceId', () => {
  it('accepts 16-char lowercase alphanumeric', () => {
    expect(isValidInstanceId('abc123def456ghij')).toBe(true)
    expect(isValidInstanceId('0123456789abcdef')).toBe(true)
  })

  it('rejects wrong length', () => {
    expect(isValidInstanceId('abc')).toBe(false)
    expect(isValidInstanceId('abc123def456ghij1')).toBe(false)
    expect(isValidInstanceId('')).toBe(false)
  })

  it('rejects uppercase', () => {
    expect(isValidInstanceId('ABC123def456ghij')).toBe(false)
  })

  it('rejects path-traversal attempts', () => {
    expect(isValidInstanceId('../etc/passwd000')).toBe(false)
    expect(isValidInstanceId('foo/bar/baz/quux')).toBe(false)
    expect(isValidInstanceId('foo.bar.baz.quux')).toBe(false)
  })

  it('rejects whitespace', () => {
    expect(isValidInstanceId('abc 123def456ghi')).toBe(false)
  })
})
