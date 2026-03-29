import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import tools from './web.ts'

const ctx = { callerId: 'test-id', callerName: 'TestAgent' }

const toolMap = Object.fromEntries(tools.map(t => [t.name, t]))

describe('web_search', () => {
  let savedBrave: string | undefined
  let savedSerper: string | undefined

  beforeAll(() => {
    savedBrave = process.env.BRAVE_API_KEY
    savedSerper = process.env.SERPER_API_KEY
    delete process.env.BRAVE_API_KEY
    delete process.env.SERPER_API_KEY
  })

  afterAll(() => {
    if (savedBrave !== undefined) {
      process.env.BRAVE_API_KEY = savedBrave
    }
    if (savedSerper !== undefined) {
      process.env.SERPER_API_KEY = savedSerper
    }
  })

  test('returns error when no API key is set', async () => {
    const webSearch = toolMap['web_search']
    expect(webSearch).toBeDefined()
    const result = await webSearch!.execute({ query: 'test query' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('BRAVE_API_KEY')
    expect(result.error).toContain('SERPER_API_KEY')
  })

  test('returns error for missing query parameter', async () => {
    const webSearch = toolMap['web_search']
    const result = await webSearch!.execute({}, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })
})

describe('fetch_url', () => {
  test('fetches https://example.com and returns text content', async () => {
    const fetchUrl = toolMap['fetch_url']
    expect(fetchUrl).toBeDefined()

    const result = await fetchUrl!.execute({ url: 'https://example.com' }, ctx)
    expect(result.success).toBe(true)

    const data = result.data as { title: string; text: string; url: string; chars: number }
    expect(typeof data.title).toBe('string')
    expect(typeof data.text).toBe('string')
    expect(data.url).toBe('https://example.com')
    expect(typeof data.chars).toBe('number')
    expect(data.chars).toBeGreaterThan(0)
    // example.com is a well-known IANA page
    expect(data.text.toLowerCase()).toContain('example')
  })

  test('returns error for missing url parameter', async () => {
    const fetchUrl = toolMap['fetch_url']
    const result = await fetchUrl!.execute({}, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })

  test('strips HTML tags from fetched content', async () => {
    const fetchUrl = toolMap['fetch_url']
    const result = await fetchUrl!.execute({ url: 'https://example.com' }, ctx)
    expect(result.success).toBe(true)
    const data = result.data as { text: string }
    // Should not contain any HTML tags
    expect(data.text).not.toMatch(/<[^>]+>/)
  })
})
