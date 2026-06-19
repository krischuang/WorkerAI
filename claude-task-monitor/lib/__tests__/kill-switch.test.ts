import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  activateKillSwitch,
  deactivateKillSwitch,
  isSubsystemHalted,
  KillSwitchError,
  assertSubsystemActive,
} from "../kill-switch";

// Mock prisma and audit to avoid real DB calls
vi.mock("../prisma", () => ({
  prisma: {
    systemConfig: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    },
    auditEvent: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock("../audit", () => ({ emitAudit: vi.fn().mockResolvedValue(undefined) }));

// Reset in-memory cache between tests
beforeEach(() => {
  // Clear module-level cache by re-importing — handled by vitest module isolation
  delete process.env.PLATFORM_KILL_SWITCH;
});

afterEach(() => {
  delete process.env.PLATFORM_KILL_SWITCH;
});

// ── Environment variable override ─────────────────────────────────────────────

describe("kill switch — env var override", () => {
  it("reports halted when PLATFORM_KILL_SWITCH=1", async () => {
    process.env.PLATFORM_KILL_SWITCH = "1";
    const halted = await isSubsystemHalted("taskDispatch");
    expect(halted).toBe(true);
  });

  it("reports halted when PLATFORM_KILL_SWITCH=true", async () => {
    process.env.PLATFORM_KILL_SWITCH = "true";
    const halted = await isSubsystemHalted("agentExecution");
    expect(halted).toBe(true);
  });

  it("reports not halted when PLATFORM_KILL_SWITCH is unset", async () => {
    delete process.env.PLATFORM_KILL_SWITCH;
    // With no DB record (mock returns null), should be inactive
    const halted = await isSubsystemHalted("taskDispatch");
    expect(halted).toBe(false);
  });
});

// ── Activate / deactivate ─────────────────────────────────────────────────────

describe("kill switch — activation", () => {
  it("activates with a reason and returns active state", async () => {
    const state = await activateKillSwitch({
      reason: "security_incident",
      detail: "Prompt injection detected",
      activatedBy: "admin",
    });

    expect(state.active).toBe(true);
    expect(state.reason).toBe("security_incident");
    expect(state.activatedBy).toBe("admin");
    expect(state.scope.taskDispatch).toBe(true);
    expect(state.scope.agentExecution).toBe(true);
    expect(state.scope.selfHealing).toBe(true);
  });

  it("activates with partial scope", async () => {
    const state = await activateKillSwitch({
      reason: "maintenance",
      scope: { taskDispatch: true, selfHealing: false, autoCommit: false, autoPush: false, agentExecution: false },
    });

    expect(state.active).toBe(true);
    expect(state.scope.taskDispatch).toBe(true);
    expect(state.scope.selfHealing).toBe(false);
  });

  it("deactivates and returns inactive state", async () => {
    const state = await deactivateKillSwitch({ deactivatedBy: "admin" });
    expect(state.active).toBe(false);
  });
});

// ── assertSubsystemActive ──────────────────────────────────────────────────────

describe("kill switch — assertSubsystemActive", () => {
  it("does not throw when env var is not set and DB returns null (inactive)", async () => {
    delete process.env.PLATFORM_KILL_SWITCH;
    await expect(assertSubsystemActive("taskDispatch")).resolves.toBeUndefined();
  });

  it("throws KillSwitchError when env var activates kill switch", async () => {
    process.env.PLATFORM_KILL_SWITCH = "1";
    await expect(assertSubsystemActive("taskDispatch")).rejects.toThrow(KillSwitchError);
  });

  it("KillSwitchError has the correct subsystem", async () => {
    process.env.PLATFORM_KILL_SWITCH = "1";
    try {
      await assertSubsystemActive("agentExecution");
    } catch (err) {
      expect(err).toBeInstanceOf(KillSwitchError);
      expect((err as KillSwitchError).subsystem).toBe("agentExecution");
    }
  });
});

// ── isSubsystemHalted with env var ────────────────────────────────────────────

describe("kill switch — isSubsystemHalted", () => {
  it("halts all subsystems when env var is set", async () => {
    process.env.PLATFORM_KILL_SWITCH = "1";
    const subsystems = ["taskDispatch", "selfHealing", "autoCommit", "autoPush", "agentExecution"] as const;
    for (const sub of subsystems) {
      expect(await isSubsystemHalted(sub)).toBe(true);
    }
  });

  it("does not halt any subsystem when env var is unset and DB is inactive", async () => {
    delete process.env.PLATFORM_KILL_SWITCH;
    const subsystems = ["taskDispatch", "selfHealing", "autoCommit", "autoPush", "agentExecution"] as const;
    for (const sub of subsystems) {
      expect(await isSubsystemHalted(sub)).toBe(false);
    }
  });
});
