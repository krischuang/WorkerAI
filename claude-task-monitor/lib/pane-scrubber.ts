/** Patterns that match common secret formats. Each match is replaced with [REDACTED]. */
const SECRET_PATTERNS: RegExp[] = [
  // AWS Access Key ID + Secret (often printed together)
  /AKIA[0-9A-Z]{16}/g,
  // AWS Secret Access Key (40 base64 chars following common key labels)
  /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*\S+/gi,
  // GitHub personal access tokens (classic and fine-grained)
  /gh[pousr]_[A-Za-z0-9_]{16,255}/g,
  /github_pat_[A-Za-z0-9_]{22,255}/g,
  // Anthropic API keys
  /sk-ant-[A-Za-z0-9\-_]{20,255}/g,
  // Generic Bearer / token header values
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  // DATABASE_URL with embedded password  (postgres://user:PASSWORD@host)
  /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:@\s]+:[^@\s]+@[^\s"']+/gi,
  // Generic password= / passwd= / secret= assignments in environment output
  /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*(?!(?:true|false|null|undefined|\*+|\s))\S+/gi,
  // PEM-encoded private key blocks
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Generic high-entropy hex strings that look like secrets (32+ hex chars on their own token)
  // Limit to avoid false positives: must be a standalone token (whitespace/quote on each side or line boundary)
  /(?<=^|[\s"'`=:,])([0-9a-fA-F]{40,64})(?=$|[\s"'`])/gm,
];

const REDACTED = "[REDACTED]";

/**
 * Scrub common secret patterns from tmux pane output before it is persisted
 * to the database. Operates on a best-effort basis — it reduces accidental
 * exposure but is not a guarantee that all secrets are removed.
 *
 * Pass `knownSecretValues` to also mask any specific values that were injected
 * as task secrets at dispatch time.
 */
export function scrubPaneCapture(text: string, knownSecretValues?: string[]): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, REDACTED);
  }
  if (knownSecretValues) {
    for (const val of knownSecretValues) {
      if (val.length >= 4) {
        result = result.split(val).join(REDACTED);
      }
    }
  }
  return result;
}
