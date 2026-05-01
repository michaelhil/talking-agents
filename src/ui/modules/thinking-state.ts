// DOM-local ephemeral state for the thinking indicator. Single shared Set
// of agent IDs whose first stream chunk has been observed; used by both
// app-thinking.ts (the controller) and thinking-display.ts (the listeners).
// Lives outside both so neither has to thread it through deps.

export const firstChunkSeen: Set<string> = new Set()
