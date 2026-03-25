import { describe, test, expect } from 'bun:test'
import { parseAddressedAgents } from './addressing.ts'

describe('parseAddressedAgents', () => {
  test('returns empty array when no addressing present', () => {
    expect(parseAddressedAgents('Hello everyone')).toEqual([])
    expect(parseAddressedAgents('')).toEqual([])
    expect(parseAddressedAgents('Check [this] out')).toEqual([])
  })

  test('parses single agent name', () => {
    expect(parseAddressedAgents('[[Analyst-1]] what do you think?')).toEqual(['Analyst-1'])
  })

  test('parses multiple agent names', () => {
    expect(parseAddressedAgents('[[Analyst-1]] [[Researcher-2]] compare your findings')).toEqual([
      'Analyst-1',
      'Researcher-2',
    ])
  })

  test('deduplicates repeated names', () => {
    expect(parseAddressedAgents('[[Alice]] hey [[Alice]] again')).toEqual(['Alice'])
  })

  test('handles names with spaces', () => {
    expect(parseAddressedAgents('[[Data Scientist]] please review')).toEqual(['Data Scientist'])
  })

  test('trims whitespace from names', () => {
    expect(parseAddressedAgents('[[ Analyst-1 ]] check this')).toEqual(['Analyst-1'])
  })

  test('ignores empty brackets', () => {
    expect(parseAddressedAgents('[[]] nothing here')).toEqual([])
    expect(parseAddressedAgents('[[  ]] nothing here')).toEqual([])
  })

  test('handles addressing at various positions', () => {
    expect(parseAddressedAgents('Hey [[Bob]]')).toEqual(['Bob'])
    expect(parseAddressedAgents('[[Bob]] hey')).toEqual(['Bob'])
    expect(parseAddressedAgents('Hey [[Bob]] how are you?')).toEqual(['Bob'])
  })

  test('does not match nested brackets', () => {
    // [[outer[inner]]] — regex stops at first ]
    const result = parseAddressedAgents('[[outer[inner]]] text')
    expect(result).toEqual(['outer[inner'])
  })

  test('works with multiple calls (regex lastIndex reset)', () => {
    expect(parseAddressedAgents('[[A]] first')).toEqual(['A'])
    expect(parseAddressedAgents('[[B]] second')).toEqual(['B'])
    expect(parseAddressedAgents('[[C]] third')).toEqual(['C'])
  })
})
