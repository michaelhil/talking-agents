// Renders the sidebar tool list. Each row is a button that opens the
// tool detail modal; extracted from app.ts so the rendering logic lives
// alongside its siblings (render-*.ts).

interface ToolSummary {
  readonly name: string
  readonly description: string
}

export const renderToolsList = (
  container: HTMLElement,
  tools: ReadonlyArray<ToolSummary>,
  onToolClick: (name: string) => void,
): void => {
  container.innerHTML = ''
  if (tools.length === 0) {
    container.innerHTML = '<div class="text-xs text-text-muted px-3 py-1">No tools</div>'
    return
  }
  for (const t of tools) {
    const row = document.createElement('button')
    row.className = 'w-full text-left text-xs text-text py-0.5 px-3 hover:bg-surface-muted cursor-pointer truncate'
    row.title = t.description
    row.textContent = t.name
    row.onclick = () => onToolClick(t.name)
    container.appendChild(row)
  }
}
