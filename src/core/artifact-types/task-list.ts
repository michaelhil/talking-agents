// ============================================================================
// Task List Artifact Type
//
// A collaborative task list with embedded TaskItems. Tasks are embedded
// directly in the body (not separate artifacts) to avoid orphan/cascade issues.
//
// Factory function: takes ArtifactStore reference so checkAutoResolve can
// inspect child tasks. Store exists before types are registered — no circular
// initialization.
//
// Auto-resolves when all tasks are completed.
// Agent convenience operations via body: { op: 'add_task' | 'complete_task' | 'update_task', ... }
// are handled by onUpdate. For direct manipulation, send the full updated tasks array.
// ============================================================================

import type { Artifact, ArtifactStore, ArtifactTypeDefinition, ArtifactUpdateConfig, ArtifactUpdateResult, TaskItem, TaskListBody, TaskStatus } from '../types.ts'

const taskStatusMark = (status: TaskStatus): string => {
  if (status === 'completed') return 'x'
  if (status === 'in_progress') return '~'
  if (status === 'blocked') return '!'
  return ' '
}

export const createTaskListArtifactType = (store: ArtifactStore): ArtifactTypeDefinition => ({
  type: 'task_list',
  description: 'A shared task list with assignable, trackable tasks. Tasks are embedded in the list.',

  bodySchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Optional description of this task list' },
      tasks: {
        type: 'array',
        description: 'The task items in this list',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked'] },
            assignee: { type: 'string' },
            result: { type: 'string' },
          },
          required: ['id', 'content', 'status'],
        },
      },
      // Convenience operation fields — consumed by onUpdate, not stored
      op: { type: 'string', enum: ['add_task', 'complete_task', 'update_task', 'remove_task'] },
      taskContent: { type: 'string', description: 'Content for add_task op' },
      taskId: { type: 'string', description: 'Target task ID for complete/update/remove ops' },
      taskStatus: { type: 'string', description: 'New status for update_task op' },
      taskAssignee: { type: 'string', description: 'Assignee for add/update ops' },
      taskResult: { type: 'string', description: 'Result comment for complete/update ops' },
    },
    required: ['tasks'],
  },

  onUpdate: (artifact: Artifact, updates: ArtifactUpdateConfig): ArtifactUpdateResult | void => {
    const body = updates.body
    if (!body) return

    const currentBody = artifact.body as TaskListBody
    const tasks = [...(currentBody.tasks ?? [])]
    const op = body.op as string | undefined

    if (op === 'add_task') {
      const content = body.taskContent as string | undefined
      if (!content) return
      const now = Date.now()
      const newTask: TaskItem = {
        id: crypto.randomUUID(),
        content,
        status: 'pending',
        assignee: body.taskAssignee as string | undefined,
        assigneeId: body.taskAssigneeId as string | undefined,
        createdBy: body.createdBy as string ?? 'system',
        createdAt: now,
        updatedAt: now,
      }
      return { newBody: { ...currentBody, tasks: [...tasks, newTask] } }
    }

    if (op === 'complete_task') {
      const taskId = body.taskId as string | undefined
      if (!taskId) return
      const updated = tasks.map(t =>
        t.id === taskId
          ? { ...t, status: 'completed' as TaskStatus, result: body.taskResult as string | undefined, updatedAt: Date.now() }
          : t,
      )
      return { newBody: { ...currentBody, tasks: updated } }
    }

    if (op === 'update_task') {
      const taskId = body.taskId as string | undefined
      if (!taskId) return
      const updated = tasks.map(t => {
        if (t.id !== taskId) return t
        return {
          ...t,
          ...(body.taskStatus !== undefined ? { status: body.taskStatus as TaskStatus } : {}),
          ...(body.taskAssignee !== undefined ? { assignee: body.taskAssignee as string } : {}),
          ...(body.taskResult !== undefined ? { result: body.taskResult as string } : {}),
          updatedAt: Date.now(),
        }
      })
      return { newBody: { ...currentBody, tasks: updated } }
    }

    if (op === 'remove_task') {
      const taskId = body.taskId as string | undefined
      if (!taskId) return
      return { newBody: { ...currentBody, tasks: tasks.filter(t => t.id !== taskId) } }
    }

    // No op — caller provided full tasks array or description; use default shallow merge.
    // Unknown op values (typos) also land here — return no-op to avoid polluting body.
    if (op !== undefined) return { newBody: currentBody }
    return undefined
  },

  checkAutoResolve: (artifact: Artifact): string | undefined => {
    // Suppress unused store warning — kept for future use (cross-list dependency checks)
    void store
    const body = artifact.body as TaskListBody
    if (!body.tasks || body.tasks.length === 0) return undefined
    const allDone = body.tasks.every(t => t.status === 'completed')
    return allDone ? 'All tasks completed' : undefined
  },

  formatForContext: (artifact: Artifact): string => {
    const body = artifact.body as TaskListBody
    const tasks = body.tasks ?? []
    const desc = artifact.description ?? body.description
    const lines: string[] = [`Task list: "${artifact.title}" [id: ${artifact.id}]`]
    if (desc) lines.push(`  ${desc}`)
    if (tasks.length === 0) {
      lines.push('  (no tasks)')
    } else {
      for (const t of tasks) {
        const mark = taskStatusMark(t.status)
        let line = `  - [${mark}] ${t.content} [task-id: ${t.id}]`
        if (t.assignee) line += ` (${t.assignee})`
        if (t.result) line += ` → ${t.result}`
        lines.push(line)
      }
    }
    return lines.join('\n')
  },

  formatUpdateMessage: (artifact: Artifact): string => {
    const body = artifact.body as TaskListBody
    const tasks = body.tasks ?? []
    const done = tasks.filter(t => t.status === 'completed').length
    return `task_list "${artifact.title}" was updated — ${done}/${tasks.length} tasks complete`
  },

  postSystemMessageOn: ['added', 'updated', 'removed', 'resolved'],
})
