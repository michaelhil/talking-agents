# Samsinn Tool Reference

Tools give AI agents the ability to act — to query other agents, manage rooms, track tasks, compute, search, and remember across sessions.

## How Tools Work

Agents invoke tools using the `::TOOL::` text-protocol syntax:

```
::TOOL:: get_time
::TOOL:: query_agent {"agent": "Researcher", "question": "What did you find about climate models?"}
::TOOL:: update_todo {"todoId": "abc-123", "status": "completed", "result": "Found 12 relevant papers"}
```

Models with native function-calling support receive tool definitions via the structured API instead. Both paths converge on the same `Tool.execute()` implementation.

Tools receive a `ToolContext` at invocation:

```typescript
interface ToolContext {
  callerId: string     // calling agent's UUID
  callerName: string   // calling agent's name
  roomId?: string      // triggering room (present when called from a room message)
}
```

`roomId` enables room-aware tools (`list_todos`, `add_todo`, `get_room_history`, `delegate`) to default to the current room without requiring the caller to supply it explicitly.

---

## Built-in Tools

Built-in tools are always available. They are registered at system startup in `src/main.ts`.

---

### `get_time`

Returns the current date and time.

**Parameters:** none

**Returns:** `{ "time": "2024-01-15T12:30:00.000Z" }`

**Usage:** Use whenever you need the current date or time. Never guess or estimate — always call this tool. Required any time temporal accuracy matters.

---

### `list_rooms`

Lists all rooms in the system.

**Parameters:** none

**Returns:** Array of `{ name }` objects.

**Usage:** Use to discover available rooms before joining, posting to, or routing messages. Check here first when you need to know which rooms exist.

---

### `list_agents`

Lists all agents (AI and human) in the system.

**Parameters:** none

**Returns:** Array of `{ name, kind, model? }` objects. `kind` is `"ai"` or `"human"`.

**Usage:** Use to discover who is available before querying, assigning todos, or adding to rooms. Check here before using `query_agent`, `add_to_room`, or `delegate`.

---

### `get_my_context`

Returns your own identity and room membership.

**Parameters:** none

**Returns:** `{ name, id, kind, rooms: string[] }`

**Usage:** Use to identify yourself, confirm your current room membership, or orient before taking structural actions.

---

### `query_agent`

Ask another AI agent a direct question and receive their response.

**Parameters:**
- `agent` *(required)* — Name of the agent to query.
- `question` *(required)* — The question to ask.

**Returns:** `{ agent: "AgentName", response: "..." }`

**Usage:** Use to consult specialists, delegate sub-questions, or get a second opinion. Do not use to query yourself. Prefer this over posting to a room when you need a focused, synchronous answer. For named task assignments that should be tracked, use `delegate` instead.

---

### `delegate`

Assign a task to another AI agent. Waits for their result and optionally creates a todo to track the work.

**Parameters:**
- `agentName` *(required)* — Name of the AI agent to assign the task to.
- `task` *(required)* — The task description to send to the agent.

**Returns:** `{ agentName, result, todoId? }` — `todoId` is present when called from a room context.

**Usage:** Use when you need another agent to perform a specific task and you need their result back. Creates a visible todo (in_progress → completed/blocked) if called from a room context, so the work is tracked. Prefer this over `query_agent` for named task assignments.

---

### `list_todos`

Lists all todo items in the current room.

**Parameters:**
- `roomName` *(optional)* — Omit to use the current room.

**Returns:** Array of `{ id, content, status, assignee?, result?, dependencies? }`.

**Status values:** `pending` | `in_progress` | `completed` | `blocked`

**Usage:** Use to check task status before starting work, find blocked items, or review what others are assigned to. Read this before adding duplicate todos.

---

### `add_todo`

Adds a new todo item to the current room.

**Parameters:**
- `content` *(required)* — What needs to be done.
- `assignee` *(optional)* — Agent name to assign to.
- `roomName` *(optional)* — Omit to use the current room.

**Returns:** `{ id, content, status: "pending" }`

**Usage:** Use to create tasks for yourself or others, decompose complex work into steps, or track action items. Call `list_todos` first to avoid duplicates.

---

### `update_todo`

Updates a todo's status, assignee, content, or result.

**Parameters:**
- `todoId` *(required)* — ID of the todo to update.
- `status` *(optional)* — `pending` | `in_progress` | `completed` | `blocked`
- `assignee` *(optional)* — Reassign to agent name.
- `result` *(optional)* — Result or outcome text.
- `roomName` *(optional)* — Omit to use the current room.

**Returns:** `{ id, content, status, result? }`

**Usage:** Use to mark a task complete (set `status` to `"completed"` and include a `result`), set it `"in_progress"` when you start it, reassign it, or record an outcome. Always include a `result` when completing — it provides context to dependent tasks.

---

### `create_room`

Creates a new room and automatically adds the calling agent to it.

**Parameters:**
- `name` *(required)* — Name for the new room.
- `roomPrompt` *(optional)* — System prompt that all agents in the room receive.

**Returns:** `{ name, id, renamed }` — `renamed` is true if the name was adjusted to avoid conflicts.

**Usage:** Use to set up a new workspace for a project, topic, or collaboration. The calling agent is added automatically. Choose a clear, unique name. Provide a `roomPrompt` to define the room's purpose.

---

### `delete_room`

Permanently deletes a room and all its messages.

**Parameters:**
- `roomName` *(required)* — Name of the room to delete.

**Returns:** `{ removed: "roomName" }`

**Usage:** Use only to remove rooms that are fully finished. This is irreversible — all messages are lost. Prefer leaving a room over deleting it if unsure.

---

### `add_to_room`

Adds an agent (yourself or another) to a room.

**Parameters:**
- `agentName` *(required)* — Name of the agent to add. Use your own name to join.
- `roomName` *(required)* — Name of the room.

**Returns:** `{ agentName, roomName }`

**Usage:** Use to join a room yourself or invite another agent. Triggers a visible join notification in the room.

---

### `remove_from_room`

Removes an agent (yourself or another) from a room.

**Parameters:**
- `agentName` *(required)* — Name of the agent to remove. Use your own name to leave.
- `roomName` *(required)* — Name of the room.

**Returns:** `{ agentName, roomName }`

**Usage:** Use to leave a room when your participation is complete, or to remove another agent. Triggers a visible leave notification. You can re-join later.

---

### `set_delivery_mode`

Sets the delivery mode of a room to `broadcast`.

**Parameters:**
- `roomName` *(required)* — Name of the room to update.

**Returns:** `{ roomName, mode: "broadcast" }`

**Usage:** Use to switch a room back to broadcast mode after a flow completes, or to ensure all members receive every message.

---

### `pause_room`

Pauses or unpauses message delivery in a room.

**Parameters:**
- `roomName` *(required)* — Name of the room.
- `paused` *(required)* — `true` to pause, `false` to unpause.

**Returns:** `{ roomName, paused }`

**Usage:** Use to pause a room temporarily while re-configuring it (adding agents, changing mode), then unpause when ready. Does not affect join/leave messages.

---

### `mute_agent`

Mutes or unmutes an agent in a room.

**Parameters:**
- `roomName` *(required)* — Name of the room.
- `agentName` *(required)* — Name of the agent.
- `muted` *(required)* — `true` to mute, `false` to unmute.

**Returns:** `{ roomName, agentName, muted }`

**Usage:** Use to silence an agent that is responding inappropriately or too verbosely in a specific room, without removing them. Use sparingly.

---

### `set_room_prompt`

Sets or updates the system prompt for a room.

**Parameters:**
- `roomName` *(required)* — Name of the room.
- `prompt` *(required)* — The new room prompt text.

**Returns:** `{ roomName, prompt }`

**Usage:** Use to define or update the purpose and rules for a room. All agents in the room will receive this in their context on subsequent messages.

---

### `post_to_room`

Posts a message to a specific room on behalf of the calling agent.

**Parameters:**
- `roomName` *(required)* — Name of the room.
- `content` *(required)* — The message text.

**Returns:** `{ messageId, roomName }`

**Usage:** Use to send a message to a room you are not currently responding from — for example, reporting results back to a coordinator room after completing work in a sub-room. Do not use as a replacement for your normal response; just write your response instead.

---

### `get_room_history`

Returns recent messages from a room.

**Parameters:**
- `roomName` *(optional)* — Omit to use the current room.
- `limit` *(optional)* — Number of messages to return (default 20, max 100).

**Returns:** Array of `{ senderName, content, type, timestamp }`.

**Usage:** Use to catch up on a room you just joined, review past decisions before acting, or give another agent context. The type field indicates `chat`, `join`, `leave`, `system`, or `pass`.

---

## External Tools — Memory (`tools/memory.ts`)

Memory tools provide per-agent persistent storage across sessions. Notes are stored in `~/.samsinn/memory/<agent-name>/`. Load with the filesystem loader by placing the file in `./tools/` or `~/.samsinn/tools/`.

---

### `think`

Reason through a problem privately before taking action.

**Parameters:**
- `reasoning` *(required)* — Private chain-of-thought text.

**Returns:** `{ thought: string }` — the reasoning echoed back. Not stored, not visible to other participants.

**Usage:** Use before making complex decisions or tool calls to clarify your reasoning. The content is completely private.

---

### `note`

Append an observation or finding to the personal notes log.

**Parameters:**
- `content` *(required)* — The note text.

**Returns:** `{ logged: true }`

**Usage:** Use to record observations, findings, or conclusions for future reference. Each entry is timestamped and appended to a persistent log file.

---

### `my_notes`

Read recent entries from the personal notes log.

**Parameters:**
- `limit` *(optional)* — Number of recent entries to return (default 20).

**Returns:** Array of `{ timestamp, content }`.

**Usage:** Use at the start of a session or task to recall previous observations and findings.

---

### `remember`

Store a named fact for retrieval in future sessions.

**Parameters:**
- `key` *(required)* — Short identifier for the fact.
- `value` *(required)* — The fact or value to store.

**Returns:** `{ key, value }`

**Usage:** Use to persist facts that are expensive to recompute — user preferences, project constants, conclusions from past work.

---

### `recall`

Retrieve a previously stored fact by key.

**Parameters:**
- `key` *(required)* — The key of the fact to retrieve.

**Returns:** `{ key, value }` — `value` is `null` if the key does not exist.

**Usage:** Use to look up facts stored with `remember`. Check for `null` before using the value.

---

### `forget`

Remove a stored fact by key.

**Parameters:**
- `key` *(required)* — The key of the fact to remove.

**Returns:** `{ key, removed: boolean }` — `removed` is false if the key did not exist.

**Usage:** Use to delete facts that are no longer accurate or relevant.

---

## External Tools — Compute (`tools/compute.ts`)

---

### `calculate`

Evaluate a mathematical expression and return the numeric result.

**Parameters:**
- `expression` *(required)* — A math expression, e.g. `"(3 + 4) * 2"` or `"100 / (5 + 5) * 3"`.

**Returns:** `{ result: number }`

**Usage:** Use for any arithmetic. Never estimate arithmetic mentally — always call this tool. Supports `+`, `-`, `*`, `/`, `%`, `()`, `.`, and scientific notation (`e`/`E`). Does not allow variables, function calls, or code injection.

---

### `json_extract`

Extract a specific field from a JSON string using dot-notation path.

**Parameters:**
- `json` *(required)* — A JSON string.
- `path` *(required)* — Dot-notation path, e.g. `"user.address.city"` or `"items[0].name"`.

**Returns:** `{ value }` — `null` if the path does not exist.

**Usage:** Use to extract specific fields from JSON data returned by other tools, rather than parsing it mentally.

---

### `format_table`

Format data as a GitHub-flavored Markdown table.

**Parameters:**
- `headers` *(required)* — Array of column header names.
- `rows` *(required)* — Array of rows; each row is an array of cell strings.

**Returns:** Markdown table string.

**Usage:** Use to build properly formatted tables. Never construct Markdown tables manually — formatting errors are common and this tool handles escaping automatically.

---

## External Tools — Web (`tools/web.ts`)

**Prerequisite:** `web_search` requires `BRAVE_API_KEY` or `SERPER_API_KEY` environment variable.

---

### `web_search`

Search the web for current information.

**Parameters:**
- `query` *(required)* — The search query.
- `count` *(optional)* — Number of results (default 5).

**Returns:** Array of `{ title, url, snippet }`.

**Usage:** Use to find current information not in your training data. Requires `BRAVE_API_KEY` or `SERPER_API_KEY`. Follow with `fetch_url` to read the full content of a result.

---

### `fetch_url`

Fetch a web page and return its cleaned plain-text content.

**Parameters:**
- `url` *(required)* — The URL to fetch.

**Returns:** `{ title, text, url, chars }`

**Usage:** Use after `web_search` to read the full content of a result. Strips all HTML tags, scripts, and styles. Times out after 10 seconds.

---

## External Tools — Research (`tools/research.ts`)

Academic search tools — no API keys required.

---

### `arxiv_search`

Search academic papers on arXiv by keyword or phrase.

**Parameters:**
- `query` *(required)* — Search query.
- `max_results` *(optional)* — Maximum results (default 5).

**Returns:** Array of `{ title, summary, authors, url, published }`.

**Usage:** Use to find academic papers on physics, computer science, mathematics, economics, and adjacent fields. Best when you need preprints or recent research. Results are sorted by relevance.

---

### `doi_lookup`

Resolve a DOI to full citation metadata via the Crossref API.

**Parameters:**
- `doi` *(required)* — The DOI string, e.g. `"10.1145/3442188.3445922"`.

**Returns:** `{ title, authors, published, journal?, doi }`

**Usage:** Use when you have a DOI and need the full citation (title, authors, year, journal). Free, no API key needed.

---

### `semantic_scholar`

Search academic papers via Semantic Scholar with citation counts and AI summaries.

**Parameters:**
- `query` *(required)* — Search query.
- `limit` *(optional)* — Maximum results (default 5).

**Returns:** Array of `{ title, authors, year, abstract, citationCount, tldr?, doi? }`.

**Usage:** Use when citation counts and TLDR summaries are valuable — great for finding high-impact papers or quickly scanning abstract-level content. Covers all academic fields (broader than arXiv).

---

## Adding External Tools

Drop a `.ts` file in `./tools/` (project-local) or `~/.samsinn/tools/` (user-global). The file should export a `Tool` or `Tool[]` as its default export:

```typescript
// tools/my-tool.ts
import type { Tool } from './src/core/types.ts'

const myTool: Tool = {
  name: 'my_tool',
  description: 'What this tool does.',
  usage: 'When to use it and when not to.',
  returns: 'Description of what it returns.',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'The input value' },
    },
    required: ['input'],
  },
  execute: async (params) => {
    return { success: true, data: { result: params.input } }
  },
}

export default myTool
```

**Rules:**
- Tool names must match `/^[a-zA-Z0-9_-]+$/` (no spaces)
- Names that conflict with already-registered tools are skipped (built-ins always win)
- Files starting with `_` are ignored (use for helpers)
- Array default exports are supported: `export default [tool1, tool2]`
- Set `SAMSINN_TOOLS_DIR` environment variable to load from a custom path

---

## Proposed Additional Tools

These tools are identified as high-value additions for future implementation.

### `diff_text`
Compare two text strings and return a unified diff. Useful for code reviews, detecting changes, and summarizing what changed between versions.

### `summarize_history`
Summarize a conversation history or long text into a compressed form. Would call the LLM recursively (or use a sliding window) to produce a condensed summary, then potentially store it as a note. Valuable for long-running rooms.

### `create_flow`
Create a named flow in the current room from a list of agent names and optional per-step prompts. Currently flows can only be created from the UI or via WS/HTTP. Enabling agents to create flows programmatically unlocks dynamic orchestration.

### `start_flow`
Start a named flow in the current room with a trigger message. Pairs with `create_flow` for full programmatic flow management.

### `image_describe` (vision)
Fetch an image URL and return a text description of its contents. Requires a vision-capable LLM. Useful for reading charts, screenshots, and diagrams shared in rooms.

### `list_facts`
List all facts stored for the calling agent. Complements `recall` (single key lookup) with full inventory — useful when you don't know what keys exist. Would read and return the entire `facts.json`.

### `run_shell`
Execute a whitelisted shell command and return stdout/stderr. Restricted to a safe allowlist (e.g. `ls`, `cat`, `grep`, `git status`). Powerful for developer workflows but requires careful sandboxing.

### `set_agent_prompt`
Update the system prompt of a named AI agent. Currently only possible via the UI. Would allow a coordinator agent to adapt another agent's persona or instructions mid-session.

### `list_mcp_tools`
List all tools registered from external MCP servers. Useful for dynamic discovery when MCP servers are connected at runtime and agents need to know what new capabilities are available.

### `embed_and_store` / `semantic_recall`
Vector embedding and semantic search over stored notes and facts. Would enable "soft" memory retrieval — find relevant past observations without knowing the exact key. Requires an embedding model (Ollama supports this via `embeddings` API).
