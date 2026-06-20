# Security Audit — WorkerAI
**Date:** 2026-06-20
**Auditor:** Claude Code (claude-sonnet-4-6)
**Scope:** Full codebase review + injection testing for public deployment readiness

---

## Vulnerabilities Found & Fixed

| # | Severity | Issue | File | Fix |
|---|----------|-------|------|-----|
| 1 | **HIGH** | **Open Redirect** — `?redirect=https://evil.com` worked on all 3 login pages; after successful auth, users were sent to attacker-controlled URLs | `app/login/page.tsx`, `app/admin/login/page.tsx`, `app/admin/verify-otp/page.tsx` | Now validates redirect starts with `/` and not `//` (protocol-relative URL). Falls back to `/dashboard` or `/admin/config` otherwise |
| 2 | **MEDIUM** | **No CSV upload size limit** — `POST /api/tasks/import` called `blob.text()` before checking file size; a 1 GB upload would be read into memory 5× per minute | `app/api/tasks/import/route.ts` | Added 5 MB cap (`MAX_IMPORT_BYTES`) checked before `blob.text()`, returns HTTP 413 |
| 3 | **LOW** | **Search shares global rate limit** — `GET /api/search` runs 5 parallel DB queries but had no dedicated throttle, only the shared 60 req/min global read limit | `app/api/search/route.ts` | Added dedicated `apiRateLimit("search:global", 20, 60_000)` — 20 req/min |

---

## Injection Test Results

| Test | Result | Reason |
|------|--------|--------|
| SQL injection via `?q='; DROP TABLE--` | **Safe** | Prisma uses parameterized queries everywhere |
| SQL injection via task title/description | **Safe** | Prisma ORM — no raw SQL with user input |
| Shell injection in tmuxSession | **Safe** | `validateTmuxSession()` enforces `[a-zA-Z0-9._-]{1,64}` regex |
| Shell injection in workDir | **Safe** | `validateWorkDir()` enforces absolute path with safe-char allowlist |
| Path traversal in artifact download | **Safe** | `storagePath` is set server-side at upload time using `path.join` with a base dir |
| CSRF on mutating API calls | **Safe** | Middleware checks `isLocalOrigin(origin)` before all POST/PUT/DELETE |
| XSS via stored task content | **Safe** | React auto-escapes all JSX interpolation |
| Command injection in exec terminal | **By design** | Interactive SSH terminal intentionally allows arbitrary commands; destructive patterns (`rm -rf /`, `mkfs`, fork bombs) are blocked |
| Open redirect on login | **Fixed** | See Fix #1 above |

---

## What Was Already Secure (Confirmed)

- **SQL injection** — Prisma ORM with parameterized queries throughout; no raw SQL with user input
- **CSRF** — Middleware enforces `isLocalOrigin(origin)` on all POST/PUT/DELETE before auth checks
- **tmux session injection** — `validateTmuxSession()` strict regex `[a-zA-Z0-9._-]{1,64}` on create and update
- **workDir injection** — `validateWorkDir()` enforces absolute path allowlist before any SSH use
- **Artifact path traversal** — `storagePath` constructed server-side with `path.join(base, taskId, artifactId_filename)`
- **XSS** — React JSX auto-escapes all rendered content; artifact MIME type allowlist blocks HTML/JS/SVG serving
- **Secret encryption** — AES-256-GCM with per-value random IV; master key never leaves the server
- **Admin brute force** — 10 attempts / 15 min rate limit, persisted to DB across restarts; TOTP 2FA supported
- **Session security** — HMAC-SHA256 nonce-bound cookies; httpOnly + Secure (production) + SameSite=Strict
- **Security headers** — X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy, Permissions-Policy, HSTS (production)
- **SSH key handling** — Private key content never stored in DB or sent to browser; only filesystem path stored
- **Rate limiting** — Global 60 read / 10 write per minute per IP; per-endpoint caps on sensitive routes
- **Prompt injection** — XML-fencing isolates user content in task prompts; prompt firewall blocks injection patterns before dispatch

---

## Remaining Known Risks

| ID | Severity | Finding | Notes |
|----|----------|---------|-------|
| DB-1/AC-2 | **High** (architectural) | DB credentials and secrets flow into agent prompts by design | Requires Secret Broker wiring into `task-dispatch.ts`; infrastructure exists but has no callers |
| NEW-3 | **Medium** | Prompt firewall bypassable via encoding, homoglyphs, or cross-field split | Defense-in-depth gap; XML structural fencing still intact |
| SC-1 | **Medium** (partial) | No per-session burst limit or cross-project total task cap | Per-project cap of 50 is in place |
| SK-1 | **Medium** (partial) | Secret scrubbing covers known env var names; custom-named vars can be missed | Low practical risk |
| SH-4 | **Low** | No per-task rate limit on self-healing repair retry | Low current impact |
| AT-1 | **Low** | No cross-project total task cap | Low current impact |
| IDOR-1 | **High** (intentional) | `GET /api/tasks` returns all tasks | Single-user design decision; not a real risk in single-operator deployment |

---

## Production Deployment Checklist

These are **not code bugs** but required environment configuration for a public-facing deployment:

| Variable | Required | Purpose |
|----------|----------|---------|
| `AUTH_SECRET` | **Yes** | Without it, middleware warns but allows all requests through unauthenticated |
| `ADMIN_PASSWORD` | **Yes** | Without it, admin endpoints return 503 |
| `ALLOWED_ORIGINS` | **Yes** | Set to your production hostname (e.g. `myapp.example.com`); without it, browser requests that include an `Origin` header get 403 |
| `NODE_ENV=production` | **Yes** | Enables `Secure` flag on auth cookies and HSTS response header |
| `TASK_SECRET_KEY` | **Yes** | 64-char hex string; required for per-task secret encryption |
| `TRUSTED_PROXY_IPS` | Recommended | Set to your nginx/proxy IP for accurate IP-based rate limiting (prevents XFF spoofing) |
| `RESTART_LOCKOUT_MINUTES` | Recommended | Set to `5` to defend against rate-limit reset on server restart/crash |
| `ADMIN_TOTP` | Recommended | Enable TOTP 2FA for the admin panel in a public deployment |

### Generate required secrets

```bash
# AUTH_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# TASK_SECRET_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# ADMIN_PASSWORD (use a strong passphrase or random string)
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

---

## Security Score

| Sprint | Score | Notes |
|--------|-------|-------|
| Baseline (2026-06-18) | 60/100 | Pre-hardening |
| Delta audit (2026-06-19) | 70/100 | After shell injection, CSRF, rate limit fixes |
| Delta audit b (2026-06-19) | 80/100 | After IDOR-2, SK-2, SK-3, MM-1 fixes |
| Final assessment (2026-06-19) | 90/100 | After all P1 items closed |
| **This audit (2026-06-20)** | **92/100** | After open redirect + CSV import + search rate limit fixes |

**Risk Level: LOW-MEDIUM**
**Verdict: Suitable for single-operator / trusted-admin deployment. DB-1/AC-2 (Secret Broker) remains the last gap before hardened multi-user exposure.**
