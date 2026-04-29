// ============================================================================
// Shared failure banner — renders DiscoveryFailure[] above pack/wiki lists so
// users see the actual cause of an empty list (rate limit, auth, network)
// instead of inferring "no packs available". Mounted by both panels.
// ============================================================================

export type FailureReason =
  | 'rate_limit'
  | 'secondary_limit'
  | 'auth'
  | 'not_found'
  | 'network'
  | 'http'

export interface DiscoveryFailure {
  source: string
  status: number
  reason: FailureReason
  message: string
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

const severityFor = (reason: FailureReason): 'warn' | 'info' => {
  // not_found is informational (user typed a non-existent org). Everything
  // else is a warn-level signal worth surfacing.
  if (reason === 'not_found') return 'info'
  return 'warn'
}

export const renderDiscoveryFailures = (
  container: HTMLElement,
  failures: ReadonlyArray<DiscoveryFailure>,
): void => {
  if (failures.length === 0) return
  // Pick the strongest signal first — rate-limit beats other failures because
  // the actionable hint is concrete (set a token).
  const sorted = [...failures].sort((a, b) => {
    const score = (r: FailureReason): number =>
      r === 'rate_limit' ? 0 : r === 'secondary_limit' ? 1 : r === 'auth' ? 2 : r === 'network' ? 3 : 4
    return score(a.reason) - score(b.reason)
  })

  const banner = document.createElement('div')
  const sev = severityFor(sorted[0]!.reason)
  banner.className = sev === 'warn'
    ? 'mx-3 my-2 px-3 py-2 text-xs border-l-4 border-warning bg-warning/10 text-text rounded'
    : 'mx-3 my-2 px-3 py-2 text-xs border-l-4 border-border bg-surface-muted text-text-muted rounded'

  const title = document.createElement('div')
  title.className = 'font-medium mb-1'
  title.textContent = sev === 'warn' ? 'Discovery had issues' : 'Some sources weren’t found'
  banner.appendChild(title)

  for (const f of sorted) {
    const line = document.createElement('div')
    line.className = 'text-text-muted'
    line.innerHTML = `<span class="font-mono">${escapeHtml(f.source)}</span> &mdash; ${escapeHtml(f.message)}`
    banner.appendChild(line)
  }

  container.appendChild(banner)
}
