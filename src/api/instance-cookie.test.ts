import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  generateInstanceId, getInstanceId, buildInstanceCookie,
  getInstanceFromQuery, getJoinFromQuery, resolveInstanceId,
  resolveOrMintInstance, isSessionBoundToOtherInstance,
  INSTANCE_COOKIE,
} from './instance-cookie.ts'

const mkReq = (opts?: { cookie?: string; xfp?: string; url?: string }): Request =>
  new Request(opts?.url ?? 'http://localhost:3000/', {
    headers: {
      ...(opts?.cookie ? { cookie: opts.cookie } : {}),
      ...(opts?.xfp ? { 'x-forwarded-proto': opts.xfp } : {}),
    },
  })

describe('generateInstanceId', () => {
  it('returns 16 lowercase alphanumeric characters', () => {
    for (let i = 0; i < 100; i++) {
      const id = generateInstanceId()
      expect(id).toMatch(/^[a-z0-9]{16}$/)
    }
  })

  it('produces unique ids across calls', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) seen.add(generateInstanceId())
    expect(seen.size).toBe(1000)
  })
})

describe('getInstanceId', () => {
  it('returns valid id from cookie', () => {
    const req = mkReq({ cookie: `${INSTANCE_COOKIE}=abc123def456ghij` })
    expect(getInstanceId(req)).toBe('abc123def456ghij')
  })

  it('returns null when cookie missing', () => {
    expect(getInstanceId(mkReq())).toBeNull()
  })

  it('rejects malformed cookie value', () => {
    const req = mkReq({ cookie: `${INSTANCE_COOKIE}=../etc/passwd` })
    expect(getInstanceId(req)).toBeNull()
  })

  it('rejects uppercase id', () => {
    const req = mkReq({ cookie: `${INSTANCE_COOKIE}=ABC123def456ghij` })
    expect(getInstanceId(req)).toBeNull()
  })

  it('coexists with samsinn_session cookie', () => {
    const req = mkReq({ cookie: `samsinn_session=abc; ${INSTANCE_COOKIE}=abc123def456ghij` })
    expect(getInstanceId(req)).toBe('abc123def456ghij')
  })
})

describe('buildInstanceCookie', () => {
  let originalSecure: string | undefined
  beforeEach(() => { originalSecure = process.env.SAMSINN_SECURE_COOKIES })
  afterEach(() => {
    if (originalSecure === undefined) delete process.env.SAMSINN_SECURE_COOKIES
    else process.env.SAMSINN_SECURE_COOKIES = originalSecure
  })

  it('sets HttpOnly + SameSite=Lax + Path=/', () => {
    delete process.env.SAMSINN_SECURE_COOKIES
    const c = buildInstanceCookie('abc123def456ghij', mkReq())
    expect(c).toContain('HttpOnly')
    expect(c).toContain('SameSite=Lax')
    expect(c).toContain('Path=/')
  })

  it('omits Secure on plain HTTP localhost', () => {
    delete process.env.SAMSINN_SECURE_COOKIES
    const c = buildInstanceCookie('abc123def456ghij', mkReq())
    expect(c).not.toContain('Secure')
  })

  it('adds Secure when X-Forwarded-Proto: https', () => {
    delete process.env.SAMSINN_SECURE_COOKIES
    const c = buildInstanceCookie('abc123def456ghij', mkReq({ xfp: 'https' }))
    expect(c).toContain('Secure')
  })

  it('adds Secure when SAMSINN_SECURE_COOKIES=1', () => {
    process.env.SAMSINN_SECURE_COOKIES = '1'
    const c = buildInstanceCookie('abc123def456ghij', mkReq())
    expect(c).toContain('Secure')
  })

  it('adds Secure for direct https:// requests', () => {
    delete process.env.SAMSINN_SECURE_COOKIES
    const c = buildInstanceCookie('abc123def456ghij', mkReq({ url: 'https://example.com/' }))
    expect(c).toContain('Secure')
  })

  it('30 day max-age', () => {
    const c = buildInstanceCookie('abc123def456ghij', mkReq())
    expect(c).toContain('Max-Age=2592000')   // 30 * 24 * 60 * 60
  })
})

describe('getInstanceFromQuery + getJoinFromQuery', () => {
  it('reads instance= query param when valid', () => {
    expect(getInstanceFromQuery(new URL('http://x/?instance=abc123def456ghij'))).toBe('abc123def456ghij')
  })

  it('rejects invalid instance= value', () => {
    expect(getInstanceFromQuery(new URL('http://x/?instance=../bad'))).toBeNull()
  })

  it('reads join= query param when valid', () => {
    expect(getJoinFromQuery(new URL('http://x/?join=abc123def456ghij'))).toBe('abc123def456ghij')
  })

  it('returns null when params missing', () => {
    expect(getJoinFromQuery(new URL('http://x/'))).toBeNull()
    expect(getInstanceFromQuery(new URL('http://x/'))).toBeNull()
  })
})

describe('resolveInstanceId — precedence', () => {
  it('?join wins over cookie', () => {
    const req = mkReq({ cookie: `${INSTANCE_COOKIE}=cookieabcdefghij` })
    const url = new URL('http://x/?join=joinaabcdefghij1')
    expect(resolveInstanceId(req, url)).toEqual({ id: 'joinaabcdefghij1', source: 'join' })
  })

  it('cookie wins over ?instance', () => {
    const req = mkReq({ cookie: `${INSTANCE_COOKIE}=cookieabcdefghij` })
    const url = new URL('http://x/?instance=queryabcdefghij1')
    expect(resolveInstanceId(req, url)).toEqual({ id: 'cookieabcdefghij', source: 'cookie' })
  })

  it('?instance used when no cookie', () => {
    const url = new URL('http://x/?instance=queryabcdefghij1')
    expect(resolveInstanceId(mkReq(), url)).toEqual({ id: 'queryabcdefghij1', source: 'query' })
  })

  it('null when nothing present', () => {
    expect(resolveInstanceId(mkReq(), new URL('http://x/')))
      .toEqual({ id: null, source: 'none' })
  })

  it('rejects invalid join id silently → falls through to cookie', () => {
    const req = mkReq({ cookie: `${INSTANCE_COOKIE}=cookieabcdefghij` })
    const url = new URL('http://x/?join=../bad')
    expect(resolveInstanceId(req, url)).toEqual({ id: 'cookieabcdefghij', source: 'cookie' })
  })
})

describe('resolveOrMintInstance — mint-vs-reuse policy', () => {
  it('reuses cookie id and does NOT set a fresh cookie', () => {
    const req = mkReq({ cookie: `${INSTANCE_COOKIE}=cookieabcdefghij` })
    const url = new URL('http://x/')
    const minted = resolveOrMintInstance(req, url)
    expect(minted).toEqual({
      instanceId: 'cookieabcdefghij',
      setCookieValue: null,
      isNew: false,
    })
  })

  it('reuses ?join= id and does NOT set the cookie here (the /?join handler does that earlier)', () => {
    const url = new URL('http://x/?join=joinaabcdefghij1')
    const minted = resolveOrMintInstance(mkReq(), url)
    expect(minted.instanceId).toBe('joinaabcdefghij1')
    expect(minted.setCookieValue).toBeNull()
    expect(minted.isNew).toBe(false)
  })

  it('reuses ?instance= id without setting a cookie (one-shot scripted callers)', () => {
    const url = new URL('http://x/?instance=queryabcdefghij1')
    const minted = resolveOrMintInstance(mkReq(), url)
    expect(minted.instanceId).toBe('queryabcdefghij1')
    expect(minted.setCookieValue).toBeNull()
    expect(minted.isNew).toBe(false)
  })

  it('mints a fresh id AND builds Set-Cookie when nothing identifies the visitor', () => {
    const minted = resolveOrMintInstance(mkReq(), new URL('http://x/'))
    expect(minted.instanceId).toMatch(/^[a-z0-9]{16}$/)
    expect(minted.setCookieValue).not.toBeNull()
    expect(minted.setCookieValue!).toContain(`${INSTANCE_COOKIE}=${minted.instanceId}`)
    expect(minted.isNew).toBe(true)
  })

  it('two cookieless calls mint different ids', () => {
    const a = resolveOrMintInstance(mkReq(), new URL('http://x/'))
    const b = resolveOrMintInstance(mkReq(), new URL('http://x/'))
    expect(a.instanceId).not.toBe(b.instanceId)
  })

  it('malformed cookie value triggers mint, not reuse', () => {
    const req = mkReq({ cookie: `${INSTANCE_COOKIE}=../etc/passwd` })
    const minted = resolveOrMintInstance(req, new URL('http://x/'))
    expect(minted.isNew).toBe(true)
    expect(minted.instanceId).not.toBe('../etc/passwd')
    expect(minted.setCookieValue).not.toBeNull()
  })
})

describe('isSessionBoundToOtherInstance — WS upgrade guard', () => {
  it('returns false when no existing session under this token', () => {
    expect(isSessionBoundToOtherInstance(undefined, 'abc123def456ghij')).toBe(false)
  })

  it('returns false when existing session matches the resolved instance', () => {
    expect(isSessionBoundToOtherInstance(
      { instanceId: 'abc123def456ghij' },
      'abc123def456ghij',
    )).toBe(false)
  })

  it('returns true when existing session is bound to a different instance (cookie was switched)', () => {
    expect(isSessionBoundToOtherInstance(
      { instanceId: 'abc123def456ghij' },
      'zzz123def456ghij',
    )).toBe(true)
  })
})
