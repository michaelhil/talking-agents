# Artifact Modules — Design

## Problem

Every new artifact type (todos, blackboard, …) requires the same seven implementation
layers spread across seven files:

1. Type definition (`types.ts`)
2. Storage + CRUD (`room.ts` / `house.ts`)
3. LLM context injection (`context-builder.ts`)
4. Agent tools (`built-in.ts`)
5. WS event handlers (`ws-handler.ts`)
6. HTTP endpoints (`http-routes.ts`)
7. Snapshot persistence (`snapshot.ts`)

Adding a second artifact type (blackboard) means duplicating the entire todos stack.
Three types means three stacks. The cost grows linearly; the design does not scale.

---

## Core Abstraction: `ArtifactModule<T>`

Each artifact type is a self-contained module that declares all seven concerns in one place.

```typescript
interface ArtifactModule<T extends { readonly id: string; readonly updatedAt: number }> {
  // Identity
  readonly name: string                          // 'todos', 'blackboard', 'files'
  readonly scope: 'room' | 'house'               // where items live

  // Lifecycle
  readonly create: (data: unknown) => T          // validate + stamp id/timestamps
  readonly update: (item: T, patch: unknown) => T  // partial update + stamp updatedAt
  readonly isValidPatch: (patch: unknown) => boolean

  // LLM integration
  readonly toContext: (items: ReadonlyArray<T>) => string  // injected into system prompt

  // Tools (agent-callable)
  readonly tools: ReadonlyArray<Tool>            // list, add, update — bound at register time
}
```

The infrastructure (WS, HTTP, snapshot, context) iterates registered modules generically.
Adding a new artifact type = new module file + one `registry.register(module)` call.

---

## Scope: Room vs House

**Room-scoped** — items belong to one room, visible only to agents in that room.
Suitable for: todos, meeting notes, per-conversation scratchpads.

**House-scoped** — items live at the top level, visible across all rooms.
Suitable for: knowledge blackboard, project task board, shared memory.

Both scopes use the same `ArtifactModule<T>` interface. The difference is storage location
and context injection:

- Room-scoped: injected into `=== ROOM CONTEXT ===` section (per-room system prompt)
- House-scoped: injected into `=== SHARED KNOWLEDGE ===` section (every agent, every room)

Tools for room-scoped artifacts receive `roomId` via `ToolContext`.
Tools for house-scoped artifacts receive a `House` reference via closure at registration.

---

## Storage

Room and House both gain a generic artifact store instead of hardcoded artifact fields:

```typescript
// Replaces: todos: Map<string, TodoItem>
// With:
type ArtifactStore = Map<string /* moduleName */, Map<string /* id */, unknown>>
```

Access is always typed through the module's `create`/`update` functions —
the store itself is untyped internally but typed at the boundary.

```typescript
// Room gains:
getArtifacts<T>(moduleName: string): ReadonlyArray<T>
addArtifact<T>(moduleName: string, data: unknown): T
updateArtifact<T>(moduleName: string, id: string, patch: unknown): T | undefined
removeArtifact(moduleName: string, id: string): boolean

// House gains the same four methods for house-scoped modules.
```

Snapshot serialization becomes a loop over registered modules rather than
per-artifact-type code.

---

## Tools

Each module owns its tools. Tools are bound to the module at registration:

```typescript
// Room-scoped module example (todos)
const todoModule: ArtifactModule<TodoItem> = {
  name: 'todos',
  scope: 'room',
  tools: [
    {
      name: 'list_todos',
      description: 'List all todos in the current room',
      parameters: {},
      execute: async (_args, ctx) => {
        const room = house.getRoom(ctx.roomId!)
        if (!room) return { success: false, error: 'Room not found' }
        return { success: true, result: formatTodos(room.getArtifacts('todos')) }
      },
    },
    // add_todo, update_todo …
  ],
}
```

At agent spawn, tools from all registered modules are included in `agentTools`
automatically — no manual tool registration per artifact type.

---

## WS / HTTP Protocol

The WS and HTTP layers gain a generic artifact router:

```typescript
// WS dispatch (replaces case-per-artifact-type)
case 'artifact_add':    handleArtifactAdd(msg, room, module, wsManager)
case 'artifact_update': handleArtifactUpdate(msg, room, module, wsManager)
case 'artifact_remove': handleArtifactRemove(msg, room, module, wsManager)

// HTTP routes (replaces per-artifact route blocks)
GET    /api/rooms/:name/artifacts/:module
POST   /api/rooms/:name/artifacts/:module
PUT    /api/rooms/:name/artifacts/:module/:id
DELETE /api/rooms/:name/artifacts/:module/:id

// House-scoped equivalent
GET    /api/artifacts/:module
POST   /api/artifacts/:module
PUT    /api/artifacts/:module/:id
DELETE /api/artifacts/:module/:id
```

The WS event type becomes `artifact_changed` with a `moduleName` field,
replacing `todo_changed` and future per-type events:

```typescript
{ type: 'artifact_changed', moduleName: 'todos', scope: 'room',
  roomName?: string, action: 'added' | 'updated' | 'removed', item: unknown }
```

---

## Migration Path

1. **Define `ArtifactModule<T>`** in `types.ts`
2. **Add generic store** to `Room` (replacing `todos` map) and `House`
3. **Extract `TodoModule`** — refactor existing todos code into the module interface;
   all current behaviour preserved, zero regression
4. **Update infrastructure** — WS, HTTP, snapshot, context-builder iterate modules
5. **Existing tests pass unchanged** — todos behave identically
6. **New artifact types** — create module file, register once, done

The refactor can be done in a single commit by moving todos into the new shape
before adding any new artifact types. Cost: one larger refactor now vs unbounded
cost per new type later.

---

## Blackboard (House-scoped example)

A knowledge blackboard is a set of named entries agents can read and write:

```typescript
interface BlackboardEntry {
  readonly id: string
  readonly key: string       // human-readable name ("capital_of_france")
  readonly value: string     // the knowledge ("Paris")
  readonly source: string    // agent name that wrote it
  readonly createdAt: number
  readonly updatedAt: number
}

const blackboardModule: ArtifactModule<BlackboardEntry> = {
  name: 'blackboard',
  scope: 'house',
  toContext: (entries) => entries.map(e => `${e.key}: ${e.value}`).join('\n'),
  tools: [ read_blackboard, write_blackboard, clear_blackboard ],
  // …
}
```

Agents in any room see the blackboard in their `=== SHARED KNOWLEDGE ===` context section.
Any agent in any room can write to it. Cross-room coordination without coupling rooms.
