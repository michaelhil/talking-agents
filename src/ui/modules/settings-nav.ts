// Settings sidebar section — expand/collapse + route each row to its modal.
// Every entry is a button carrying `data-settings-row` whose value is the
// key looked up in the opener map below.

import { domRefs } from './app-dom.ts'

type SettingsRow = 'prompt' | 'providers' | 'tools' | 'skills' | 'packs' | 'logging' | 'instances' | 'bug'

const openers: Record<SettingsRow, () => Promise<void> | void> = {
  prompt: async () => {
    const m = await import('./system-prompt-modal.ts')
    await m.openSystemPromptModal()
  },
  providers: async () => {
    const { openProvidersModal } = await import('./providers-modal.ts')
    await openProvidersModal()
  },
  tools: async () => {
    const m = await import('./tools-list-modal.ts')
    await m.openToolsListModal()
  },
  skills: async () => {
    const m = await import('./skills-list-modal.ts')
    await m.openSkillsListModal()
  },
  packs: async () => {
    const m = await import('./packs-modal.ts')
    await m.openPacksModal()
  },
  logging: async () => {
    const m = await import('./logging-modal.ts')
    m.openLoggingModal()
  },
  instances: async () => {
    const m = await import('./instances-modal.ts')
    await m.openInstancesModal()
  },
  bug: async () => {
    const m = await import('./bug-modal.ts')
    await m.openBugModal()
  },
}

export const initSettingsNav = (): void => {
  const { settingsHeader, settingsList, settingsToggle } = domRefs

  const updateLabel = (expanded: boolean): void => {
    settingsToggle.textContent = `${expanded ? '▾' : '▸'} Settings`
  }

  settingsHeader.onclick = (e) => {
    if ((e.target as HTMLElement).closest('button[data-settings-row]')) return
    const nowHidden = settingsList.classList.toggle('hidden')
    updateLabel(!nowHidden)
    settingsHeader.setAttribute('aria-expanded', String(!nowHidden))
  }

  settingsList.querySelectorAll<HTMLButtonElement>('button[data-settings-row]').forEach(btn => {
    const key = btn.dataset.settingsRow as SettingsRow
    btn.onclick = (e) => {
      e.stopPropagation()
      void openers[key]?.()
    }
  })
}
