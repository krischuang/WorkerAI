/**
 * Optional client for the standalone Python/FastAPI verifier service
 * (../verifier-service). NOT currently called from lib/validation-gate.ts,
 * this is deliberately additive and off by default, so the existing
 * autonomous-task completion pipeline (already independently verified in
 * TypeScript, see validation-gate.ts) is completely unaffected by this
 * file's existence. See docs/architecture.md for the integration plan: the
 * one call site this would plug into, and why wiring it live was left as a
 * documented next step rather than forced in without a way to test it
 * against real SSH/tmux demo infrastructure in this environment.
 *
 * Wire format matches verifier-service/app/models.py exactly (snake_case
 * field names), this file intentionally does not translate to/from
 * camelCase, to keep the contract visibly identical on both sides rather
 * than hiding it behind a mapping layer.
 *
 * Signing scheme matches verifier-service/app/auth.py: hex HMAC-SHA256 of
 * "{unixTimestamp}.{rawBodyBytes}", keyed by VERIFIER_SHARED_SECRET, the
 * exact same secret and algorithm the Python service verifies against.
 */

import { createHmac } from "crypto";

export interface VerifierCommandResult {
  label: string;
  command: string;
  exit_code: number | null;
  stdout_summary?: string;
  stderr_summary?: string;
  duration_ms?: number;
}

export interface VerifierRequest {
  task_id: string;
  agent_reported_status?: "passed" | "failed" | null;
  agent_evidence?: string | null;
  independent_results: VerifierCommandResult[];
  changed_files?: string[];
}

export type VerifierState = "NOT_VERIFIED" | "INDEPENDENTLY_VERIFIED" | "VERIFICATION_FAILED";

export interface VerifierVerdict {
  task_id: string;
  verification_state: VerifierState;
  allowed: boolean;
  reasons: string[];
  risk_flags: string[];
}

const DEFAULT_TIMEOUT_MS = 10_000;

function signBody(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

/**
 * Calls the verifier service's POST /verify. Never throws, returns null on
 * any failure (service unreachable, timeout, non-2xx, unconfigured env),
 * matching the "best effort, never block the primary flow" convention used
 * throughout this codebase (e.g. emitAudit). Callers that want this to be a
 * hard requirement must check for null explicitly and decide what that
 * means for their own flow, this function will never silently invent a
 * passing verdict.
 */
export async function callVerifierService(
  request: VerifierRequest,
  opts?: { timeoutMs?: number },
): Promise<VerifierVerdict | null> {
  const baseUrl = process.env.VERIFIER_SERVICE_URL;
  const secret = process.env.VERIFIER_SHARED_SECRET;
  if (!baseUrl || !secret) return null;

  const rawBody = JSON.stringify(request);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signBody(secret, timestamp, rawBody);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Timestamp": timestamp,
        "X-Signature": signature,
      },
      body: rawBody,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as VerifierVerdict;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
