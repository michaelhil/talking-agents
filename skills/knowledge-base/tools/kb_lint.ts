// kb_lint — Check knowledge base health.
// Finds orphan articles, broken wikilinks, and index inconsistencies.
// No LLM calls — pure filesystem inspection.

import { readFile, readdir } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'
import { homedir } from 'node:os'

const KB_DIR = join(homedir(), '.samsinn', 'knowledge')
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g

const tool = {
  name: 'kb_lint',
  description: 'Checks knowledge base health: orphan articles, broken wikilinks, index inconsistencies.',
  usage: 'Run periodically to find quality issues in the knowledge base.',
  returns: 'Object with arrays of orphans, broken links, and missing index entries.',
  parameters: {},
  execute: async () => {
    // Read all article files
    let entries: string[]
    try {
      entries = await readdir(KB_DIR)
    } catch {
      return { success: true, data: { orphans: [], brokenLinks: [], missingFromIndex: [], articleCount: 0 } }
    }

    const articleFiles = entries
      .filter(f => extname(f) === '.md' && f !== 'index.md' && f !== 'log.md')
      .map(f => basename(f, '.md'))

    if (articleFiles.length === 0) {
      return { success: true, data: { orphans: [], brokenLinks: [], missingFromIndex: [], articleCount: 0 } }
    }

    const articleSet = new Set(articleFiles)

    // Read index
    let indexContent = ''
    try {
      indexContent = await readFile(join(KB_DIR, 'index.md'), 'utf-8')
    } catch { /* no index */ }

    const indexedNames = new Set<string>()
    for (const match of indexContent.matchAll(/^\- \*\*([^*]+)\*\*/gm)) {
      indexedNames.add(match[1])
    }

    // Read all articles and collect wikilinks
    const inboundLinks = new Map<string, string[]>() // target → [sources]
    const brokenLinks: Array<{ source: string; target: string }> = []

    for (const name of articleFiles) {
      let content: string
      try {
        content = await readFile(join(KB_DIR, `${name}.md`), 'utf-8')
      } catch { continue }

      for (const match of content.matchAll(WIKILINK_RE)) {
        const target = match[1]
        if (!articleSet.has(target)) {
          brokenLinks.push({ source: name, target })
        } else {
          const existing = inboundLinks.get(target) ?? []
          existing.push(name)
          inboundLinks.set(target, existing)
        }
      }
    }

    // Orphans: articles with no inbound wikilinks from other articles
    const orphans = articleFiles.filter(name => !(inboundLinks.get(name)?.length))

    // Missing from index: article files not in index.md
    const missingFromIndex = articleFiles.filter(name => !indexedNames.has(name))

    return {
      success: true,
      data: {
        articleCount: articleFiles.length,
        orphans,
        brokenLinks,
        missingFromIndex,
      },
    }
  },
}

export default tool
