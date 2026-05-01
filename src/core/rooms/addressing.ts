// ============================================================================
// Addressing — Parse [[AgentName]] and [[tag:TagName]] patterns from content.
//
// Used by Room to determine directed delivery targets.
// Works in all delivery modes as a universal delivery override.
//
// Syntax:
//   [[AgentName]]    — direct a named agent
//   [[tag:TagName]]  — all agents in the room carrying this tag (case-insensitive)
// ============================================================================

const ADDRESS_RE = /\[\[([^\]]+)\]\]/g

export interface AddressedTarget {
  readonly kind: 'name' | 'tag'
  readonly value: string
}

export const parseAddressedAgents = (content: string): ReadonlyArray<AddressedTarget> => {
  const seen = new Set<string>()
  const targets: AddressedTarget[] = []
  let match: RegExpExecArray | null
  ADDRESS_RE.lastIndex = 0
  while ((match = ADDRESS_RE.exec(content)) !== null) {
    const raw = match[1]!.trim()
    if (raw.length === 0) continue
    const key = raw.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (key.startsWith('tag:')) {
      targets.push({ kind: 'tag', value: raw.slice(4).trim() })
    } else {
      targets.push({ kind: 'name', value: raw })
    }
  }
  return targets
}
