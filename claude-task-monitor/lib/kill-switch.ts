/**
 * Phase 4.9 — Platform Kill Switch
 *
 * Emergency shutdown system that can immediately halt all agent activity.
 * A single action disables:
 *   - Task dispatch
 *   - Self-healing automation
 *   - Auto-commit / auto-push
 *   - All agent execution
 *
 * Supported activation methods:
 *   - UI toggle (kill switch page)
 *   - API endpoint (POST /api/admin/kill-switch)
 *   - Environment variable (PLATFORM_KILL_SWITCH=1)
 *
 * Kill switch state is persisted in SystemConfig for durability across
 * process restarts. In-memory cache with 5-second TTL for performance.
 */

import { prisma } from "@/lib/prisma";
import { emitAudit } from "@/lib/audit";

export type KillSwitchReason =
  | "security_incident"
  | "prompt_injection"
  | "agent_compromise"
  | "credential_leak"
  | "manual_stop"
  | "maintenance"
  | "anomaly_detected";

export interface KillSwitchState {
  active: boolean;
  reason?: KillSwitchReason;
  detail?: string;
  activatedAt?: Date;
  activatedBy?: string;
  /** Controls which subsystems are halted */
  scope: KillSwitchScope;
}

export interface KillSwitchScope {
  taskDispatch: boolean;
  selfHealing: boolean;
  autoCommit: boolean;
  autoPush: boolean;
  agentExecution: boolean;
}

const FULL_SCOPE: KillSwitchScope = {
  taskDispatch: true,
  selfHealing: true,
  autoCommit: true,
  autoPush: true,
  agentExecution: true,
};

const DB_KEY = "kill_switch";
const CACHE_TTL_MS = 5_000; // 5 seconds

let cachedState: KillSwitchState | null = null;
let cacheExpiry = 0;

/**
 * Check if the kill switch is active via environment variable.
 * This is the fastest check — evaluated before any DB or cache lookup.
 */
function isEnvKillSwitchActive(): boolean {
  const envValue = process.env.PLATFORM_KILL_SWITCH;
  return envValue === "1" || envValue?.toLowerCase() === "true";
}

/**
 * Load kill switch state from the database.
 * Returns a default inactive state if no record exists.
 */
async function loadStateFromDb(): Promise<KillSwitchState> {
  try {
    const config = await prisma.systemConfig.findUnique({
      where: { key: DB_KEY },
    });

    if (!config?.value) {
      return { active: false, scope: FULL_SCOPE };
    }

    return JSON.parse(config.value) as KillSwitchState;
  } catch {
    // On DB error, fail safe — return inactive
    return { active: false, scope: FULL_SCOPE };
  }
}

/**
 * Get the current kill switch state.
 * Checks env var first (immediate), then in-memory cache, then DB.
 */
export async function getKillSwitchState(): Promise<KillSwitchState> {
  // Env var overrides everything — checked first for zero-latency halt
  if (isEnvKillSwitchActive()) {
    return {
      active: true,
      reason: "manual_stop",
      detail: "Activated via PLATFORM_KILL_SWITCH environment variable",
      scope: FULL_SCOPE,
    };
  }

  const now = Date.now();
  if (cachedState && now < cacheExpiry) {
    return cachedState;
  }

  const state = await loadStateFromDb();
  cachedState = state;
  cacheExpiry = now + CACHE_TTL_MS;

  return state;
}

/**
 * Check if a specific subsystem is halted.
 * Primary guard for all subsystems — call before any dispatch.
 */
export async function isSubsystemHalted(
  subsystem: keyof KillSwitchScope,
): Promise<boolean> {
  // Env var fast path
  if (isEnvKillSwitchActive()) return true;

  const state = await getKillSwitchState();
  return state.active && (state.scope[subsystem] ?? false);
}

/**
 * Activate the kill switch with a reason and optional scope.
 * Defaults to full scope (halt everything).
 */
export async function activateKillSwitch(opts: {
  reason: KillSwitchReason;
  detail?: string;
  activatedBy?: string;
  scope?: Partial<KillSwitchScope>;
}): Promise<KillSwitchState> {
  const newState: KillSwitchState = {
    active: true,
    reason: opts.reason,
    detail: opts.detail,
    activatedAt: new Date(),
    activatedBy: opts.activatedBy ?? "system",
    scope: { ...FULL_SCOPE, ...opts.scope },
  };

  await prisma.systemConfig.upsert({
    where: { key: DB_KEY },
    create: { key: DB_KEY, value: JSON.stringify(newState) },
    update: { value: JSON.stringify(newState) },
  });

  // Invalidate cache immediately
  cachedState = newState;
  cacheExpiry = Date.now() + CACHE_TTL_MS;

  await emitAudit({
    entityType: "kill-switch",
    entityId: "platform",
    eventType: "kill_switch.activated",
    actorType: opts.activatedBy ?? "system",
    payload: {
      reason: opts.reason,
      detail: opts.detail,
      scope: newState.scope,
      activatedBy: opts.activatedBy,
    },
  });

  console.warn(
    `[KILL_SWITCH] ACTIVATED by="${opts.activatedBy ?? "system"}" ` +
    `reason="${opts.reason}" detail="${opts.detail ?? "none"}"`,
  );

  return newState;
}

/**
 * Deactivate the kill switch and resume normal operations.
 */
export async function deactivateKillSwitch(opts: {
  deactivatedBy?: string;
  detail?: string;
}): Promise<KillSwitchState> {
  const newState: KillSwitchState = {
    active: false,
    scope: FULL_SCOPE,
  };

  await prisma.systemConfig.upsert({
    where: { key: DB_KEY },
    create: { key: DB_KEY, value: JSON.stringify(newState) },
    update: { value: JSON.stringify(newState) },
  });

  // Invalidate cache immediately
  cachedState = newState;
  cacheExpiry = Date.now() + CACHE_TTL_MS;

  await emitAudit({
    entityType: "kill-switch",
    entityId: "platform",
    eventType: "kill_switch.deactivated",
    actorType: opts.deactivatedBy ?? "system",
    payload: {
      deactivatedBy: opts.deactivatedBy,
      detail: opts.detail,
    },
  });

  console.info(
    `[KILL_SWITCH] DEACTIVATED by="${opts.deactivatedBy ?? "system"}" detail="${opts.detail ?? "none"}"`,
  );

  return newState;
}

/**
 * Throw a standardized error if a subsystem is halted.
 * Call at the top of any dispatch function.
 */
export async function assertSubsystemActive(subsystem: keyof KillSwitchScope): Promise<void> {
  const halted = await isSubsystemHalted(subsystem);
  if (halted) {
    const state = await getKillSwitchState();
    throw new KillSwitchError(
      `Platform kill switch active: ${subsystem} is halted. ` +
      `Reason: ${state.reason ?? "unknown"}. ${state.detail ?? ""}`,
      subsystem,
    );
  }
}

export class KillSwitchError extends Error {
  readonly subsystem: keyof KillSwitchScope;
  constructor(message: string, subsystem: keyof KillSwitchScope) {
    super(message);
    this.name = "KillSwitchError";
    this.subsystem = subsystem;
  }
}

/**
 * Get kill switch activation history from audit events.
 */
export async function getKillSwitchHistory(limit = 20): Promise<Array<{
  eventType: string;
  reason?: string;
  activatedBy?: string;
  detail?: string;
  timestamp: Date;
}>> {
  const events = await prisma.auditEvent.findMany({
    where: {
      eventType: { in: ["kill_switch.activated", "kill_switch.deactivated"] },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return events.map((e) => {
    const payload = e.payload as Record<string, unknown>;
    return {
      eventType: e.eventType,
      reason: payload.reason as string | undefined,
      activatedBy: (payload.activatedBy ?? payload.deactivatedBy) as string | undefined,
      detail: payload.detail as string | undefined,
      timestamp: e.createdAt,
    };
  });
}
