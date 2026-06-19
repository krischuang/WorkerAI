/**
 * P3-1: IDOR Protection
 *
 * Verifies that resource access helpers correctly:
 *   1. Return records for existing resources (owner access).
 *   2. Return null for non-existent resources (non-owner / unknown ID).
 *   3. Return null for child resources that belong to a different parent.
 *
 * These tests use mocks to avoid DB access.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the prisma singleton before importing resource-access.
vi.mock("../prisma", () => ({
  prisma: {
    task: {
      findUnique: vi.fn(),
    },
    taskArtifact: {
      findUnique: vi.fn(),
    },
    taskSecret: {
      findUnique: vi.fn(),
    },
  },
}));

import { prisma } from "../prisma";
import { getTaskOrNull, getArtifactOrNull, getTaskSecretOrNull } from "../resource-access";

const mockPrisma = prisma as unknown as {
  task: { findUnique: ReturnType<typeof vi.fn> };
  taskArtifact: { findUnique: ReturnType<typeof vi.fn> };
  taskSecret: { findUnique: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.resetAllMocks();
});

// ─── getTaskOrNull ────────────────────────────────────────────────────────────

describe("getTaskOrNull — owner access", () => {
  it("returns the task record when the task exists", async () => {
    const task = { id: "task-abc", projectId: "proj-1" };
    mockPrisma.task.findUnique.mockResolvedValueOnce(task);

    const result = await getTaskOrNull("task-abc");
    expect(result).toEqual(task);
    expect(mockPrisma.task.findUnique).toHaveBeenCalledWith({
      where: { id: "task-abc" },
      select: { id: true, projectId: true },
    });
  });
});

describe("getTaskOrNull — non-owner / unknown ID", () => {
  it("returns null when the task does not exist", async () => {
    mockPrisma.task.findUnique.mockResolvedValueOnce(null);
    const result = await getTaskOrNull("non-existent-id");
    expect(result).toBeNull();
  });
});

// ─── getArtifactOrNull ────────────────────────────────────────────────────────

describe("getArtifactOrNull — owner access", () => {
  it("returns the artifact when it belongs to the given task", async () => {
    const artifact = { id: "art-1", taskId: "task-abc" };
    mockPrisma.taskArtifact.findUnique.mockResolvedValueOnce(artifact);

    const result = await getArtifactOrNull("art-1", "task-abc");
    expect(result).toEqual(artifact);
  });
});

describe("getArtifactOrNull — non-owner (wrong task)", () => {
  it("returns null when the artifact belongs to a different task", async () => {
    // Artifact exists but belongs to task-xyz, not task-abc
    const artifact = { id: "art-1", taskId: "task-xyz" };
    mockPrisma.taskArtifact.findUnique.mockResolvedValueOnce(artifact);

    const result = await getArtifactOrNull("art-1", "task-abc");
    expect(result).toBeNull();
  });

  it("returns null when the artifact does not exist", async () => {
    mockPrisma.taskArtifact.findUnique.mockResolvedValueOnce(null);
    const result = await getArtifactOrNull("non-existent", "task-abc");
    expect(result).toBeNull();
  });
});

// ─── getTaskSecretOrNull ──────────────────────────────────────────────────────

describe("getTaskSecretOrNull — owner access", () => {
  it("returns the secret when it belongs to the given task", async () => {
    const secret = { taskId: "task-abc", key: "API_KEY" };
    mockPrisma.taskSecret.findUnique.mockResolvedValueOnce(secret);

    const result = await getTaskSecretOrNull("task-abc", "API_KEY");
    expect(result).toEqual(secret);
  });
});

describe("getTaskSecretOrNull — non-owner", () => {
  it("returns null when the secret does not exist for the task", async () => {
    mockPrisma.taskSecret.findUnique.mockResolvedValueOnce(null);
    const result = await getTaskSecretOrNull("task-abc", "MISSING_KEY");
    expect(result).toBeNull();
  });
});
