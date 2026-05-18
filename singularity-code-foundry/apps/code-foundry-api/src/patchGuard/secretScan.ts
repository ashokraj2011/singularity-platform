/**
 * M42.4 — Secret-shaped string scanner.
 *
 * Conservative regex set that flags ANY hunk introducing values
 * commonly mistaken for secrets. Bias is toward false-positives —
 * the Patch Guard rejects on first hit, the operator can override
 * via the M42.6 approval UI if it's a false alarm.
 */

const SECRET_PATTERNS: Array<{ id: string; re: RegExp; description: string }> = [
  { id: 'aws_access_key',     re: /\bAKIA[0-9A-Z]{16}\b/,                              description: 'AWS access key id' },
  { id: 'aws_secret_key',     re: /aws[_-]?secret[_-]?(?:access[_-]?)?key[^\n]*?["'][A-Za-z0-9/+=]{40}["']/i, description: 'AWS secret access key value' },
  { id: 'gcp_service_account',re: /-----BEGIN PRIVATE KEY-----/,                        description: 'GCP / PEM private key block' },
  { id: 'openai_key',         re: /\bsk-[A-Za-z0-9]{40,}\b/,                            description: 'OpenAI API key' },
  { id: 'anthropic_key',      re: /\bsk-ant-[A-Za-z0-9_-]{40,}\b/,                      description: 'Anthropic API key' },
  { id: 'github_token',       re: /\bgh[pousr]_[A-Za-z0-9]{36}\b/,                      description: 'GitHub access token' },
  { id: 'slack_token',        re: /\bxox[bpoa]-[A-Za-z0-9-]{10,}\b/,                    description: 'Slack token' },
  { id: 'jwt_token',          re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/, description: 'JWT-shaped token' },
  { id: 'password_literal',   re: /\b(?:password|passwd|secret)\s*[:=]\s*["'][^"']{6,}["']/i, description: 'inline password literal' },
]

export interface SecretHit {
  patternId: string
  description: string
  match: string
}

/**
 * Scan a unified-diff hunk body for newly-added secret-shaped strings.
 * Only added lines (the `+` ones) are evaluated — removing a secret is
 * always allowed.
 */
export function scanHunkForSecrets(hunkBody: string): SecretHit[] {
  const out: SecretHit[] = []
  const addedLines = hunkBody.split(/\r?\n/).filter(line => line.startsWith('+'))
  const addedText = addedLines.map(l => l.slice(1)).join('\n')
  for (const p of SECRET_PATTERNS) {
    const m = p.re.exec(addedText)
    if (m) {
      out.push({ patternId: p.id, description: p.description, match: m[0].slice(0, 32) + (m[0].length > 32 ? '…' : '') })
    }
  }
  return out
}
