---
name: knowledge-base
description: Use when you need to compile, store, or retrieve structured knowledge that should persist across conversations
---

## When to use this vs memory tools

- `remember`/`recall`: quick facts, preferences, operational state ("user prefers metric", "API key is X")
- `kb_ingest`/`kb_query`: compiled understanding, research summaries, project context, synthesized insights

## Ingesting knowledge

Use `kb_ingest` when you encounter information worth preserving: research findings, architectural decisions, project context, meeting conclusions, synthesized analysis.

Provide the raw content and optionally suggest a title and tags. The tool compiles it into a structured wiki article with cross-references to existing articles.

## Querying knowledge

Use `kb_query` with a natural language question. It searches the index, reads relevant articles, and synthesizes an answer with citations.

## Article conventions

- YAML frontmatter: title, tags, summary, updated, sources
- Cross-reference related concepts with `[[wikilinks]]`
- One concept per article — split broad topics into linked articles
- Keep articles focused and concise

## Maintenance

Run `kb_lint` periodically to find orphan articles, broken wikilinks, and articles missing from the index.
