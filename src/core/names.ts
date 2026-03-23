// ============================================================================
// Name utilities — validation and uniqueness for entity names.
// Used by house.ts and team.ts. Lives in core/ to avoid inverted dependencies.
// ============================================================================

// Maximum allowed name length (prevents excessive LLM token usage)
const MAX_NAME_LENGTH = 100

// Validate an entity name. Throws on invalid input.
export const validateName = (name: string, entityType: string): void => {
  if (!name || name.trim().length === 0) {
    throw new Error(`${entityType} name cannot be empty`)
  }
  if (name !== name.trim()) {
    throw new Error(`${entityType} name cannot have leading or trailing whitespace`)
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`${entityType} name cannot exceed ${MAX_NAME_LENGTH} characters`)
  }
}

// Ensure a name is unique within a set of existing names.
// Case-insensitive comparison, case-preserving storage.
// Returns the name as-is if unique, or appends -2, -3, etc. if taken.
export const ensureUniqueName = (name: string, existingNames: ReadonlyArray<string>): string => {
  const lowerNames = new Set(existingNames.map(n => n.toLowerCase()))
  if (!lowerNames.has(name.toLowerCase())) return name
  let counter = 2
  while (lowerNames.has(`${name.toLowerCase()}-${counter}`)) counter++
  return `${name}-${counter}`
}
