// Small click-to-edit number field: renders as `label:value ↺` and expands
// to a number input on click. Used by the agent inspector header and by
// Model group rows in the context panel.

interface InlineNumberEditorOpts {
  readonly label: string
  readonly value: string               // current display value, or 'default'
  readonly tooltip: string              // hover title
  readonly step?: string                // number input step (e.g. '0.1' or '1')
  readonly onSave: (newValue: string) => Promise<void>  // newValue is raw trimmed; empty → reset to default
}

export const createInlineNumberEditor = (opts: InlineNumberEditorOpts): HTMLElement => {
  const wrapper = document.createElement('span')
  wrapper.title = `${opts.tooltip} (click to edit)`
  wrapper.className = 'cursor-pointer hover:text-accent whitespace-nowrap'
  const labelSpan = document.createElement('span')
  labelSpan.textContent = `${opts.label}:`
  const valueSpan = document.createElement('span')
  valueSpan.textContent = opts.value
  const resetSpan = document.createElement('span')
  resetSpan.textContent = '↺'
  resetSpan.className = 'text-border-strong hover:text-danger ml-0.5'
  resetSpan.title = 'Reset to default'
  resetSpan.style.display = opts.value === 'default' ? 'none' : 'inline'
  wrapper.appendChild(labelSpan)
  wrapper.appendChild(valueSpan)
  wrapper.appendChild(resetSpan)

  let currentValue = opts.value
  const apply = async (newVal: string): Promise<void> => {
    await opts.onSave(newVal)
    currentValue = newVal || 'default'
    valueSpan.textContent = currentValue
    resetSpan.style.display = currentValue === 'default' ? 'none' : 'inline'
  }

  resetSpan.onclick = (e) => { e.stopPropagation(); void apply('') }

  wrapper.onclick = (e) => {
    if (e.target === resetSpan) return
    e.stopPropagation()
    const input = document.createElement('input')
    input.type = 'number'
    input.className = 'w-14 text-xs border rounded px-1 py-0 text-text'
    input.value = currentValue === 'default' ? '' : currentValue
    input.step = opts.step ?? '1'
    input.placeholder = 'default'
    valueSpan.replaceWith(input)
    input.focus()
    const save = () => { void apply(input.value.trim()); input.replaceWith(valueSpan) }
    input.onblur = save
    input.onkeydown = (ev) => { if (ev.key === 'Enter') save(); if (ev.key === 'Escape') input.replaceWith(valueSpan) }
  }
  return wrapper
}
