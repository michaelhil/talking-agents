// Best-effort secret redaction for error strings surfaced to users.
//
// We pipe raw shell stderr (git, tar, rm) into tool-result `error` fields,
// which can land in the chat UI, logs, and bug reports. If the operator
// pasted a tokenised git URL into install_pack, the unredacted error would
// echo the token back. Patterns here cover the realistic shapes:
//
//   - HTTP basic-auth in URLs (covers GH PATs embedded as user:pass@host)
//   - GitHub fine-grained / classic / refresh / OAuth tokens
//   - Bearer headers
//
// This is not a security boundary — operators with shell access to logs
// can find real secrets in env files. The goal is to stop accidental
// echo-back into chat UIs and pasted bug reports.

const PATTERNS: ReadonlyArray<{ readonly re: RegExp; readonly replace: string }> = [
  { re: /(https?:\/\/)[^/@\s]+:[^/@\s]+@/g, replace: '$1[REDACTED]@' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: '[REDACTED-GH-TOKEN]' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replace: '[REDACTED-GH-PAT]' },
  { re: /\bBearer\s+[A-Za-z0-9_\-.=]{20,}/gi, replace: 'Bearer [REDACTED]' },
]

export const redactSecrets = (s: string): string =>
  PATTERNS.reduce((acc, { re, replace }) => acc.replace(re, replace), s)

// Format a Bun shell-out error result for user display.
// Truncation cap mirrors what fits in a chat message without dominating it.
const MAX_STDERR_CHARS = 500

interface ShellResult {
  readonly exitCode: number
  readonly stderr: { toString: () => string }
}

export const formatShellError = (
  result: ShellResult,
  action: string,
): string => {
  const raw = redactSecrets(result.stderr.toString().trim())
  const truncated = raw.length > MAX_STDERR_CHARS
    ? `${raw.slice(0, MAX_STDERR_CHARS)}… (truncated)`
    : raw
  return truncated || `${action} failed (exit ${result.exitCode}, no stderr)`
}
