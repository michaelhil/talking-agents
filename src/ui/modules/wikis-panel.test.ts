import { describe, test, expect } from 'bun:test'
import { validateWikiId } from './wikis-panel.ts'

// Mirrors src/wiki/store.ts ID_PATTERN — if either changes, both must.
describe('validateWikiId', () => {
  test('accepts kebab-case starting with a letter', () => {
    expect(validateWikiId('my-wiki')).toBeNull()
    expect(validateWikiId('a')).toBeNull()
  })

  test('accepts ids starting with a digit', () => {
    expect(validateWikiId('2025-notes')).toBeNull()
  })

  test('rejects leading dash', () => {
    expect(validateWikiId('-foo')).not.toBeNull()
  })

  test('rejects uppercase', () => {
    expect(validateWikiId('Foo')).not.toBeNull()
    expect(validateWikiId('foo-Bar')).not.toBeNull()
  })

  test('rejects empty string', () => {
    expect(validateWikiId('')).not.toBeNull()
  })

  test('accepts the 63-char boundary', () => {
    expect(validateWikiId('a' + '-'.repeat(62))).toBeNull()
  })

  test('rejects 64+ chars', () => {
    expect(validateWikiId('a' + '-'.repeat(63))).not.toBeNull()
  })

  test('rejects underscores and dots', () => {
    expect(validateWikiId('foo_bar')).not.toBeNull()
    expect(validateWikiId('foo.bar')).not.toBeNull()
  })
})
