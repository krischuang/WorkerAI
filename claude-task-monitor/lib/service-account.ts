/**
 * Scoped service-account credentials for the external /api/v1 integration
 * surface.
 *
 * WorkerAI's primary UI is intentionally single-operator (one shared
 * AUTH_SECRET password, see middleware.ts / CLAUDE.md "Known Limitations").
 * Retrofitting real per-user tenant isolation across all 30 Prisma models
 * would be a large, demo-risking migration, not the "small coherent
 * vertical slice" called for when multi-tenancy is actually needed.
 *
 * Instead, this module adds a genuinely backend-enforced isolation boundary
 * for a *separate* surface: machine clients (partner integrations, the
 * Python verifier service, CI callbacks, etc.) authenticate with a bearer
 * API key that is scoped to an explicit list of project IDs. Every /api/v1
 * route handler must call `assertProjectScope` (or filter a list query by
 * `client.projectIds`) before touching data, the scope check happens at
 * the Prisma query layer, not in a UI filter, so a scoped key physically
 * cannot read or mutate another tenant's Project/Task/ExecutionLog rows.
 *
 * Raw keys are never persisted, only a sha256 hash (ApiClient.keyHash) and
 * a short, non-secret prefix for identification in admin tooling/logs. The
 * raw key is returned exactly once, at creation time.
 *
 * Node.js runtime only (uses `crypto`), do not import from middleware.ts
 * (Edge runtime). middleware.ts only passes /api/v1 Bearer requests through
 * without inspecting them; every route handler under app/api/v1/** must
 * call authenticateServiceAccount itself, the same pattern already used by
 * requireAdmin for the Node-only admin bcrypt check.
 */

import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { emitAudit } from "@/lib/audit";

const KEY_PREFIX = "wai_sk_";
/** Non-secret portion of the raw key shown in admin tooling/logs for identification. */
const PREFIX_DISPLAY_LEN = KEY_PREFIX.length + 8;

export interface ServiceAccountContext {
  id: string;
  name: string;
  projectIds: string[];
}

export interface ServiceAccountSummary {
  id: string;
  name: string;
  keyPrefix: string;
  projectIds: string[];
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  createdBy: string;
}

function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

/** Generates a new raw key and its hash. The raw value is never stored. */
function generateKeyMaterial(): { rawKey: string; keyHash: string; keyPrefix: string } {
  const rawKey = `${KEY_PREFIX}${randomBytes(32).toString("hex")}`;
  return {
    rawKey,
    keyHash: hashApiKey(rawKey),
    keyPrefix: rawKey.slice(0, PREFIX_DISPLAY_LEN),
  };
}

/**
 * Create a new scoped service account. `projectIds` must be explicit,
 * there is no wildcard/"all projects" option by design, so a newly minted
 * key can never accidentally see more than the caller intended.
 *
 * Returns the raw key exactly once; callers must display/transmit it
 * immediately and cannot retrieve it again afterward.
 */
export async function createServiceAccount(opts: {
  name: string;
  projectIds: string[];
  createdBy?: string;
}): Promise<{ rawKey: string; summary: ServiceAccountSummary }> {
  const { rawKey, keyHash, keyPrefix } = generateKeyMaterial();

  const record = await prisma.apiClient.create({
    data: {
      name: opts.name,
      keyHash,
      keyPrefix,
      projectIds: opts.projectIds,
      createdBy: opts.createdBy ?? "admin",
    },
  });

  await emitAudit({
    entityType: "service-account",
    entityId: record.id,
    eventType: "service_account.created",
    actorType: opts.createdBy ?? "admin",
    payload: { name: opts.name, projectIds: opts.projectIds, keyPrefix },
  });

  return { rawKey, summary: toSummary(record) };
}

function toSummary(record: {
  id: string;
  name: string;
  keyPrefix: string;
  projectIds: string[];
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  createdBy: string;
}): ServiceAccountSummary {
  return {
    id: record.id,
    name: record.name,
    keyPrefix: record.keyPrefix,
    projectIds: record.projectIds,
    revokedAt: record.revokedAt,
    lastUsedAt: record.lastUsedAt,
    createdAt: record.createdAt,
    createdBy: record.createdBy,
  };
}

export async function listServiceAccounts(): Promise<ServiceAccountSummary[]> {
  const records = await prisma.apiClient.findMany({ orderBy: { createdAt: "desc" } });
  return records.map(toSummary);
}

/** Idempotent, revoking an already-revoked or unknown ID is not an error. */
export async function revokeServiceAccount(id: string, revokedBy?: string): Promise<void> {
  await prisma.apiClient.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await emitAudit({
    entityType: "service-account",
    entityId: id,
    eventType: "service_account.revoked",
    actorType: revokedBy ?? "admin",
    payload: {},
  });
}

/**
 * Authenticate a raw bearer key presented on an /api/v1 request.
 *
 * Returns null for any of: malformed key, unknown hash, or a revoked
 * credential, callers must treat all three identically (401), never
 * distinguishing "revoked" from "never existed" in the response, to avoid
 * leaking account existence.
 */
export async function authenticateServiceAccount(rawKey: string | null | undefined): Promise<ServiceAccountContext | null> {
  if (!rawKey || !rawKey.startsWith(KEY_PREFIX)) return null;

  const keyHash = hashApiKey(rawKey);
  const record = await prisma.apiClient.findUnique({ where: { keyHash } });
  if (!record || record.revokedAt) return null;

  // Best-effort, must never block or fail the request on a write hiccup.
  prisma.apiClient
    .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return { id: record.id, name: record.name, projectIds: record.projectIds };
}

/** True when the authenticated client's scope includes the given project. */
export function isProjectInScope(client: ServiceAccountContext, projectId: string): boolean {
  return client.projectIds.includes(projectId);
}

/**
 * Extracts and authenticates the bearer token from a request's Authorization
 * header. Returns null (caller should respond 401) when the header is
 * missing, malformed, or the key does not resolve to an active account.
 */
export async function authenticateServiceAccountRequest(request: Request): Promise<ServiceAccountContext | null> {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  return authenticateServiceAccount(header.slice("Bearer ".length).trim());
}
