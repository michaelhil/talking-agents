import { test, expect } from 'bun:test'
import { redactSecrets, formatShellError } from './redact.ts'

test('redactSecrets: HTTP basic-auth in URL', () => {
  const s = 'fatal: clone failed at https://x:ghp_abcdefghij1234567890ABCDEF@github.com/owner/repo.git'
  const out = redactSecrets(s)
  expect(out).toContain('https://[REDACTED]@github.com')
  expect(out).not.toContain('ghp_abcdefghij1234567890ABCDEF')
  expect(out).not.toContain('x:ghp_')
})

test('redactSecrets: bare GitHub PAT', () => {
  const s = 'token rejected: ghp_abcdefghij1234567890ABCDEFG'
  expect(redactSecrets(s)).toBe('token rejected: [REDACTED-GH-TOKEN]')
})

test('redactSecrets: fine-grained PAT', () => {
  const s = 'authorization github_pat_11ABCDEF0_xxxxxxxxxxxx_yyyyyyyyy bad'
  expect(redactSecrets(s)).toContain('[REDACTED-GH-PAT]')
})

test('redactSecrets: Bearer header', () => {
  const s = 'http 401 with Bearer abc.def.ghi-jkl_mno=pqrstuvwxyz'
  expect(redactSecrets(s)).toBe('http 401 with Bearer [REDACTED]')
})

test('redactSecrets: leaves benign text untouched', () => {
  const s = 'fatal: not a git repository'
  expect(redactSecrets(s)).toBe(s)
})

test('formatShellError: truncates over cap', () => {
  const longStderr = 'x'.repeat(800)
  const result = { exitCode: 1, stderr: { toString: () => longStderr } }
  const out = formatShellError(result, 'clone')
  expect(out.length).toBeLessThan(550)
  expect(out).toContain('… (truncated)')
})

test('formatShellError: returns fallback when stderr is empty', () => {
  const result = { exitCode: 128, stderr: { toString: () => '   ' } }
  expect(formatShellError(result, 'clone')).toBe('clone failed (exit 128, no stderr)')
})

test('formatShellError: redacts before truncating', () => {
  const result = {
    exitCode: 1,
    stderr: { toString: () => 'auth fail https://x:ghp_secretsecretsecret1234567@github.com/x.git' },
  }
  const out = formatShellError(result, 'clone')
  expect(out).not.toContain('ghp_secret')
  expect(out).toContain('[REDACTED]')
})
