import { describe, test, expect } from 'bun:test'
import { parseAddressedAgents } from './addressing.ts'

describe('parseAddressedAgents', () => {
  test('returns empty array when no addressing present', () => {
    expect(parseAddressedAgents('Hello everyone')).toEqual([])
    expect(parseAddressedAgents('')).toEqual([])
    expect(parseAddressedAgents('Check [this] out')).toEqual([])
  })

  test('parses single agent name', () => {
    expect(parseAddressedAgents('[[Analyst-1]] what do you think?')).toEqual([
      { kind: 'name', value: 'Analyst-1' },
    ])
  })

  test('parses multiple agent names', () => {
    expect(parseAddressedAgents('[[Analyst-1]] [[Researcher-2]] compare your findings')).toEqual([
      { kind: 'name', value: 'Analyst-1' },
      { kind: 'name', value: 'Researcher-2' },
    ])
  })

  test('deduplicates repeated names', () => {
    expect(parseAddressedAgents('[[Alice]] hey [[Alice]] again')).toEqual([
      { kind: 'name', value: 'Alice' },
    ])
  })

  test('handles names with spaces', () => {
    expect(parseAddressedAgents('[[Data Scientist]] please review')).toEqual([
      { kind: 'name', value: 'Data Scientist' },
    ])
  })

  test('trims whitespace from names', () => {
    expect(parseAddressedAgents('[[ Analyst-1 ]] check this')).toEqual([
      { kind: 'name', value: 'Analyst-1' },
    ])
  })

  test('ignores empty brackets', () => {
    expect(parseAddressedAgents('[[]] nothing here')).toEqual([])
    expect(parseAddressedAgents('[[  ]] nothing here')).toEqual([])
  })

  test('handles addressing at various positions', () => {
    expect(parseAddressedAgents('Hey [[Bob]]')).toEqual([{ kind: 'name', value: 'Bob' }])
    expect(parseAddressedAgents('[[Bob]] hey')).toEqual([{ kind: 'name', value: 'Bob' }])
    expect(parseAddressedAgents('Hey [[Bob]] how are you?')).toEqual([{ kind: 'name', value: 'Bob' }])
  })

  test('does not match nested brackets', () => {
    // [[outer[inner]]] — regex stops at first ]
    const result = parseAddressedAgents('[[outer[inner]]] text')
    expect(result).toEqual([{ kind: 'name', value: 'outer[inner' }])
  })

  test('works with multiple calls (regex lastIndex reset)', () => {
    expect(parseAddressedAgents('[[A]] first')).toEqual([{ kind: 'name', value: 'A' }])
    expect(parseAddressedAgents('[[B]] second')).toEqual([{ kind: 'name', value: 'B' }])
    expect(parseAddressedAgents('[[C]] third')).toEqual([{ kind: 'name', value: 'C' }])
  })

  test('parses tag addressing', () => {
    expect(parseAddressedAgents('[[tag:analyst]] please review')).toEqual([
      { kind: 'tag', value: 'analyst' },
    ])
  })

  test('parses mixed name and tag addressing', () => {
    expect(parseAddressedAgents('[[Alice]] and [[tag:researcher]] compare notes')).toEqual([
      { kind: 'name', value: 'Alice' },
      { kind: 'tag', value: 'researcher' },
    ])
  })
})
