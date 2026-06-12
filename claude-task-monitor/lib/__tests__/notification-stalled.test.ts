import { describe, test, expect } from "vitest";
import { buildStalledFields, type NotificationPayload } from "../notification";

const STALL_DETECTED = new Date("2026-06-11T10:00:00Z");
const LAST_PROGRESS  = new Date("2026-06-11T09:30:00Z");

describe("buildStalledFields", () => {
  test("converts Date objects to ISO strings", () => {
    const fields = buildStalledFields({
      stallDetectedAt: STALL_DETECTED,
      lastProgressAt: LAST_PROGRESS,
      timeStuckMinutes: 30,
    });

    expect(fields.stallDetectedAt).toBe(STALL_DETECTED.toISOString());
    expect(fields.lastProgressAt).toBe(LAST_PROGRESS.toISOString());
    expect(fields.timeStuckMinutes).toBe(30);
  });

  test("returns null for null Date fields", () => {
    const fields = buildStalledFields({
      stallDetectedAt: null,
      lastProgressAt: null,
      timeStuckMinutes: 45,
    });

    expect(fields.stallDetectedAt).toBeNull();
    expect(fields.lastProgressAt).toBeNull();
    expect(fields.timeStuckMinutes).toBe(45);
  });

  test("returned object has exactly the three expected keys", () => {
    const fields = buildStalledFields({
      stallDetectedAt: STALL_DETECTED,
      lastProgressAt: LAST_PROGRESS,
      timeStuckMinutes: 10,
    });

    expect(Object.keys(fields).sort()).toEqual(
      ["lastProgressAt", "stallDetectedAt", "timeStuckMinutes"].sort(),
    );
  });
});

describe("NotificationPayload — task.stalled shape", () => {
  test("a task.stalled payload satisfies the NotificationPayload type", () => {
    const payload: NotificationPayload = {
      event: "task.stalled",
      taskId: "task-abc123",
      title: "Run nightly migration",
      status: "failed",
      projectId: "proj-xyz",
      projectName: "My Project",
      agentId: null,
      serverId: "srv-1",
      errorMessage: "Zombie task: no progress for 30min — auto-failed",
      durationMs: null,
      timestamp: new Date().toISOString(),
      stallDetectedAt: STALL_DETECTED.toISOString(),
      lastProgressAt: LAST_PROGRESS.toISOString(),
      timeStuckMinutes: 30,
    };

    expect(payload.event).toBe("task.stalled");
    expect(payload.stallDetectedAt).toBe(STALL_DETECTED.toISOString());
    expect(payload.lastProgressAt).toBe(LAST_PROGRESS.toISOString());
    expect(payload.timeStuckMinutes).toBe(30);
    expect(typeof payload.taskId).toBe("string");
    expect(typeof payload.title).toBe("string");
    expect(typeof payload.timestamp).toBe("string");
  });

  test("stall fields are optional (undefined) on non-stalled payloads", () => {
    const payload: NotificationPayload = {
      event: "task.failed",
      taskId: "task-def456",
      title: "Some task",
      status: "failed",
      projectId: "proj-xyz",
      projectName: null,
      agentId: null,
      serverId: null,
      errorMessage: "SSH connection refused",
      durationMs: 5000,
      timestamp: new Date().toISOString(),
    };

    expect(payload.stallDetectedAt).toBeUndefined();
    expect(payload.lastProgressAt).toBeUndefined();
    expect(payload.timeStuckMinutes).toBeUndefined();
  });
});
