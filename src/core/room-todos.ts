// ============================================================================
// Room Todos — Creates and manages the todo Map for a Room.
// ============================================================================

import type { OnTodoChanged, TodoItem, TodoStatus } from './types.ts'

export interface TodoStore {
  readonly addTodo: (config: { content: string; assignee?: string; assigneeId?: string; dependencies?: ReadonlyArray<string>; createdBy: string }) => TodoItem
  readonly updateTodo: (todoId: string, updates: { status?: TodoStatus; assignee?: string; assigneeId?: string; content?: string; result?: string }) => TodoItem | undefined
  readonly removeTodo: (todoId: string) => boolean
  readonly getTodos: () => ReadonlyArray<TodoItem>
  readonly restoreTodos: (items: ReadonlyArray<TodoItem>) => void
}

export const createTodoStore = (roomId: string, onChanged?: OnTodoChanged): TodoStore => {
  const todos = new Map<string, TodoItem>()

  const notifyChanged = (action: 'added' | 'updated' | 'removed', todo: TodoItem): void => {
    onChanged?.(roomId, action, todo)
  }

  const addTodo = (config: { content: string; assignee?: string; assigneeId?: string; dependencies?: ReadonlyArray<string>; createdBy: string }): TodoItem => {
    const now = Date.now()
    const todo: TodoItem = {
      id: crypto.randomUUID(),
      content: config.content,
      status: 'pending',
      assignee: config.assignee,
      assigneeId: config.assigneeId,
      dependencies: config.dependencies,
      createdBy: config.createdBy,
      createdAt: now,
      updatedAt: now,
    }
    todos.set(todo.id, todo)
    notifyChanged('added', todo)
    return todo
  }

  const updateTodo = (todoId: string, updates: { status?: TodoStatus; assignee?: string; assigneeId?: string; content?: string; result?: string }): TodoItem | undefined => {
    const existing = todos.get(todoId)
    if (!existing) return undefined
    const defined = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined))
    const updated: TodoItem = { ...existing, ...defined, updatedAt: Date.now() }
    todos.set(todoId, updated)
    notifyChanged('updated', updated)
    return updated
  }

  const removeTodo = (todoId: string): boolean => {
    const existing = todos.get(todoId)
    if (!existing) return false
    todos.delete(todoId)
    notifyChanged('removed', existing)
    return true
  }

  const getTodos = (): ReadonlyArray<TodoItem> =>
    [...todos.values()].sort((a, b) => a.createdAt - b.createdAt)

  const restoreTodos = (items: ReadonlyArray<TodoItem>): void => {
    todos.clear()
    for (const todo of items) todos.set(todo.id, todo)
  }

  return { addTodo, updateTodo, removeTodo, getTodos, restoreTodos }
}
