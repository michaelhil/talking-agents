// kb_query — Search the knowledge base and synthesize an answer.
// Two-phase: 1) LLM selects relevant articles from index,
// 2) LLM synthesizes answer from those articles.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const KB_DIR = join(homedir(), '.samsinn', 'knowledge')

const SELECT_PROMPT = `You are a knowledge base search engine. Given an index of articles and a question, return a JSON array of filenames that are relevant to answering the question.

Return ONLY a JSON array of strings, e.g. ["article-one", "article-two"]. No explanation. Return an empty array if nothing is relevant.`

const SYNTHESIZE_PROMPT = `You are a knowledge assistant. Answer the question using ONLY the provided articles. Cite sources using [[wikilinks]] to article filenames.

If the articles don't contain enough information to answer, say so clearly.`

const tool = {
  name: 'kb_query',
  description: 'Searches the knowledge base and synthesizes an answer from relevant articles.',
  usage: 'Use when you need to retrieve compiled knowledge. Ask a natural language question; the tool finds relevant articles and produces a cited answer.',
  returns: 'Object with the synthesized answer and list of source filenames.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'Natural language question to answer from the knowledge base' },
    },
    required: ['question'],
  },
  execute: async (params: Record<string, unknown>, context: any) => {
    if (!context.llm) {
      return { success: false, error: 'LLM not available in tool context' }
    }

    const question = params.question as string
    if (!question) return { success: false, error: 'question is required' }

    // Read index
    let index: string
    try {
      index = await readFile(join(KB_DIR, 'index.md'), 'utf-8')
    } catch {
      return { success: true, data: { answer: 'Knowledge base is empty. Use kb_ingest to add content.', sources: [] } }
    }

    if (!index.trim() || !index.includes('**')) {
      return { success: true, data: { answer: 'Knowledge base is empty. Use kb_ingest to add content.', sources: [] } }
    }

    // Phase 1: select relevant articles
    let filenames: string[]
    try {
      const selectResponse = await context.llm({
        systemPrompt: SELECT_PROMPT,
        messages: [{ role: 'user' as const, content: `Index:\n${index}\n\nQuestion: ${question}` }],
        temperature: 0.1,
        jsonMode: true,
      })
      filenames = JSON.parse(selectResponse)
      if (!Array.isArray(filenames)) filenames = []
    } catch {
      return { success: false, error: 'Failed to select relevant articles from index' }
    }

    if (filenames.length === 0) {
      return { success: true, data: { answer: 'No relevant articles found in the knowledge base.', sources: [] } }
    }

    // Phase 2: read articles and synthesize
    const articles: string[] = []
    const validSources: string[] = []
    for (const name of filenames) {
      try {
        const content = await readFile(join(KB_DIR, `${name}.md`), 'utf-8')
        articles.push(`--- ${name} ---\n${content}`)
        validSources.push(name)
      } catch {
        // Article referenced in index but file missing — skip
      }
    }

    if (articles.length === 0) {
      return { success: true, data: { answer: 'Selected articles could not be read.', sources: [] } }
    }

    try {
      const answer = await context.llm({
        systemPrompt: SYNTHESIZE_PROMPT,
        messages: [{ role: 'user' as const, content: `Articles:\n\n${articles.join('\n\n')}\n\nQuestion: ${question}` }],
        temperature: 0.3,
      })
      return { success: true, data: { answer, sources: validSources } }
    } catch (err: any) {
      return { success: false, error: `Synthesis failed: ${err?.message ?? String(err)}` }
    }
  },
}

export default tool
