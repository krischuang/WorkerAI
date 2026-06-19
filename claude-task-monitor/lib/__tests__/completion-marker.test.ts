/**
 * Tests for the nonce-based task completion protocol:
 *   1. detectCompletionBlock — pure function
 *   2. buildDispatchPrompt — prompt contains block template but NOT a valid block
 *   3. detectTaskCompletion — offset-based scanning + nonce validation
 *   4. Queue progression simulation — completion, multi-task queues, agent release
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { COMPLETION_BLOCK_START, COMPLETION_BLOCK_END, COMPLETION_SCAN_LINES } from "../constants";

// ─── 1. detectCompletionBlock — pure function ─────────────────────────────────

import { detectCompletionBlock } from "../usage-parser";

const TASK_ID = "task-abc123";
const NONCE = "deadbeef-0000-1111-2222-333333333333";

function makeBlock(taskId = TASK_ID, status = "completed", nonce = NONCE): string {
  return `${COMPLETION_BLOCK_START}\ntaskId: ${taskId}\nstatus: ${status}\nnonce: ${nonce}\n${COMPLETION_BLOCK_END}`;
}

describe("detectCompletionBlock", () => {
  it("returns true for a valid block matching taskId and nonce", () => {
    expect(detectCompletionBlock(makeBlock(), TASK_ID, NONCE)).toBe(true);
  });

  it("returns true when the block is buried in other output", () => {
    const pane = `Some task output\nMore lines\n${makeBlock()}\n> `;
    expect(detectCompletionBlock(pane, TASK_ID, NONCE)).toBe(true);
  });

  it("returns false when nonce does not match", () => {
    const block = makeBlock(TASK_ID, "completed", "wrong-nonce");
    expect(detectCompletionBlock(block, TASK_ID, NONCE)).toBe(false);
  });

  it("returns false when taskId does not match", () => {
    const block = makeBlock("wrong-task-id", "completed", NONCE);
    expect(detectCompletionBlock(block, TASK_ID, NONCE)).toBe(false);
  });

  it("returns false when status is not 'completed'", () => {
    const block = makeBlock(TASK_ID, "failed", NONCE);
    expect(detectCompletionBlock(block, TASK_ID, NONCE)).toBe(false);
  });

  it("returns false when the block is absent", () => {
    expect(detectCompletionBlock("Some output\nAll done\n> ", TASK_ID, NONCE)).toBe(false);
  });

  it("returns false for empty pane text", () => {
    expect(detectCompletionBlock("", TASK_ID, NONCE)).toBe(false);
  });

  it("returns false when expectedNonce is empty string", () => {
    expect(detectCompletionBlock(makeBlock(), TASK_ID, "")).toBe(false);
  });

  it("returns false when expectedTaskId is empty string", () => {
    expect(detectCompletionBlock(makeBlock(), "", NONCE)).toBe(false);
  });

  it("finds the block anywhere in a large pane", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    lines.push(makeBlock());
    lines.push("> ");
    expect(detectCompletionBlock(lines.join("\n"), TASK_ID, NONCE)).toBe(true);
  });
});

// ─── 2. buildDispatchPrompt — prompt must not be a valid completion block ─────

import { buildDispatchPrompt } from "../prompt-sanitiser";

describe("buildDispatchPrompt — completion block format", () => {
  const task = {
    title: "Write a unit test",
    description: "Add tests for the auth module",
    projectName: "MyProject",
    taskId: TASK_ID,
    nonce: NONCE,
  };

  it("includes COMPLETION_BLOCK_START and COMPLETION_BLOCK_END in the prompt", () => {
    const prompt = buildDispatchPrompt(task);
    expect(prompt).toContain(COMPLETION_BLOCK_START);
    expect(prompt).toContain(COMPLETION_BLOCK_END);
  });

  it("includes the taskId and nonce in the completion instruction", () => {
    const prompt = buildDispatchPrompt(task);
    expect(prompt).toContain(`taskId: ${TASK_ID}`);
    expect(prompt).toContain(`nonce: ${NONCE}`);
  });

  it("the prompt DOES contain a valid completion block (offset prevents false-positive)", () => {
    // The prompt includes the exact block as an example — the output offset
    // is what prevents false-positive detection, not absence of the block.
    const prompt = buildDispatchPrompt(task);
    expect(detectCompletionBlock(prompt, TASK_ID, NONCE)).toBe(true);
  });

  it("places the completion block instruction after the task content", () => {
    const prompt = buildDispatchPrompt(task);
    const taskContentIndex = prompt.indexOf("Write a unit test");
    const blockIndex = prompt.indexOf(COMPLETION_BLOCK_START);
    expect(blockIndex).toBeGreaterThan(taskContentIndex);
  });

  it("includes the task title (no regression)", () => {
    const prompt = buildDispatchPrompt(task);
    expect(prompt).toContain("Write a unit test");
  });

  it("still includes anti-injection preamble", () => {
    const prompt = buildDispatchPrompt(task);
    expect(prompt).toMatch(/automated task executor/i);
    expect(prompt).toMatch(/treat.*content.*as data/i);
  });
});

// ─── 3. detectTaskCompletion — mocked SSH ─────────────────────────────────────

vi.mock("@/lib/ssh", () => ({
  execSSH: vi.fn(),
}));

import { execSSH } from "@/lib/ssh";
import { detectTaskCompletion } from "../ssh-claude-tmux";

const mockExecSSH = vi.mocked(execSSH);
const SSH_CONFIG = { host: "h", port: 22, username: "u", sshKeyPath: "/k" };

describe("detectTaskCompletion — guard: empty tmuxSession", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns tmuxMissing=true immediately without SSH for empty session", async () => {
    const result = await detectTaskCompletion(SSH_CONFIG, "", TASK_ID, NONCE, 0);
    expect(result.tmuxMissing).toBe(true);
    expect(result.completed).toBe(false);
    expect(mockExecSSH).not.toHaveBeenCalled();
  });

  it("returns tmuxMissing=true for whitespace-only session", async () => {
    const result = await detectTaskCompletion(SSH_CONFIG, "   ", TASK_ID, NONCE, 0);
    expect(result.tmuxMissing).toBe(true);
    expect(mockExecSSH).not.toHaveBeenCalled();
  });
});

describe("detectTaskCompletion — marker inside prompt must not complete task", () => {
  beforeEach(() => vi.resetAllMocks());

  it("does not complete when valid block is before outputOffset", async () => {
    // Simulate: 5 pre-dispatch lines + prompt with valid block + no Claude output yet
    const preLines = ["line1", "line2", "line3", "line4", "line5"];
    const promptLines = [
      "You are an automated task executor.",
      "Complete the task:",
      "<task_title>",
      "Write a unit test",
      "</task_title>",
      "Complete this task now.",
      "",
      "When done output:",
      COMPLETION_BLOCK_START,
      `taskId: ${TASK_ID}`,
      "status: completed",
      `nonce: ${NONCE}`,
      COMPLETION_BLOCK_END,
    ];
    const pane = [...preLines, ...promptLines].join("\n");
    // outputOffset = 5 pre + 13 prompt + 40 buffer = 58, pane has only 18 lines
    const outputOffset = 58;

    mockExecSSH.mockResolvedValueOnce({ stdout: pane, stderr: "", exitCode: 0 });

    const result = await detectTaskCompletion(SSH_CONFIG, "claude", TASK_ID, NONCE, outputOffset);
    expect(result.markerFound).toBe(false);
    expect(result.completed).toBe(false);
  });

  it("completes when valid block appears after outputOffset", async () => {
    // 20 pre+prompt lines, then Claude's output with the block
    const preAndPromptLines = Array.from({ length: 20 }, (_, i) => `old line ${i}`);
    const claudeOutput = [
      "I have completed the task.",
      "Here is the result:",
      makeBlock(TASK_ID, "completed", NONCE),
    ];
    const pane = [...preAndPromptLines, ...claudeOutput].join("\n");
    const outputOffset = 20; // skip the 20 pre+prompt lines

    mockExecSSH
      .mockResolvedValueOnce({ stdout: pane, stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }); // Escape

    const result = await detectTaskCompletion(SSH_CONFIG, "claude", TASK_ID, NONCE, outputOffset);
    expect(result.markerFound).toBe(true);
    expect(result.completed).toBe(true);
  });
});

describe("detectTaskCompletion — wrong nonce must not complete task", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns markerFound=false when nonce does not match", async () => {
    const pane = `Some output\n${makeBlock(TASK_ID, "completed", "wrong-nonce")}\n> `;
    mockExecSSH.mockResolvedValueOnce({ stdout: pane, stderr: "", exitCode: 0 });

    const result = await detectTaskCompletion(SSH_CONFIG, "claude", TASK_ID, NONCE, 0);
    expect(result.markerFound).toBe(false);
    expect(result.completed).toBe(false);
  });
});

describe("detectTaskCompletion — wrong taskId must not complete task", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns markerFound=false when taskId does not match", async () => {
    const pane = `Some output\n${makeBlock("wrong-task-id", "completed", NONCE)}\n> `;
    mockExecSSH.mockResolvedValueOnce({ stdout: pane, stderr: "", exitCode: 0 });

    const result = await detectTaskCompletion(SSH_CONFIG, "claude", TASK_ID, NONCE, 0);
    expect(result.markerFound).toBe(false);
    expect(result.completed).toBe(false);
  });
});

describe("detectTaskCompletion — valid completion block completes task", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns markerFound=true and completed=true for valid block with no offset", async () => {
    const pane = `Task output...\n${makeBlock()}\n> `;
    mockExecSSH
      .mockResolvedValueOnce({ stdout: pane, stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }); // Escape

    const result = await detectTaskCompletion(SSH_CONFIG, "claude", TASK_ID, NONCE);
    expect(result.markerFound).toBe(true);
    expect(result.completed).toBe(true);
  });

  it("sends Escape to dismiss dialogs when marker is found", async () => {
    const pane = `${makeBlock()}\n> `;
    mockExecSSH
      .mockResolvedValueOnce({ stdout: pane, stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

    await detectTaskCompletion(SSH_CONFIG, "claude", TASK_ID, NONCE);

    expect(mockExecSSH).toHaveBeenCalledTimes(2);
    const dismissCall = mockExecSSH.mock.calls[1][1] as string;
    expect(dismissCall).toContain("Escape");
  });

  it("does NOT send Escape when marker is absent", async () => {
    const pane = `Working on task...\n> `;
    mockExecSSH.mockResolvedValueOnce({ stdout: pane, stderr: "", exitCode: 0 });

    await detectTaskCompletion(SSH_CONFIG, "claude", TASK_ID, NONCE);
    expect(mockExecSSH).toHaveBeenCalledTimes(1);
  });

  it("uses scrollback depth proportional to outputOffset", async () => {
    // pane has 6 lines; offset=100 > pane length, so scanText="" → no block found → no Escape
    const pane = `${makeBlock()}\n> `;
    mockExecSSH.mockResolvedValueOnce({ stdout: pane, stderr: "", exitCode: 0 });

    await detectTaskCompletion(SSH_CONFIG, "claude", TASK_ID, NONCE, 100);

    expect(mockExecSSH).toHaveBeenCalledTimes(1);
    const captureCmd = mockExecSSH.mock.calls[0][1] as string;
    // captureDepth = min(outputOffset + 500, 10_000) = min(100 + 500, 10_000) = 600
    // The 500-line window (up from 200) handles longer AI responses that push the
    // completion block further down the pane without missing it.
    expect(captureCmd).toContain("-S -600");
  });

  it("falls back to COMPLETION_SCAN_LINES depth when no offset provided", async () => {
    const pane = `${makeBlock()}\n> `;
    mockExecSSH
      .mockResolvedValueOnce({ stdout: pane, stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

    await detectTaskCompletion(SSH_CONFIG, "claude", TASK_ID, NONCE);

    const captureCmd = mockExecSSH.mock.calls[0][1] as string;
    expect(captureCmd).toContain(`-S -${COMPLETION_SCAN_LINES}`);
  });
});

describe("detectTaskCompletion — tmux session missing", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns tmuxMissing=true when capture-pane exits non-zero with session error", async () => {
    mockExecSSH.mockResolvedValueOnce({
      stdout: "",
      stderr: "can't find session: claude",
      exitCode: 1,
    });

    const result = await detectTaskCompletion(SSH_CONFIG, "claude", TASK_ID, NONCE);
    expect(result.tmuxMissing).toBe(true);
    expect(result.completed).toBe(false);
  });
});

describe("detectTaskCompletion — idle fallback for tasks without nonce", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns completed=true via idle when no nonce and prompt is visible", async () => {
    const pane = `Task finished\n> \n Claude Sonnet | Auto`;
    mockExecSSH.mockResolvedValueOnce({ stdout: pane, stderr: "", exitCode: 0 });

    const result = await detectTaskCompletion(SSH_CONFIG, "claude");
    expect(result.markerFound).toBe(false);
    expect(result.isIdle).toBe(true);
    expect(result.completed).toBe(true);
  });

  it("does NOT use idle fallback when nonce is provided (nonce tasks require block)", async () => {
    // Pane shows idle prompt but no completion block
    const pane = `Task output\n> \n Claude Sonnet | Auto`;
    mockExecSSH.mockResolvedValueOnce({ stdout: pane, stderr: "", exitCode: 0 });

    const result = await detectTaskCompletion(SSH_CONFIG, "claude", TASK_ID, NONCE);
    expect(result.markerFound).toBe(false);
    expect(result.isIdle).toBe(true);
    expect(result.completed).toBe(false); // idle alone is not enough when nonce is set
  });
});

// ─── 4. Queue progression — completion releases agent + dispatches next task ──

type TaskStatus = "pending" | "queued" | "running" | "completed";
type Priority = "P1" | "P2" | "P3" | "P4";

interface SimTask {
  id: string;
  title: string;
  priority: Priority;
  status: TaskStatus;
  agentId: string;
  nonce?: string;
}

interface SimAgent {
  id: string;
  status: "idle" | "running" | "offline";
}

function simulateCompletionCycle(
  tasks: SimTask[],
  agents: SimAgent[],
  agentId: string,
  completionDetected: boolean,
): { completed: string[]; dispatched: string | null; agentStatus: string } {
  const agent = agents.find(a => a.id === agentId);
  if (!agent) return { completed: [], dispatched: null, agentStatus: "unknown" };

  if (!completionDetected) return { completed: [], dispatched: null, agentStatus: agent.status };

  const running = tasks.filter(t => t.agentId === agentId && t.status === "running");
  const completed: string[] = [];

  for (const t of running) {
    t.status = "completed";
    completed.push(t.id);
  }

  // Release agent
  agent.status = "idle";

  const next = tasks
    .filter(t => t.agentId === agentId && t.status === "queued")
    .sort((a, b) => a.priority.localeCompare(b.priority) || a.id.localeCompare(b.id))[0];

  if (!next) return { completed, dispatched: null, agentStatus: agent.status };

  next.status = "running";
  agent.status = "running";
  return { completed, dispatched: next.id, agentStatus: agent.status };
}

describe("queue progression — completion releases agent and dispatches next task", () => {
  it("marks task completed and sets agent idle on valid completion", () => {
    const tasks: SimTask[] = [
      { id: "t1", title: "Task 1", priority: "P2", status: "running", agentId: "a1", nonce: NONCE },
    ];
    const agents: SimAgent[] = [{ id: "a1", status: "running" }];

    const { completed, agentStatus } = simulateCompletionCycle(tasks, agents, "a1", true);
    expect(completed).toContain("t1");
    expect(agentStatus).toBe("idle");
    expect(tasks[0].status).toBe("completed");
  });

  it("dispatches next queued task after completion", () => {
    const tasks: SimTask[] = [
      { id: "t1", title: "Running",  priority: "P2", status: "running", agentId: "a1", nonce: NONCE },
      { id: "t2", title: "Low prio", priority: "P3", status: "queued",  agentId: "a1" },
      { id: "t3", title: "Hi prio",  priority: "P1", status: "queued",  agentId: "a1" },
    ];
    const agents: SimAgent[] = [{ id: "a1", status: "running" }];

    const { dispatched } = simulateCompletionCycle(tasks, agents, "a1", true);
    expect(dispatched).toBe("t3"); // P1 before P3
    expect(tasks.find(t => t.id === "t3")?.status).toBe("running");
    expect(tasks.find(t => t.id === "t2")?.status).toBe("queued");
  });

  it("does not complete or dispatch when completion not detected", () => {
    const tasks: SimTask[] = [
      { id: "t1", title: "Task 1", priority: "P2", status: "running", agentId: "a1", nonce: NONCE },
      { id: "t2", title: "Next",   priority: "P1", status: "queued",  agentId: "a1" },
    ];
    const agents: SimAgent[] = [{ id: "a1", status: "running" }];

    const { completed, dispatched } = simulateCompletionCycle(tasks, agents, "a1", false);
    expect(completed).toHaveLength(0);
    expect(dispatched).toBeNull();
    expect(tasks[0].status).toBe("running");
  });

  it("dispatches sequentially across multiple completion cycles", () => {
    const tasks: SimTask[] = [
      { id: "t1", priority: "P1", title: "First",  status: "running", agentId: "a1", nonce: NONCE },
      { id: "t2", priority: "P2", title: "Second", status: "queued",  agentId: "a1" },
      { id: "t3", priority: "P3", title: "Third",  status: "queued",  agentId: "a1" },
    ];
    const agents: SimAgent[] = [{ id: "a1", status: "running" }];

    const c1 = simulateCompletionCycle(tasks, agents, "a1", true);
    expect(c1.completed).toEqual(["t1"]);
    expect(c1.dispatched).toBe("t2");

    const c2 = simulateCompletionCycle(tasks, agents, "a1", true);
    expect(c2.completed).toEqual(["t2"]);
    expect(c2.dispatched).toBe("t3");

    const c3 = simulateCompletionCycle(tasks, agents, "a1", true);
    expect(c3.completed).toEqual(["t3"]);
    expect(c3.dispatched).toBeNull();

    expect(tasks.every(t => t.status === "completed")).toBe(true);
  });
});

describe("queue progression — completion detection end-to-end with valid block", () => {
  beforeEach(() => vi.resetAllMocks());

  it("triggers next-task dispatch when valid completion block is found after offset", async () => {
    const preLines = Array.from({ length: 20 }, (_, i) => `old ${i}`);
    const claudeOutput = [
      "I completed the task.",
      makeBlock(TASK_ID, "completed", NONCE),
    ];
    const pane = [...preLines, ...claudeOutput].join("\n");

    mockExecSSH
      .mockResolvedValueOnce({ stdout: pane, stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

    const result = await detectTaskCompletion(SSH_CONFIG, "worker-1", TASK_ID, NONCE, 20);
    expect(result.markerFound).toBe(true);
    expect(result.completed).toBe(true);

    // Verify queue simulation advances correctly
    const tasks: SimTask[] = [
      { id: TASK_ID, title: "Current", priority: "P1", status: "running", agentId: "a1", nonce: NONCE },
      { id: "t2",    title: "Next",    priority: "P2", status: "queued",  agentId: "a1" },
    ];
    const agents: SimAgent[] = [{ id: "a1", status: "running" }];

    const { dispatched } = simulateCompletionCycle(tasks, agents, "a1", result.completed);
    expect(dispatched).toBe("t2");
  });

  it("does not dispatch when wrong nonce in block", async () => {
    const pane = `Some output\n${makeBlock(TASK_ID, "completed", "wrong-nonce")}\n> `;
    mockExecSSH.mockResolvedValueOnce({ stdout: pane, stderr: "", exitCode: 0 });

    const result = await detectTaskCompletion(SSH_CONFIG, "worker-1", TASK_ID, NONCE, 0);
    expect(result.completed).toBe(false);

    const tasks: SimTask[] = [
      { id: TASK_ID, title: "Current", priority: "P1", status: "running", agentId: "a1", nonce: NONCE },
      { id: "t2",    title: "Next",    priority: "P2", status: "queued",  agentId: "a1" },
    ];
    const agents: SimAgent[] = [{ id: "a1", status: "running" }];

    const { dispatched } = simulateCompletionCycle(tasks, agents, "a1", result.completed);
    expect(dispatched).toBeNull();
    expect(tasks[0].status).toBe("running");
  });
});
