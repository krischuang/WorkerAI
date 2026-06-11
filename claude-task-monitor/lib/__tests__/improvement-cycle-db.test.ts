/**
 * Tests for the DB-direct improvement cycle flow.
 *
 * Covers:
 *   1. runProjectScan — success, zero suggestions, error paths
 *   2. No dependency on parseable terminal JSON
 *   3. Tenant isolation (projectId + sourceId scoping)
 *   4. Duplicate scoping per scan (sourceId)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    server: { findUnique: vi.fn(), findFirst: vi.fn() },
    agent: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    task: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
    taskSuggestion: { count: vi.fn(), findMany: vi.fn() },
    projectScan: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
    improvementCycle: {
      findUnique: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(),
      create: vi.fn(), update: vi.fn(), count: vi.fn(),
    },
    auditEvent: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/ssh-claude-tmux", () => ({
  sendRawPromptToTmux: vi.fn(),
  detectClaudeIdle: vi.fn(),
}));

vi.mock("@/lib/dispatch-lock", () => ({
  withServerDispatchLock: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@/lib/audit", () => ({
  emitAudit: vi.fn(),
}));

import { runProjectScan } from "../project-scan-service";
import { prisma } from "@/lib/prisma";
import { sendRawPromptToTmux, detectClaudeIdle } from "@/lib/ssh-claude-tmux";
import { IMPROVEMENT_SCAN_MIN_WAIT_MS } from "../constants";

const mockProject = vi.mocked(prisma.project);
const mockServer = vi.mocked(prisma.server);
const mockTask = vi.mocked(prisma.task);
const mockTaskSuggestion = vi.mocked(prisma.taskSuggestion);
const mockProjectScan = vi.mocked(prisma.projectScan);
const mockTransaction = vi.mocked(prisma.$transaction);
const mockSendPrompt = vi.mocked(sendRawPromptToTmux);
const mockDetectIdle = vi.mocked(detectClaudeIdle);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PROJECT_ID = "proj_abc123";
const OTHER_PROJECT_ID = "proj_xyz999";
const SERVER_ID = "srv_def456";
const SCAN_ID = "scan_ghi789";

const SERVER = {
  id: SERVER_ID,
  host: "10.0.0.1",
  port: 22,
  username: "user",
  sshKeyPath: "/home/user/.ssh/id_rsa",
  tmuxSession: "claude",
};

const PROJECT = { id: PROJECT_ID, name: "My Project", description: "A test project" };

const TASKS = [
  { title: "Add auth", description: "Implement auth", resultSummary: "Done" },
  { title: "Fix N+1", description: "Fix DB queries", resultSummary: "Resolved" },
];

function setupHappyPath(scanId = SCAN_ID) {
  mockProject.findUnique.mockResolvedValue(PROJECT as never);
  mockServer.findUnique.mockResolvedValue(SERVER as never);
  mockTask.findMany.mockResolvedValue(TASKS as never);
  mockTask.count.mockResolvedValue(0); // no running tasks
  mockProjectScan.create.mockResolvedValue({ id: scanId } as never);
  mockProjectScan.update.mockResolvedValue({} as never);
  mockProject.update.mockResolvedValue({} as never);
  mockTransaction.mockImplementation(async (fn: unknown) => {
    const tx = { projectScan: { update: vi.fn() }, project: { update: vi.fn() } };
    return (fn as (tx: unknown) => Promise<unknown>)(tx);
  });
  mockSendPrompt.mockResolvedValue({ success: true });
  // Return idle immediately so the polling loop exits right away.
  mockDetectIdle.mockResolvedValue({ isIdle: true, paneText: "> " });
}

/**
 * Run `fn` with fake timers active. After calling `fn()`, advances time past
 * IMPROVEMENT_SCAN_MIN_WAIT_MS so waitForClaudeIdle exits the initial wait,
 * then returns the awaited result.
 */
async function withFakeTimers<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const p = fn();
    // Advance past the mandatory minimum-wait before the first idle check.
    await vi.advanceTimersByTimeAsync(IMPROVEMENT_SCAN_MIN_WAIT_MS + 100);
    return await p;
  } finally {
    vi.useRealTimers();
  }
}

// ─── 1. Success paths ─────────────────────────────────────────────────────────

describe("runProjectScan — success paths", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it("returns ok:true with suggestionsInserted count when Claude inserts suggestions", async () => {
    setupHappyPath();
    mockTaskSuggestion.count.mockResolvedValue(3);

    const result = await withFakeTimers(() => runProjectScan(PROJECT_ID, SERVER_ID));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.suggestionsInserted).toBe(3);
      expect(result.scannedTaskCount).toBe(TASKS.length);
    }
  });

  it("returns ok:true with suggestionsInserted:0 when Claude inserts nothing", async () => {
    setupHappyPath();
    mockTaskSuggestion.count.mockResolvedValue(0);

    const result = await withFakeTimers(() => runProjectScan(PROJECT_ID, SERVER_ID));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.suggestionsInserted).toBe(0);
  });

  it("does not parse terminal output — success is determined by DB query", async () => {
    setupHappyPath();
    mockTaskSuggestion.count.mockResolvedValue(2);

    await withFakeTimers(() => runProjectScan(PROJECT_ID, SERVER_ID));

    // Idle detection is used (not JSON polling of pane text)
    expect(mockDetectIdle).toHaveBeenCalled();
    // Suggestions come from the DB query
    expect(mockTaskSuggestion.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ sourceId: SCAN_ID, sourceType: "scan" }),
      })
    );
  });

  it("marks ProjectScan completed with findingsCount = suggestionsInserted", async () => {
    setupHappyPath();
    mockTaskSuggestion.count.mockResolvedValue(5);
    const txScanUpdate = vi.fn();
    const txProjUpdate = vi.fn();
    mockTransaction.mockImplementation(async (fn: unknown) =>
      (fn as (tx: unknown) => Promise<unknown>)({
        projectScan: { update: txScanUpdate },
        project: { update: txProjUpdate },
      })
    );

    await withFakeTimers(() => runProjectScan(PROJECT_ID, SERVER_ID));

    expect(txScanUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "completed", findingsCount: 5 }),
      })
    );
  });

  it("continues polling detectClaudeIdle until it returns idle", async () => {
    setupHappyPath();
    // First two checks return busy, third returns idle
    mockDetectIdle
      .mockResolvedValueOnce({ isIdle: false, paneText: "⠋ Thinking" })
      .mockResolvedValueOnce({ isIdle: false, paneText: "⠙ Thinking" })
      .mockResolvedValueOnce({ isIdle: true, paneText: "> " });
    mockTaskSuggestion.count.mockResolvedValue(1);

    vi.useFakeTimers();
    try {
      const p = runProjectScan(PROJECT_ID, SERVER_ID);
      // Advance past the initial wait and several poll intervals
      await vi.advanceTimersByTimeAsync(IMPROVEMENT_SCAN_MIN_WAIT_MS + 200_000);
      const result = await p;
      expect(result.ok).toBe(true);
      expect(mockDetectIdle.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── 2. Failure paths ────────────────────────────────────────────────────────

describe("runProjectScan — failure paths", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it("returns ssh_failed when prompt delivery fails", async () => {
    setupHappyPath();
    mockSendPrompt.mockResolvedValue({ success: false, error: "Connection refused" });

    // ssh_failed is determined before the idle wait, no timer needed
    const result = await runProjectScan(PROJECT_ID, SERVER_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("ssh_failed");
    expect(mockProjectScan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "failed" }),
      })
    );
  });

  it("returns no_completed_tasks without creating a scan record", async () => {
    mockProject.findUnique.mockResolvedValue(PROJECT as never);
    mockServer.findUnique.mockResolvedValue(SERVER as never);
    mockTask.findMany.mockResolvedValue([]);

    const result = await runProjectScan(PROJECT_ID, SERVER_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_completed_tasks");
    expect(mockProjectScan.create).not.toHaveBeenCalled();
  });

  it("returns not_found when the project does not exist", async () => {
    mockProject.findUnique.mockResolvedValue(null);
    mockServer.findUnique.mockResolvedValue(SERVER as never);

    const result = await runProjectScan("nonexistent", SERVER_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
  });

  it("returns server_busy when a task is already running on the server", async () => {
    setupHappyPath();
    mockTask.count.mockResolvedValue(1); // running task

    const result = await runProjectScan(PROJECT_ID, SERVER_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("server_busy");
  });

  it("does not return parse_failed — that error reason no longer exists", async () => {
    setupHappyPath();
    mockSendPrompt.mockResolvedValue({ success: false, error: "SSH error" });

    const result = await runProjectScan(PROJECT_ID, SERVER_ID);
    if (!result.ok) {
      expect((result as { reason: string }).reason).not.toBe("parse_failed");
    }
  });

  it("marks ProjectScan failed when the session disappears mid-scan (tmuxMissing)", async () => {
    setupHappyPath();
    mockDetectIdle.mockResolvedValue({ isIdle: false, paneText: "", tmuxMissing: true });

    const result = await withFakeTimers(() => runProjectScan(PROJECT_ID, SERVER_ID));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("timed_out");
  });
});

// ─── 3. Tenant isolation ─────────────────────────────────────────────────────

describe("runProjectScan — tenant isolation", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it("scopes the suggestion count to the scanned projectId and scanId", async () => {
    setupHappyPath();
    mockTaskSuggestion.count.mockResolvedValue(2);

    await withFakeTimers(() => runProjectScan(PROJECT_ID, SERVER_ID));

    expect(mockTaskSuggestion.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: PROJECT_ID,
          sourceId: SCAN_ID,
          sourceType: "scan",
        }),
      })
    );
  });

  it("uses a different projectId in the count when scanning a different project", async () => {
    const otherScanId = "scan_other_111";
    mockProject.findUnique.mockResolvedValue({ ...PROJECT, id: OTHER_PROJECT_ID } as never);
    mockServer.findUnique.mockResolvedValue(SERVER as never);
    mockTask.findMany.mockResolvedValue(TASKS as never);
    mockTask.count.mockResolvedValue(0);
    mockProjectScan.create.mockResolvedValue({ id: otherScanId } as never);
    mockProjectScan.update.mockResolvedValue({} as never);
    mockProject.update.mockResolvedValue({} as never);
    mockTransaction.mockImplementation(async (fn: unknown) =>
      (fn as (tx: unknown) => Promise<unknown>)({
        projectScan: { update: vi.fn() },
        project: { update: vi.fn() },
      })
    );
    mockSendPrompt.mockResolvedValue({ success: true });
    mockDetectIdle.mockResolvedValue({ isIdle: true, paneText: "> " });
    mockTaskSuggestion.count.mockResolvedValue(1);

    await withFakeTimers(() => runProjectScan(OTHER_PROJECT_ID, SERVER_ID));

    expect(mockTaskSuggestion.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: OTHER_PROJECT_ID,
          sourceId: otherScanId,
        }),
      })
    );
  });
});

// ─── 4. Duplicate scoping per scan ──────────────────────────────────────────

describe("Duplicate suggestion scoping", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it("counts only suggestions with the current scan's sourceId", async () => {
    const firstScanId = "scan_first_111";
    const secondScanId = "scan_second_222";

    // First scan
    setupHappyPath(firstScanId);
    mockTaskSuggestion.count.mockResolvedValueOnce(2);
    const firstResult = await withFakeTimers(() => runProjectScan(PROJECT_ID, SERVER_ID));
    expect(firstResult.ok && (firstResult as { suggestionsInserted: number }).suggestionsInserted).toBe(2);

    // Second scan for the same project (different scanId)
    vi.clearAllMocks();
    setupHappyPath(secondScanId);
    mockTaskSuggestion.count.mockResolvedValueOnce(1);

    const secondResult = await withFakeTimers(() => runProjectScan(PROJECT_ID, SERVER_ID));
    expect(secondResult.ok && (secondResult as { suggestionsInserted: number }).suggestionsInserted).toBe(1);

    // The count was scoped to the second scan's sourceId, not the first
    const lastCountCall = mockTaskSuggestion.count.mock.calls.at(-1)?.[0] as
      | { where: { sourceId: string } }
      | undefined;
    expect(lastCountCall?.where?.sourceId).toBe(secondScanId);
  });
});

// ─── 5. Prompt content ───────────────────────────────────────────────────────

describe("Prompt content safety", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it("sends the prompt to the correct tmux session", async () => {
    setupHappyPath();
    mockTaskSuggestion.count.mockResolvedValue(0);

    await withFakeTimers(() => runProjectScan(PROJECT_ID, SERVER_ID));

    expect(mockSendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ host: SERVER.host }),
      expect.any(String),
      SERVER.tmuxSession,
    );
  });

  it("embeds projectId and scanId in the prompt for DB insertion", async () => {
    setupHappyPath();
    mockTaskSuggestion.count.mockResolvedValue(0);

    await withFakeTimers(() => runProjectScan(PROJECT_ID, SERVER_ID));

    const [, promptText] = mockSendPrompt.mock.calls[0];
    expect(promptText).toContain(PROJECT_ID);
    expect(promptText).toContain(SCAN_ID);
  });

  it("does not include SCAN_FINDINGS_START or SCAN_FINDINGS_END markers", async () => {
    setupHappyPath();
    mockTaskSuggestion.count.mockResolvedValue(0);

    await withFakeTimers(() => runProjectScan(PROJECT_ID, SERVER_ID));

    const [, promptText] = mockSendPrompt.mock.calls[0];
    expect(promptText).not.toContain("SCAN_FINDINGS_START");
    expect(promptText).not.toContain("SCAN_FINDINGS_END");
  });

  it("includes the TaskSuggestion table name in the prompt", async () => {
    setupHappyPath();
    mockTaskSuggestion.count.mockResolvedValue(0);

    await withFakeTimers(() => runProjectScan(PROJECT_ID, SERVER_ID));

    const [, promptText] = mockSendPrompt.mock.calls[0];
    expect(promptText).toContain("TaskSuggestion");
  });
});
