// Settings sidebar section — expand/collapse + route each row to its modal.
// Every entry is a button carrying `data-settings-row` whose value is the
// key looked up in the opener map below.

import { domRefs } from './app-dom.ts'

type SettingsRow = 'prompt' | 'providers' | 'tools' | 'skills' | 'scripts' | 'packs' | 'wikis' | 'geodata' | 'logging' | 'instances' | 'bug'

const openers: Record<SettingsRow, () => Promise<void> | void> = {
  prompt: async () => {
    const m = await import('./modals/system-prompt-modal.ts')
    await m.openSystemPromptModal()
  },
  providers: async () => {
    const { openProvidersModal } = await import('./modals/providers-modal.ts')
    await openProvidersModal()
  },
  tools: async () => {
    const m = await import('./modals/tools-list-modal.ts')
    await m.openToolsListModal()
  },
  skills: async () => {
    const m = await import('./modals/skills-list-modal.ts')
    await m.openSkillsListModal()
  },
  scripts: async () => {
    const m = await import('./modals/scripts-list-modal.ts')
    await m.openScriptsListModal()
  },
  packs: async () => {
    const m = await import('./modals/packs-modal.ts')
    await m.openPacksModal()
  },
  wikis: async () => {
    const m = await import('./modals/wikis-modal.ts')
    await m.openWikisModal()
  },
  geodata: async () => {
    const m = await import('./modals/geodata-modal.ts')
    await m.openGeodataModal()
  },
  logging: async () => {
    const m = await import('./modals/logging-modal.ts')
    m.openLoggingModal()
  },
  instances: async () => {
    const m = await import('./modals/instances-modal.ts')
    await m.openInstancesModal()
  },
  bug: async () => {
    const m = await import('./modals/bug-modal.ts')
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
