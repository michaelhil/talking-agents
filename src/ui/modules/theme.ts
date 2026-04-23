// Light/dark theme manager.
//
// First paint is handled inline in index.html (script block) to avoid a flash
// of wrong theme. This module wires the toggle button and emits a custom
// event so other modules (e.g., mermaid renderer) can react.

const STORAGE_KEY = 'samsinn.theme'
const EVENT_NAME = 'samsinn:themechange'

export type ThemeMode = 'light' | 'dark'

export const getTheme = (): ThemeMode =>
  document.documentElement.classList.contains('dark') ? 'dark' : 'light'

export const setTheme = (mode: ThemeMode): void => {
  const root = document.documentElement
  if (mode === 'dark') root.classList.add('dark')
  else root.classList.remove('dark')
  try { localStorage.setItem(STORAGE_KEY, mode) } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: mode }))
}

export const toggleTheme = (): void => {
  setTheme(getTheme() === 'dark' ? 'light' : 'dark')
}

export const onThemeChange = (fn: (mode: ThemeMode) => void): void => {
  window.addEventListener(EVENT_NAME, ((e: CustomEvent<ThemeMode>) => fn(e.detail)) as EventListener)
}

export const wireThemeToggle = (buttonId = 'btn-theme-toggle'): void => {
  const btn = document.getElementById(buttonId)
  if (!btn) return
  btn.addEventListener('click', toggleTheme)
}
