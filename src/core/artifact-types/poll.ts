// ============================================================================
// Poll Artifact Type
//
// A poll with immutable options and a mutable votes map.
// Options are fixed at creation. Voting uses the dedicated cast_vote tool
// (or WS command), which calls update with body: { castVote: optionId }.
// The onUpdate hook intercepts castVote and updates the votes map atomically.
//
// Polls do not auto-resolve — they require explicit resolution.
// ============================================================================

import type { Artifact, ArtifactTypeDefinition, ArtifactUpdateConfig, ArtifactUpdateResult, PollBody } from '../types.ts'

export const pollArtifactType: ArtifactTypeDefinition = {
  type: 'poll',
  description: 'A poll with fixed options. Members vote via the cast_vote tool. Resolved manually.',

  bodySchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The poll question' },
      options: {
        type: 'array',
        description: 'Fixed options (cannot be changed after creation)',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            text: { type: 'string' },
          },
          required: ['id', 'text'],
        },
      },
      votes: {
        type: 'object',
        description: 'Map of optionId → array of agent IDs who voted for it',
        additionalProperties: { type: 'array', items: { type: 'string' } },
      },
      allowMultiple: { type: 'boolean', description: 'Whether agents can vote for more than one option' },
      // Virtual field for voting — consumed by onUpdate, not stored
      castVote: { type: 'string', description: 'Option ID to vote for (used with update_artifact)' },
    },
    required: ['question', 'options', 'allowMultiple'],
  },

  onCreate: (artifact: Artifact): void => {
    // Ensure votes map is initialized for all options
    const body = artifact.body as PollBody
    const votes: Record<string, ReadonlyArray<string>> = {}
    for (const opt of body.options) {
      votes[opt.id] = []
    }
    // Note: onCreate cannot mutate artifact (it's already stored).
    // The caller (add_artifact tool) should include votes: {} in the body,
    // or the store should normalise it. We handle it in formatForContext gracefully.
  },

  onUpdate: (artifact: Artifact, updates: ArtifactUpdateConfig, ctx): ArtifactUpdateResult | void => {
    const body = artifact.body as PollBody
    const castVote = updates.body?.castVote as string | undefined

    if (castVote) {
      const validOption = body.options.find(o => o.id === castVote)
      if (!validOption) return { newBody: body }  // invalid option — no-op, don't mutate

      const votes = { ...body.votes }
      // Remove previous votes if not allowMultiple
      if (!body.allowMultiple) {
        for (const optId of Object.keys(votes)) {
          votes[optId] = (votes[optId] ?? []).filter(id => id !== ctx.callerId)
        }
      }
      // Add vote
      const current = votes[castVote] ?? []
      if (!current.includes(ctx.callerId)) {
        votes[castVote] = [...current, ctx.callerId]
      }
      return { newBody: { ...body, votes } }
    }

    // Non-vote update — only allow updating question (not options, not votes directly)
    // Shallow merge but protect options and votes from direct override
    const safeUpdates: Record<string, unknown> = {}
    if (updates.body?.question) safeUpdates.question = updates.body.question
    if (updates.body?.allowMultiple !== undefined) safeUpdates.allowMultiple = updates.body.allowMultiple
    if (Object.keys(safeUpdates).length === 0) return
    return { newBody: { ...body, ...safeUpdates } }
  },

  formatForContext: (artifact: Artifact): string => {
    const body = artifact.body as PollBody
    const votes = body.votes ?? {}
    const lines: string[] = [`Poll: "${body.question}" [id: ${artifact.id}]`]
    for (const opt of body.options) {
      const voters = votes[opt.id] ?? []
      const voteStr = voters.length === 0 ? 'no votes' : `${voters.length} vote${voters.length > 1 ? 's' : ''}`
      lines.push(`  - [${opt.id}] ${opt.text} (${voteStr})`)
    }
    if (artifact.resolution) {
      lines.push(`  Closed: ${artifact.resolution}`)
    } else {
      lines.push(`  Vote with: cast_vote { artifactId: "${artifact.id}", optionId: "<id>" }`)
    }
    return lines.join('\n')
  },

  postSystemMessageOn: ['added', 'removed', 'resolved'],
}
