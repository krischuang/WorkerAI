/**
 * Phase 4.7 — Egress Network Controls
 *
 * All outbound agent traffic must pass policy checks.
 * Implements allowlist/denylist with audit logging.
 *
 * Default allowlist:
 *   - github.com, api.github.com (source control)
 *   - openrouter.ai, api.anthropic.com (AI providers)
 *   - npm registry, PyPI (package installs — restricted)
 *
 * Default denylist:
 *   - Private IP ranges (RFC 1918) — prevents SSRF
 *   - Known malicious patterns
 */

import { emitAudit } from "@/lib/audit";

export type EgressDecision = "allow" | "deny" | "unknown";

export interface EgressPolicy {
  /** Allowed domains/patterns */
  allowlist: string[];
  /** Blocked domains/patterns */
  denylist: string[];
  /** Default decision for unlisted domains */
  defaultDecision: EgressDecision;
}

export interface EgressCheckResult {
  allowed: boolean;
  decision: EgressDecision;
  matchedAllowRule?: string;
  matchedDenyRule?: string;
  reason: string;
  url: string;
  host: string;
}

// Default allowlist — domains agents are always permitted to reach
const DEFAULT_ALLOWLIST: string[] = [
  // Source control
  "github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  // AI providers
  "api.anthropic.com",
  "openrouter.ai",
  // Package registries (read-only installs)
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  // CDN / assets
  "cdn.jsdelivr.net",
  "unpkg.com",
];

// Default denylist — domains agents must never reach
const DEFAULT_DENYLIST: string[] = [
  // Private IP ranges (SSRF prevention)
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  // Internal AWS metadata service
  "169.254.169.254",
  // IPv6 loopback
  "::1",
  "[::1]",
];

// Private IP CIDR ranges for SSRF prevention
const PRIVATE_IP_PATTERNS: RegExp[] = [
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^0\.0\.0\.0$/,
  /^169\.254\.\d{1,3}\.\d{1,3}$/,
  /^fc[0-9a-f]{2}:/i, // IPv6 ULA
  /^fd[0-9a-f]{2}:/i, // IPv6 ULA
];

/**
 * Check if a host is a private IP address (SSRF prevention).
 */
function isPrivateIp(host: string): boolean {
  return PRIVATE_IP_PATTERNS.some((p) => p.test(host));
}

/**
 * Extract the hostname from a URL.
 * Returns null if the URL is malformed.
 */
function extractHost(url: string): string | null {
  try {
    // Handle bare hostnames (no protocol)
    const withProtocol = url.startsWith("http") ? url : `https://${url}`;
    const parsed = new URL(withProtocol);
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Check if a host matches a pattern.
 * Patterns may be exact (github.com) or wildcard (*.github.com).
 */
function hostMatches(pattern: string, host: string): boolean {
  const normalizedPattern = pattern.toLowerCase();

  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }

  return host === normalizedPattern;
}

/**
 * Load custom egress policy from SystemConfig.
 */
async function loadCustomPolicy(): Promise<Partial<EgressPolicy>> {
  try {
    const { prisma } = await import("@/lib/prisma");
    const config = await prisma.systemConfig.findUnique({
      where: { key: "egress_policy" },
    });
    if (config?.value) {
      return JSON.parse(config.value) as Partial<EgressPolicy>;
    }
  } catch {
    // Return empty on error — defaults will apply
  }
  return {};
}

// Cache for custom policy
let cachedPolicy: Partial<EgressPolicy> | null = null;
let policyLastLoaded = 0;
const POLICY_CACHE_TTL = 30_000;

async function getEffectivePolicy(): Promise<EgressPolicy> {
  const now = Date.now();
  if (!cachedPolicy || now - policyLastLoaded > POLICY_CACHE_TTL) {
    cachedPolicy = await loadCustomPolicy();
    policyLastLoaded = now;
  }

  return {
    allowlist: [...DEFAULT_ALLOWLIST, ...(cachedPolicy.allowlist ?? [])],
    denylist: [...DEFAULT_DENYLIST, ...(cachedPolicy.denylist ?? [])],
    defaultDecision: cachedPolicy.defaultDecision ?? "deny",
  };
}

/**
 * Check whether an outbound connection to a URL is permitted.
 */
export async function checkEgress(opts: {
  url: string;
  taskId?: string;
  agentId?: string;
  purpose?: string;
}): Promise<EgressCheckResult> {
  const host = extractHost(opts.url);

  if (!host) {
    const result: EgressCheckResult = {
      allowed: false,
      decision: "deny",
      reason: `Malformed URL: "${opts.url}"`,
      url: opts.url,
      host: opts.url,
    };

    await logEgressDecision(opts.taskId, result, opts.purpose);
    return result;
  }

  // Reject private IPs unconditionally (SSRF prevention)
  if (isPrivateIp(host)) {
    const result: EgressCheckResult = {
      allowed: false,
      decision: "deny",
      matchedDenyRule: "private-ip-ssrf",
      reason: `Private IP address "${host}" blocked (SSRF prevention)`,
      url: opts.url,
      host,
    };
    await logEgressDecision(opts.taskId, result, opts.purpose);
    return result;
  }

  const policy = await getEffectivePolicy();

  // Check denylist first
  for (const denyPattern of policy.denylist) {
    if (hostMatches(denyPattern, host)) {
      const result: EgressCheckResult = {
        allowed: false,
        decision: "deny",
        matchedDenyRule: denyPattern,
        reason: `Host "${host}" matches denylist rule "${denyPattern}"`,
        url: opts.url,
        host,
      };
      await logEgressDecision(opts.taskId, result, opts.purpose);
      return result;
    }
  }

  // Check allowlist
  for (const allowPattern of policy.allowlist) {
    if (hostMatches(allowPattern, host)) {
      // Allowlisted — allow silently (don't audit every allowed request)
      return {
        allowed: true,
        decision: "allow",
        matchedAllowRule: allowPattern,
        reason: `Host "${host}" matches allowlist rule "${allowPattern}"`,
        url: opts.url,
        host,
      };
    }
  }

  // Default decision
  const defaultDecision = policy.defaultDecision;
  const result: EgressCheckResult = {
    allowed: defaultDecision === "allow",
    decision: defaultDecision,
    reason: `Host "${host}" not in allowlist — default decision: ${defaultDecision}`,
    url: opts.url,
    host,
  };

  await logEgressDecision(opts.taskId, result, opts.purpose);
  return result;
}

async function logEgressDecision(
  taskId: string | undefined,
  result: EgressCheckResult,
  purpose?: string,
): Promise<void> {
  if (result.allowed) return; // Don't log allowed requests

  await emitAudit({
    entityType: "egress",
    entityId: taskId ?? "global",
    eventType: result.allowed ? "egress.allowed" : "egress.blocked",
    actorType: "system",
    payload: {
      url: result.url,
      host: result.host,
      decision: result.decision,
      reason: result.reason,
      matchedDenyRule: result.matchedDenyRule,
      purpose,
    },
  });
}

/**
 * Batch check multiple URLs.
 * Used to pre-validate egress before task dispatch.
 */
export async function checkEgressBatch(opts: {
  urls: string[];
  taskId?: string;
}): Promise<{
  allAllowed: boolean;
  results: EgressCheckResult[];
  blocked: EgressCheckResult[];
}> {
  const results = await Promise.all(
    opts.urls.map((url) => checkEgress({ url, taskId: opts.taskId })),
  );

  const blocked = results.filter((r) => !r.allowed);

  return {
    allAllowed: blocked.length === 0,
    results,
    blocked,
  };
}

/**
 * Update the custom egress policy in SystemConfig.
 */
export async function updateEgressPolicy(policy: Partial<EgressPolicy>): Promise<void> {
  const { prisma } = await import("@/lib/prisma");
  await prisma.systemConfig.upsert({
    where: { key: "egress_policy" },
    create: { key: "egress_policy", value: JSON.stringify(policy) },
    update: { value: JSON.stringify(policy) },
  });

  // Invalidate cache
  cachedPolicy = null;
  policyLastLoaded = 0;

  await emitAudit({
    entityType: "egress",
    entityId: "policy",
    eventType: "egress.policy.updated",
    actorType: "system",
    payload: { allowlistCount: policy.allowlist?.length ?? 0, denylistCount: policy.denylist?.length ?? 0 },
  });
}

/**
 * Get egress statistics from audit events.
 */
export async function getEgressStats(sinceHours = 24): Promise<{
  blocked: number;
  blockedHosts: Record<string, number>;
}> {
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  const { prisma } = await import("@/lib/prisma");

  const events = await prisma.auditEvent.findMany({
    where: {
      eventType: "egress.blocked",
      createdAt: { gte: since },
    },
    select: { payload: true },
    take: 1000,
  });

  const blockedHosts: Record<string, number> = {};
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    const host = payload.host as string | undefined;
    if (host) {
      blockedHosts[host] = (blockedHosts[host] ?? 0) + 1;
    }
  }

  return { blocked: events.length, blockedHosts };
}
