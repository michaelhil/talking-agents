// Settings sidebar section — expand/collapse + route each row to its modal.
// Static entries are buttons in index.html carrying `data-settings-row` whose
// value is the key looked up in the opener map below.
//
// Dynamic entries come from UI extensions (Path C). At init time we read
// listExtensionPanels() and append a row for each; we re-render on
// extension-panels-changed so install/uninstall pack lifecycle keeps the
// nav in sync.

import { domRefs } from './app-dom.ts'
import { listExtensionPanels, onExtensionPanelsChanged, type PanelSpec } from './extensions/registry.ts'

type SettingsRow = 'prompt' | 'providers' | 'tools' | 'skills' | 'scripts' | 'demos' | 'packs' | 'geodata' | 'logging' | 'instances' | 'bug'

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
  demos: async () => {
    const m = await import('./demos/index.ts')
    await m.openDemosNavPicker()
  },
  packs: async () => {
    const m = await import('./modals/packs-modal.ts')
    await m.openPacksModal()
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

// Open an extension panel in a simple modal that hosts the panel's mount().
// The panel owns its DOM lifetime via mount/unmount; we provide the chrome
// (header, close, backdrop) and a sized host element.
const openExtensionPanelModal = (spec: PanelSpec): void => {
  const backdrop = document.createElement('div')
  // z-[1100]: must beat Leaflet's controls (z-index 1000) so inline maps in chat don't cover the modal.
  backdrop.className = 'fixed inset-0 z-[1100] flex items-start justify-center bg-black/60 pt-12 px-4'
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close() })

  const card = document.createElement('div')
  card.className = 'bg-surface text-text rounded shadow-xl w-full max-w-2xl max-h-[80vh] overflow-auto border border-border'

  const header = document.createElement('div')
  header.className = 'flex items-center justify-between px-3 py-2 border-b border-border'
  header.innerHTML = `<div class="font-medium">${spec.title}</div>`
  const closeBtn = document.createElement('button')
  closeBtn.className = 'px-2 py-0.5 text-sm'
  closeBtn.textContent = '✕'
  header.appendChild(closeBtn)

  const host = document.createElement('div')

  card.appendChild(header)
  card.appendChild(host)
  backdrop.appendChild(card)
  document.body.appendChild(backdrop)

  const close = (): void => {
    try { spec.unmount?.() } catch { /* ignore */ }
    backdrop.remove()
    document.removeEventListener('keydown', onKey)
  }
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close() }
  closeBtn.addEventListener('click', close)
  document.addEventListener('keydown', onKey)

  try { spec.mount(host) } catch (err) {
    host.textContent = `Panel mount failed: ${err instanceof Error ? err.message : String(err)}`
  }
}

// Sync the dynamic extension rows below the static rows. Removes existing
// dynamic rows and re-appends one button per registered extension panel.
const syncExtensionRows = (settingsList: HTMLElement): void => {
  // Remove any previously-rendered extension rows so re-sync is idempotent.
  settingsList.querySelectorAll('button[data-extension-panel]').forEach(b => b.remove())
  for (const spec of listExtensionPanels()) {
    const btn = document.createElement('button')
    btn.dataset.extensionPanel = spec.id
    btn.className = 'w-full text-left text-xs text-text py-1.5 px-3 hover:bg-surface-muted cursor-pointer interactive'
    btn.textContent = spec.title
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      openExtensionPanelModal(spec)
    })
    settingsList.appendChild(btn)
  }
}

export const initSettingsNav = (): void => {
  const { settingsHeader, settingsList, settingsToggle } = domRefs

  const updateLabel = (expanded: boolean): void => {
    settingsToggle.textContent = `${expanded ? '▾' : '▸'} Settings`
  }

  settingsHeader.onclick = (e) => {
    if ((e.target as HTMLElement).closest('button[data-settings-row], button[data-extension-panel]')) return
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

  // Dynamic extension panel rows — synced now and on every change event.
  syncExtensionRows(settingsList)
  onExtensionPanelsChanged(() => syncExtensionRows(settingsList))
}
