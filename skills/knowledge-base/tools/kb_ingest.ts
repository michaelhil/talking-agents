// kb_ingest — Compile raw content into a wiki article.
// Reads the current index to enable cross-referencing, calls the LLM
// to produce a structured article with frontmatter and wikilinks,
// then writes the article and updates the index and log.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const KB_DIR = join(homedir(), '.samsinn', 'knowledge')

const SYSTEM_PROMPT = `You are a knowledge compiler. Given raw content, produce a structured wiki article.

Return ONLY valid JSON with this exact shape:
{
  "filename": "kebab-case-name",
  "title": "Human Readable Title",
  "tags": ["tag1", "tag2"],
  "summary": "One sentence summary",
  "body": "Markdown body with [[wikilinks]] to related concepts"
}

Rules for the body:
- Use [[wikilinks]] to reference related concepts (use kebab-case filenames, e.g. [[neural-networks]])
- Link to articles that exist in the current index AND to concepts that should exist
- One concept per article — focused and concise
- Use markdown headings, lists, and formatting
- Do not include frontmatter in the body — only the content

Rules for filename:
- Lowercase kebab-case, descriptive (e.g. "transformer-architecture")
- No file extension

Return ONLY the JSON object. No explanation, no markdown fences.`

const ensureDir = async (): Promise<void> => {
  await mkdir(KB_DIR, { recursive: true })
}

const readIndex = async (): Promise<string> => {
  try {
    return await readFile(join(KB_DIR, 'index.md'), 'utf-8')
  } catch {
    return ''
  }
}

const updateIndex = async (filename: string, summary: string, tags: ReadonlyArray<string>): Promise<void> => {
  const indexPath = join(KB_DIR, 'index.md')
  let index = await readIndex()

  const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : ''
  const entry = `- **${filename}** — ${summary}${tagStr}`

  // Update existing entry or append
  const linePattern = new RegExp(`^- \\*\\*${filename}\\*\\*.*$`, 'm')
  if (linePattern.test(index)) {
    index = index.replace(linePattern, entry)
  } else {
    if (!index.includes('# Knowledge Base Index')) {
      index = '# Knowledge Base Index\n\n'
    }
    index = index.trimEnd() + '\n' + entry + '\n'
  }

  await writeFile(indexPath, index, 'utf-8')
}

const appendLog = async (action: string, title: string): Promise<void> => {
  const logPath = join(KB_DIR, 'log.md')
  const date = new Date().toISOString().slice(0, 10)
  const entry = `[${date}] ${action} | ${title}\n`

  let log = ''
  try {
    log = await readFile(logPath, 'utf-8')
  } catch { /* new log */ }

  if (!log.includes('# Knowledge Base Log')) {
    log = '# Knowledge Base Log\n\n'
  }
  log = log.trimEnd() + '\n' + entry + '\n'
  await writeFile(logPath, log, 'utf-8')
}

const tool = {
  name: 'kb_ingest',
  description: 'Compiles raw content into a structured wiki article with frontmatter, wikilinks, and index entry.',
  usage: 'Use when you encounter information worth preserving: research findings, decisions, project context. Provide the raw content; the LLM compiles it into a structured article.',
  returns: 'Object with filename, title, tags, and linked articles.',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Raw text to compile into a wiki article' },
      title: { type: 'string', description: 'Suggested article title (LLM generates one if omitted)' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Suggested tags' },
    },
    required: ['content'],
  },
  execute: async (params: Record<string, unknown>, context: any) => {
    if (!context.llm) {
      return { success: false, error: 'LLM not available in tool context' }
    }

    const content = params.content as string
    if (!content) return { success: false, error: 'content is required' }

    await ensureDir()

    const index = await readIndex()
    const hints: string[] = []
    if (params.title) hints.push(`Suggested title: ${params.title}`)
    if (params.tags) hints.push(`Suggested tags: ${(params.tags as string[]).join(', ')}`)
    const hintsStr = hints.length > 0 ? '\n' + hints.join('\n') + '\n' : ''

    const userMessage = `Current index:\n${index || '(empty — this is the first article)'}\n${hintsStr}\nRaw content to compile:\n${content}`

    let response: string
    try {
      response = await context.llm({
        systemPrompt: SYSTEM_PROMPT,
        messages: [{ role: 'user' as const, content: userMessage }],
        temperature: 0.3,
        jsonMode: true,
      })
    } catch (err: any) {
      return { success: false, error: `LLM call failed: ${err?.message ?? String(err)}` }
    }

    let parsed: { filename: string; title: string; tags: string[]; summary: string; body: string }
    try {
      parsed = JSON.parse(response)
    } catch {
      return { success: false, error: `LLM returned invalid JSON: ${response.slice(0, 200)}` }
    }

    if (!parsed.filename || !parsed.title || !parsed.body) {
      return { success: false, error: `LLM response missing required fields (filename, title, body)` }
    }

    // Build article with frontmatter
    const tags = parsed.tags ?? []
    const frontmatter = [
      '---',
      `title: ${parsed.title}`,
      `tags: [${tags.join(', ')}]`,
      `summary: ${parsed.summary ?? ''}`,
      `updated: ${new Date().toISOString().slice(0, 10)}`,
      `sources: [${context.callerName ?? 'agent'}]`,
      '---',
    ].join('\n')

    const article = `${frontmatter}\n\n${parsed.body}\n`
    const filePath = join(KB_DIR, `${parsed.filename}.md`)

    try {
      await writeFile(filePath, article, 'utf-8')
    } catch (err: any) {
      return { success: false, error: `Failed to write article: ${err?.message ?? String(err)}` }
    }

    await updateIndex(parsed.filename, parsed.summary ?? parsed.title, tags)
    await appendLog('ingest', parsed.title)

    // Extract wikilinks for reporting
    const wikilinks = [...parsed.body.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1])

    return {
      success: true,
      data: {
        filename: parsed.filename,
        title: parsed.title,
        tags,
        linkedArticles: wikilinks,
      },
    }
  },
}

export default tool
