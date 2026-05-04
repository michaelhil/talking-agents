// ============================================================================
// Shared bootstrap for streaming-probe + smoke-streaming.
//
// Both probes need the same first three steps:
//   1. Optionally authenticate (when SAMSINN_TOKEN is set in deploy mode).
//   2. Hit /api/system/diagnostics to verify at least one wired instance.
//   3. Pick a target instance + return the cookie string ready for use.
//
// Centralizing here means both scripts share the SAME instance-selection
// behavior. As of the post-deploy gate work (plan #3), the rule is:
//   * The probe MUST issue a fresh cookie / use a fresh instance, NEVER
//     evict or otherwise interfere with a real user's session.
//   * Because the registry's getOrLoad is the only path that materializes
//     an instance, just pointing a fresh cookie at a fresh id is enough —
//     the first /api/system/diagnostics or WS upgrade triggers the load.
// ============================================================================

const SESSION_COOKIE_PREFIX = 'samsinn_session='
const INSTANCE_COOKIE_PREFIX = 'samsinn_instance='

export interface ProbeContext {
  readonly baseUrl: string
  readonly wsBaseUrl: string
  readonly cookie: string
  readonly instance: string
  readonly sessionCookie: string | undefined
}

export interface BootstrapOptions {
  readonly baseUrl: string
  // When 'reuse-wired', pick the first wired instance from diagnostics.
  // When 'fresh', generate a new instance id and bind a cookie to it.
  // The post-deploy probe must use 'fresh' to avoid evicting real users.
  readonly target: 'reuse-wired' | 'fresh'
  readonly token?: string
}

const fail = (msg: string): never => {
  console.error(`FAIL: ${msg}`)
  process.exit(1)
}

// 16 chars, lowercase alphanumeric — matches the cookie format generated
// server-side by api/instance-cookie.ts. Probe instance ids are visually
// distinct (prefix 'probe') so on-box journals can be greppable.
const generateProbeInstanceId = (): string => {
  const r = Math.random().toString(36).slice(2, 13)
  return `probe${r}`.slice(0, 16).padEnd(16, 'x')
}

const authenticate = async (baseUrl: string, token: string): Promise<string> => {
  const authRes = await fetch(`${baseUrl}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (!authRes.ok) fail(`/api/auth ${authRes.status}`)
  const sessionCookie = authRes.headers
    .getSetCookie()
    .find(c => c.startsWith(SESSION_COOKIE_PREFIX))
    ?.split(';')[0]
  if (!sessionCookie) fail('no session cookie returned by /api/auth')
  return sessionCookie!
}

export const bootstrapProbe = async (opts: BootstrapOptions): Promise<ProbeContext> => {
  const { baseUrl, target, token } = opts
  const wsBaseUrl = baseUrl.replace(/^http/, 'ws')
  const sessionCookie = token ? await authenticate(baseUrl, token) : undefined

  if (target === 'fresh') {
    const instance = generateProbeInstanceId()
    const cookie = sessionCookie
      ? `${sessionCookie}; ${INSTANCE_COOKIE_PREFIX}${instance}`
      : `${INSTANCE_COOKIE_PREFIX}${instance}`
    // Materialize the instance by hitting any cookie-aware endpoint.
    // /api/rooms triggers registry.getOrLoad through the per-request cookie
    // resolution in server.ts.
    const warm = await fetch(`${baseUrl}/api/rooms`, { headers: { Cookie: cookie } })
    if (!warm.ok) fail(`probe instance warmup ${warm.status}`)
    return { baseUrl, wsBaseUrl, cookie, instance, sessionCookie }
  }

  // reuse-wired: legacy behavior used by smoke. Picks an existing wired
  // instance from diagnostics.
  const diagRes = await fetch(`${baseUrl}/api/system/diagnostics`, {
    ...(sessionCookie ? { headers: { Cookie: sessionCookie } } : {}),
  })
  if (!diagRes.ok) fail(`/api/system/diagnostics ${diagRes.status}`)
  const diag = await diagRes.json() as {
    instances: Array<{ id: string; wired: boolean }>
  }
  const wired = diag.instances.find(i => i.wired)
  if (!wired) fail('no wired instance available')
  const instance = wired!.id
  const cookie = sessionCookie
    ? `${sessionCookie}; ${INSTANCE_COOKIE_PREFIX}${instance}`
    : `${INSTANCE_COOKIE_PREFIX}${instance}`
  return { baseUrl, wsBaseUrl, cookie, instance, sessionCookie }
}
