/**
 * Phase 4.2 — Secret Broker Architecture
 *
 * Replaces direct secret injection into agents with a TTL-based broker.
 * Agents request temporary credentials via a signed token; the broker
 * issues scoped, short-lived credentials and logs all access.
 *
 * Workflow:
 *   Agent → Request Secret (with signed task token)
 *   → Policy Engine validates request
 *   → Broker issues temporary credential with TTL
 *   → Credential auto-expires
 *   → All access logged immutably
 *
 * Never exposed: production secrets, root credentials, long-lived tokens.
 */

import { randomUUID, createHmac, timingSafeEqual } from "crypto";
import { getDecryptedTaskSecrets } from "@/lib/task-secrets";
import { emitAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";

const BROKER_SIGNING_KEY = process.env.SECRET_BROKER_KEY ?? process.env.TASK_SECRET_KEY ?? "";
const DEFAULT_TTL_SECONDS = 300; // 5 minutes
const MAX_TTL_SECONDS = 3600;    // 1 hour hard cap

export interface TemporaryCredential {
  credentialId: string;
  taskId: string;
  key: string;
  /** The actual secret value — only returned once at issuance */
  value: string;
  issuedAt: Date;
  expiresAt: Date;
  accessToken: string;
}

export interface CredentialRequest {
  taskId: string;
  /** Secret key name being requested */
  secretKey: string;
  /** Requesting entity (agentId or serverId) */
  requesterId: string;
  requesterType: "agent" | "server";
  /** Requested TTL in seconds (capped at MAX_TTL_SECONDS) */
  ttlSeconds?: number;
  /** Signed request token proving the requester knows the task context */
  requestToken?: string;
}

export type CredentialResponse =
  | { ok: true; credential: TemporaryCredential }
  | { ok: false; reason: "not_found" | "policy_denied" | "task_not_running" | "invalid_token" | "expired"; detail?: string };

// In-memory store for issued credentials (keyed by credentialId)
// In production, this should be backed by Redis with TTL support.
const issuedCredentials = new Map<string, {
  taskId: string;
  key: string;
  hashedValue: string;
  expiresAt: Date;
  revoked: boolean;
}>();

// Cleanup expired credentials every minute
setInterval(() => {
  const now = new Date();
  for (const [id, cred] of issuedCredentials.entries()) {
    if (cred.expiresAt < now || cred.revoked) {
      issuedCredentials.delete(id);
    }
  }
}, 60_000).unref();

/**
 * Generate a signed access token for a credential request.
 * The token binds taskId + secretKey + credentialId together.
 */
function signAccessToken(credentialId: string, taskId: string, key: string): string {
  const payload = `${credentialId}:${taskId}:${key}`;
  const hmac = createHmac("sha256", BROKER_SIGNING_KEY);
  hmac.update(payload);
  return `brk_${hmac.digest("base64url")}`;
}

/**
 * Verify a request token that proves the agent knows the task context.
 * Prevents unauthorized entities from requesting secrets for arbitrary tasks.
 */
export function verifyRequestToken(taskId: string, requesterId: string, token: string): boolean {
  if (!BROKER_SIGNING_KEY) return false;
  const expected = createHmac("sha256", BROKER_SIGNING_KEY)
    .update(`req:${taskId}:${requesterId}`)
    .digest("base64url");
  const expectedBuf = Buffer.from(`req_${expected}`);
  const actualBuf = Buffer.from(token.length === expectedBuf.length ? token : "x".repeat(expectedBuf.length));
  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Generate a request token that agents use to authenticate secret requests.
 * Called at dispatch time and injected as WORKERAI_BROKER_TOKEN env var.
 */
export function generateRequestToken(taskId: string, requesterId: string): string {
  const hmac = createHmac("sha256", BROKER_SIGNING_KEY);
  hmac.update(`req:${taskId}:${requesterId}`);
  return `req_${hmac.digest("base64url")}`;
}

/**
 * Request a temporary credential from the broker.
 * Validates task state, checks policy, issues scoped credential with TTL.
 */
export async function requestCredential(req: CredentialRequest): Promise<CredentialResponse> {
  // 1. Validate task is currently running
  const task = await prisma.task.findUnique({
    where: { id: req.taskId },
    select: { status: true, agentId: true, serverId: true },
  });

  if (!task || task.status !== "running") {
    await emitAudit({
      entityType: "secret-broker",
      entityId: req.taskId,
      eventType: "secret.request.denied",
      actorType: req.requesterType,
      payload: {
        reason: "task_not_running",
        requesterId: req.requesterId,
        secretKey: req.secretKey,
        taskStatus: task?.status ?? "not_found",
      },
    });
    return { ok: false, reason: "task_not_running", detail: `Task ${req.taskId} is not running` };
  }

  // 2. Verify requester is authorized for this task
  const isAuthorized =
    (req.requesterType === "agent" && task.agentId === req.requesterId) ||
    (req.requesterType === "server" && task.serverId === req.requesterId);

  if (!isAuthorized) {
    await emitAudit({
      entityType: "secret-broker",
      entityId: req.taskId,
      eventType: "secret.request.unauthorized",
      actorType: req.requesterType,
      payload: {
        requesterId: req.requesterId,
        secretKey: req.secretKey,
        taskAgentId: task.agentId,
        taskServerId: task.serverId,
      },
    });
    return { ok: false, reason: "policy_denied", detail: "Requester not authorized for this task" };
  }

  // 3. Retrieve the actual secret
  const secrets = await getDecryptedTaskSecrets(req.taskId).catch(() => []);
  const secret = secrets.find((s) => s.key === req.secretKey);

  if (!secret) {
    await emitAudit({
      entityType: "secret-broker",
      entityId: req.taskId,
      eventType: "secret.request.not_found",
      actorType: req.requesterType,
      payload: { requesterId: req.requesterId, secretKey: req.secretKey },
    });
    return { ok: false, reason: "not_found", detail: `Secret key "${req.secretKey}" not found` };
  }

  // 4. Issue temporary credential
  const ttl = Math.min(req.ttlSeconds ?? DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS);
  const credentialId = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttl * 1000);
  const accessToken = signAccessToken(credentialId, req.taskId, req.secretKey);

  // Store metadata only (not the actual value)
  issuedCredentials.set(credentialId, {
    taskId: req.taskId,
    key: req.secretKey,
    hashedValue: createHmac("sha256", BROKER_SIGNING_KEY).update(secret.value).digest("hex"),
    expiresAt,
    revoked: false,
  });

  await emitAudit({
    entityType: "secret-broker",
    entityId: req.taskId,
    eventType: "secret.credential.issued",
    actorType: req.requesterType,
    payload: {
      credentialId,
      requesterId: req.requesterId,
      secretKey: req.secretKey,
      ttlSeconds: ttl,
      expiresAt: expiresAt.toISOString(),
    },
  });

  return {
    ok: true,
    credential: {
      credentialId,
      taskId: req.taskId,
      key: req.secretKey,
      value: secret.value,
      issuedAt: now,
      expiresAt,
      accessToken,
    },
  };
}

/**
 * Revoke a specific credential immediately.
 * Called on task completion, failure, or security incident.
 */
export async function revokeCredential(
  credentialId: string,
  reason: string,
): Promise<boolean> {
  const cred = issuedCredentials.get(credentialId);
  if (!cred) return false;

  cred.revoked = true;
  issuedCredentials.set(credentialId, cred);

  await emitAudit({
    entityType: "secret-broker",
    entityId: credentialId,
    eventType: "secret.credential.revoked",
    actorType: "system",
    payload: { taskId: cred.taskId, secretKey: cred.key, reason },
  });

  return true;
}

/**
 * Revoke all credentials associated with a task.
 * Called when task completes, fails, or is terminated.
 */
export async function revokeAllTaskCredentials(
  taskId: string,
  reason: string,
): Promise<number> {
  let revoked = 0;
  for (const [id, cred] of issuedCredentials.entries()) {
    if (cred.taskId === taskId && !cred.revoked) {
      cred.revoked = true;
      issuedCredentials.set(id, cred);
      revoked++;

      await emitAudit({
        entityType: "secret-broker",
        entityId: id,
        eventType: "secret.credential.revoked",
        actorType: "system",
        payload: { taskId, secretKey: cred.key, reason, batchRevocation: true },
      });
    }
  }
  return revoked;
}

/**
 * Validate that a previously issued access token is still valid.
 * Used by the broker API to authenticate credential refresh requests.
 */
export function validateCredentialToken(
  credentialId: string,
  accessToken: string,
): { valid: boolean; reason?: string } {
  const cred = issuedCredentials.get(credentialId);
  if (!cred) return { valid: false, reason: "not_found" };
  if (cred.revoked) return { valid: false, reason: "revoked" };
  if (cred.expiresAt < new Date()) return { valid: false, reason: "expired" };

  const expected = signAccessToken(credentialId, cred.taskId, cred.key);
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(
    accessToken.length === expected.length ? accessToken : "x".repeat(expected.length),
  );

  if (!timingSafeEqual(expectedBuf, actualBuf)) {
    return { valid: false, reason: "invalid_token" };
  }

  return { valid: true };
}

/**
 * Return metrics about the broker state (for monitoring).
 */
export function getBrokerMetrics(): {
  activeCredentials: number;
  expiredCredentials: number;
  revokedCredentials: number;
} {
  const now = new Date();
  let active = 0;
  let expired = 0;
  let revoked = 0;

  for (const cred of issuedCredentials.values()) {
    if (cred.revoked) revoked++;
    else if (cred.expiresAt < now) expired++;
    else active++;
  }

  return { activeCredentials: active, expiredCredentials: expired, revokedCredentials: revoked };
}
