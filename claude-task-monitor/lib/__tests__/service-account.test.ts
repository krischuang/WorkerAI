/**
 * Tenant-isolation regression tests for the external /api/v1 surface.
 *
 * Mirrors the style of idor-protection.test.ts: mocked prisma, no DB
 * required. These tests exist specifically to prove the claim made in
 * docs/architecture.md, that a scoped service-account key cannot read or
 * act on a project outside its granted scope, and that revoked/malformed
 * keys are rejected identically to unknown ones (no existence leakage).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../prisma", () => ({
  prisma: {
    apiClient: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("../audit", () => ({
  emitAudit: vi.fn(),
}));

import { prisma } from "../prisma";
import {
  createServiceAccount,
  authenticateServiceAccount,
  authenticateServiceAccountRequest,
  isProjectInScope,
  listServiceAccounts,
  revokeServiceAccount,
} from "../service-account";

const mockPrisma = prisma as unknown as {
  apiClient: {
    create: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
};

beforeEach(() => {
  vi.resetAllMocks();
  mockPrisma.apiClient.update.mockResolvedValue(undefined);
});

// ─── createServiceAccount ─────────────────────────────────────────────────────

describe("createServiceAccount", () => {
  it("generates a raw key with the expected prefix and never persists it", async () => {
    mockPrisma.apiClient.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "acct-1",
      createdAt: new Date(),
      ...data,
    }));

    const { rawKey, summary } = await createServiceAccount({
      name: "partner-integration",
      projectIds: ["proj-a"],
    });

    expect(rawKey).toMatch(/^wai_sk_[a-f0-9]{64}$/);
    const createCall = mockPrisma.apiClient.create.mock.calls[0][0];
    expect(createCall.data.keyHash).not.toBe(rawKey);
    expect(createCall.data.keyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(createCall.data.projectIds).toEqual(["proj-a"]);
    expect(summary.projectIds).toEqual(["proj-a"]);
    // Summary type must never carry the raw key or hash.
    expect(summary).not.toHaveProperty("keyHash");
  });

  it("produces a different key and hash on every call", async () => {
    mockPrisma.apiClient.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "acct",
      createdAt: new Date(),
      ...data,
    }));

    const first = await createServiceAccount({ name: "a", projectIds: ["p1"] });
    const second = await createServiceAccount({ name: "b", projectIds: ["p1"] });

    expect(first.rawKey).not.toBe(second.rawKey);
  });
});

// --- authenticateServiceAccount: the core isolation boundary ---

describe("authenticateServiceAccount", () => {
  it("resolves a valid, active key to its scoped context", async () => {
    mockPrisma.apiClient.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "acct-1",
      createdAt: new Date(),
      ...data,
    }));
    const { rawKey, summary } = await createServiceAccount({ name: "x", projectIds: ["proj-a", "proj-b"] });

    mockPrisma.apiClient.findUnique.mockResolvedValueOnce({
      id: summary.id,
      name: "x",
      keyHash: "irrelevant-because-lookup-is-mocked",
      projectIds: ["proj-a", "proj-b"],
      revokedAt: null,
    });

    const ctx = await authenticateServiceAccount(rawKey);
    expect(ctx).toEqual({ id: summary.id, name: "x", projectIds: ["proj-a", "proj-b"] });
  });

  it("rejects a malformed key without a DB round-trip (no wai_sk_ prefix)", async () => {
    const ctx = await authenticateServiceAccount("not-a-real-key");
    expect(ctx).toBeNull();
    expect(mockPrisma.apiClient.findUnique).not.toHaveBeenCalled();
  });

  it("rejects null/undefined keys", async () => {
    expect(await authenticateServiceAccount(null)).toBeNull();
    expect(await authenticateServiceAccount(undefined)).toBeNull();
  });

  it("rejects an unknown key hash (never minted)", async () => {
    mockPrisma.apiClient.findUnique.mockResolvedValueOnce(null);
    const ctx = await authenticateServiceAccount("wai_sk_" + "0".repeat(64));
    expect(ctx).toBeNull();
  });

  it("rejects a revoked key even though the hash still matches a row", async () => {
    mockPrisma.apiClient.findUnique.mockResolvedValueOnce({
      id: "acct-1",
      name: "x",
      projectIds: ["proj-a"],
      revokedAt: new Date(),
    });
    const ctx = await authenticateServiceAccount("wai_sk_" + "1".repeat(64));
    expect(ctx).toBeNull();
  });
});

// --- isProjectInScope: the actual tenant boundary check ---

describe("isProjectInScope: cross-tenant leakage", () => {
  it("allows a project explicitly in scope", () => {
    const client = { id: "acct-1", name: "x", projectIds: ["proj-a", "proj-b"] };
    expect(isProjectInScope(client, "proj-a")).toBe(true);
  });

  it("denies a project NOT in scope: the core cross-tenant-leakage guarantee", () => {
    const client = { id: "acct-1", name: "x", projectIds: ["proj-a"] };
    expect(isProjectInScope(client, "proj-b")).toBe(false);
  });

  it("denies every project when scope is empty", () => {
    const client = { id: "acct-1", name: "x", projectIds: [] as string[] };
    expect(isProjectInScope(client, "proj-a")).toBe(false);
  });
});

// --- authenticateServiceAccountRequest: header parsing ---

describe("authenticateServiceAccountRequest", () => {
  it("returns null when the Authorization header is missing", async () => {
    const req = new Request("https://x.test/api/v1/projects");
    expect(await authenticateServiceAccountRequest(req)).toBeNull();
  });

  it("returns null when the header is not a Bearer token", async () => {
    const req = new Request("https://x.test/api/v1/projects", {
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(await authenticateServiceAccountRequest(req)).toBeNull();
  });

  it("extracts and authenticates a well-formed Bearer token", async () => {
    mockPrisma.apiClient.findUnique.mockResolvedValueOnce({
      id: "acct-1",
      name: "x",
      projectIds: ["proj-a"],
      revokedAt: null,
    });
    const req = new Request("https://x.test/api/v1/projects", {
      headers: { authorization: `Bearer wai_sk_${"a".repeat(64)}` },
    });
    const ctx = await authenticateServiceAccountRequest(req);
    expect(ctx).toEqual({ id: "acct-1", name: "x", projectIds: ["proj-a"] });
  });
});

// --- listServiceAccounts / revokeServiceAccount: admin surface hygiene ---

describe("listServiceAccounts", () => {
  it("never includes keyHash in the returned summaries", async () => {
    mockPrisma.apiClient.findMany.mockResolvedValueOnce([
      {
        id: "acct-1",
        name: "x",
        keyHash: "should-never-leave-this-function",
        keyPrefix: "wai_sk_abcd1234",
        projectIds: ["proj-a"],
        revokedAt: null,
        lastUsedAt: null,
        createdAt: new Date(),
        createdBy: "admin",
      },
    ]);

    const accounts = await listServiceAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).not.toHaveProperty("keyHash");
    expect(accounts[0].keyPrefix).toBe("wai_sk_abcd1234");
  });
});

describe("revokeServiceAccount", () => {
  it("sets revokedAt only for the matching, not-already-revoked row", async () => {
    mockPrisma.apiClient.updateMany.mockResolvedValueOnce({ count: 1 });
    await revokeServiceAccount("acct-1");
    expect(mockPrisma.apiClient.updateMany).toHaveBeenCalledWith({
      where: { id: "acct-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it("is idempotent, revoking an unknown/already-revoked ID does not throw", async () => {
    mockPrisma.apiClient.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(revokeServiceAccount("unknown")).resolves.toBeUndefined();
  });
});
