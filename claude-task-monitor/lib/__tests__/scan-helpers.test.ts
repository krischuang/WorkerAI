/**
 * Tests for lib/scan-helpers.ts
 *
 * Covers:
 *   1. extractJson — all three extraction strategies
 *   2. pollForFindings — success, timeout, parse failure, SSH error resilience
 *   3. Consecutive failure pause logic (simulated state machine)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractJson, pollForFindings, isTemplatePlaceholder } from "../scan-helpers";

// ─── 1. extractJson ────────────────────────────────────────────────────────────

const START = "SCAN_FINDINGS_START";
const END   = "SCAN_FINDINGS_END";

const VALID_JSON = `{"findings":[{"type":"gap","title":"Missing tests","severity":"high","description":"No unit tests","suggestedAction":"Add tests"}]}`;

describe("extractJson — strategy 1: markers", () => {
  it("extracts JSON between start and end markers", () => {
    const pane = `${START}\n${VALID_JSON}\n${END}`;
    const result = extractJson(pane, START, END);
    expect(result).not.toBeNull();
    expect(result?.source).toBe("markers");
    expect(result?.raw).toBe(VALID_JSON);
  });

  it("skips prompt instruction text (uses lastIndexOf for start marker)", () => {
    // The prompt includes both markers as literal text in the instruction sentence
    const pane = [
      `Begin your response with ${START} and end with ${END}.`,
      "",
      `${START}`,
      VALID_JSON,
      `${END}`,
    ].join("\n");
    const result = extractJson(pane, START, END);
    expect(result?.source).toBe("markers");
    expect(result?.raw).toBe(VALID_JSON);
  });

  it("returns null when extracted text does not start with {", () => {
    // Only the instruction text is present — no real response yet
    const pane = `Begin your response with ${START} and end with ${END}.`;
    // The indexOf of END comes AFTER indexOf of START here for the instruction sentence
    // lastIndexOf(START) finds the same one, raw = " and end with " which is not "{"
    const result = extractJson(pane, START, END);
    // No valid marker-bounded JSON, no fence, no raw object → null
    expect(result).toBeNull();
  });

  it("handles multiline JSON between markers", () => {
    const multiline = `{\n  "findings": []\n}`;
    const pane = `${START}\n${multiline}\n${END}`;
    const result = extractJson(pane, START, END);
    expect(result?.source).toBe("markers");
    expect(result?.raw).toBe(multiline);
  });
});

describe("extractJson — strategy 2: ```json fence", () => {
  it("extracts JSON from a markdown code fence when no markers present", () => {
    const pane = "Here are my findings:\n```json\n" + VALID_JSON + "\n```\n";
    const result = extractJson(pane, START, END);
    expect(result?.source).toBe("json-fence");
    expect(result?.raw).toBe(VALID_JSON);
  });

  it("falls back to fence when markers present but content does not start with {", () => {
    const pane = [
      `Begin your response with ${START} and end with ${END}.`,
      "```json",
      VALID_JSON,
      "```",
    ].join("\n");
    const result = extractJson(pane, START, END);
    expect(result?.source).toBe("json-fence");
  });
});

describe("extractJson — strategy 3: raw balanced JSON object", () => {
  it("extracts first balanced JSON object when no markers or fences", () => {
    const pane = "The analysis is complete. " + VALID_JSON + " Hope that helps.";
    const result = extractJson(pane, START, END);
    expect(result?.source).toBe("raw-json");
    expect(result?.raw).toBe(VALID_JSON);
  });

  it("handles nested objects correctly", () => {
    const nested = `{"findings":[{"type":"gap","meta":{"a":1}}]}`;
    const pane = "Result: " + nested;
    const result = extractJson(pane, START, END);
    expect(result?.source).toBe("raw-json");
    expect(result?.raw).toBe(nested);
  });

  it("returns null for truncated (unbalanced) JSON", () => {
    const pane = `{"findings":[{"type":"gap"`;
    const result = extractJson(pane, START, END);
    expect(result).toBeNull();
  });

  it("returns null when pane contains no JSON at all", () => {
    const result = extractJson("Processing request…", START, END);
    expect(result).toBeNull();
  });
});

describe("extractJson — strategy priority order", () => {
  it("prefers markers over fence when both present", () => {
    const pane = [
      "```json",
      `{"findings":[{"type":"suggestion","title":"From fence","severity":"low","description":"","suggestedAction":""}]}`,
      "```",
      START,
      VALID_JSON,
      END,
    ].join("\n");
    const result = extractJson(pane, START, END);
    expect(result?.source).toBe("markers");
    expect(result?.raw).toBe(VALID_JSON);
  });

  it("prefers fence over raw JSON when both present but no markers", () => {
    const fenceJson = `{"findings":[]}`;
    const rawJson = `{"findings":[{"type":"gap","title":"raw","severity":"low","description":"","suggestedAction":""}]}`;
    const pane = "Extra text. " + rawJson + "\n```json\n" + fenceJson + "\n```";
    const result = extractJson(pane, START, END);
    expect(result?.source).toBe("json-fence");
    expect(result?.raw).toBe(fenceJson);
  });
});

// ─── 2. pollForFindings ────────────────────────────────────────────────────────

vi.mock("@/lib/ssh", () => ({
  execSSH: vi.fn(),
}));

import { execSSH } from "@/lib/ssh";
const mockExecSSH = vi.mocked(execSSH);

const SSH_CONFIG = { host: "h", port: 22, username: "u", sshKeyPath: "/k" };
const TMUX = "claude-agent-1";

const POLL_OPTS = {
  ssh: SSH_CONFIG,
  tmuxSession: TMUX,
  timeoutMs: 100,   // Very short for tests — 2 intervals of 50ms
  intervalMs: 50,
  startMarker: START,
  endMarker: END,
  resultKey: "findings",
};

describe("pollForFindings — success paths", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns findings on first poll when markers present", async () => {
    const pane = `${START}\n${VALID_JSON}\n${END}`;
    mockExecSSH.mockResolvedValue({ stdout: pane, stderr: "", exitCode: 0 });

    const { result, raw } = await pollForFindings<unknown>({ ...POLL_OPTS, timeoutMs: 500 });
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
    expect(raw).toBe(VALID_JSON);
  });

  it("returns findings when JSON is in a markdown fence", async () => {
    const pane = "```json\n" + VALID_JSON + "\n```";
    mockExecSSH.mockResolvedValue({ stdout: pane, stderr: "", exitCode: 0 });

    const { result } = await pollForFindings<unknown>({ ...POLL_OPTS, timeoutMs: 500 });
    expect(result).not.toBeNull();
  });

  it("returns findings when JSON is raw in the pane text", async () => {
    const pane = "Here: " + VALID_JSON;
    mockExecSSH.mockResolvedValue({ stdout: pane, stderr: "", exitCode: 0 });

    const { result } = await pollForFindings<unknown>({ ...POLL_OPTS, timeoutMs: 500 });
    expect(result).not.toBeNull();
  });

  it("keeps polling and succeeds on a later tick", async () => {
    // First call returns no JSON, second returns valid JSON
    mockExecSSH
      .mockResolvedValueOnce({ stdout: "Working…", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: `${START}\n${VALID_JSON}\n${END}`, stderr: "", exitCode: 0 });

    const { result } = await pollForFindings<unknown>({ ...POLL_OPTS, timeoutMs: 500 });
    expect(result).not.toBeNull();
    expect(mockExecSSH).toHaveBeenCalledTimes(2);
  });
});

describe("pollForFindings — failure paths", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns { result: null, raw: null } on timeout with no JSON found", async () => {
    mockExecSSH.mockResolvedValue({ stdout: "Still thinking…", stderr: "", exitCode: 0 });

    const { result, raw } = await pollForFindings<unknown>(POLL_OPTS);
    expect(result).toBeNull();
    expect(raw).toBeNull();
  });

  it("returns { result: null, raw: string } when JSON was found but not parseable", async () => {
    const pane = `${START}\n{"findings": [INVALID}\n${END}`;
    mockExecSSH.mockResolvedValue({ stdout: pane, stderr: "", exitCode: 0 });

    const { result, raw } = await pollForFindings<unknown>(POLL_OPTS);
    expect(result).toBeNull();
    expect(typeof raw).toBe("string");
  });

  it("survives SSH errors and keeps polling", async () => {
    // First two calls throw, third succeeds
    mockExecSSH
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce({ stdout: `${START}\n${VALID_JSON}\n${END}`, stderr: "", exitCode: 0 });

    const { result } = await pollForFindings<unknown>({ ...POLL_OPTS, timeoutMs: 500 });
    expect(result).not.toBeNull();
  });

  it("does not use findings when resultKey is missing from parsed JSON", async () => {
    // JSON is valid but has wrong key — should keep polling until timeout
    const badKey = `{"items":[{"type":"gap"}]}`;
    mockExecSSH.mockResolvedValue({ stdout: `${START}\n${badKey}\n${END}`, stderr: "", exitCode: 0 });

    const { result, raw } = await pollForFindings<unknown>(POLL_OPTS);
    expect(result).toBeNull();
    // raw should capture the last extracted fragment
    expect(raw).toBe(badKey);
  });
});

// ─── 3. Consecutive failure pause — simulated state machine ───────────────────

import { SCAN_MAX_CONSECUTIVE_FAILURES } from "../constants";

type ProjectState = {
  scanFailureCount: number;
  autoImprovementPaused: boolean;
};

function simulateScanResult(
  state: ProjectState,
  outcome: "success" | "failure",
): ProjectState {
  if (outcome === "success") {
    return { ...state, scanFailureCount: 0, autoImprovementPaused: false };
  }
  const next = state.scanFailureCount + 1;
  return {
    scanFailureCount: next,
    autoImprovementPaused: next >= SCAN_MAX_CONSECUTIVE_FAILURES,
  };
}

describe("consecutive failure pause logic", () => {
  it("does not pause before reaching the threshold", () => {
    let state: ProjectState = { scanFailureCount: 0, autoImprovementPaused: false };
    for (let i = 0; i < SCAN_MAX_CONSECUTIVE_FAILURES - 1; i++) {
      state = simulateScanResult(state, "failure");
    }
    expect(state.autoImprovementPaused).toBe(false);
    expect(state.scanFailureCount).toBe(SCAN_MAX_CONSECUTIVE_FAILURES - 1);
  });

  it("pauses at exactly the failure threshold", () => {
    let state: ProjectState = { scanFailureCount: 0, autoImprovementPaused: false };
    for (let i = 0; i < SCAN_MAX_CONSECUTIVE_FAILURES; i++) {
      state = simulateScanResult(state, "failure");
    }
    expect(state.autoImprovementPaused).toBe(true);
    expect(state.scanFailureCount).toBe(SCAN_MAX_CONSECUTIVE_FAILURES);
  });

  it("resets failure count and unpauses on success", () => {
    let state: ProjectState = { scanFailureCount: SCAN_MAX_CONSECUTIVE_FAILURES, autoImprovementPaused: true };
    state = simulateScanResult(state, "success");
    expect(state.scanFailureCount).toBe(0);
    expect(state.autoImprovementPaused).toBe(false);
  });

  it("single success after failures resets the count", () => {
    let state: ProjectState = { scanFailureCount: 0, autoImprovementPaused: false };
    state = simulateScanResult(state, "failure");
    state = simulateScanResult(state, "failure");
    expect(state.scanFailureCount).toBe(2);

    state = simulateScanResult(state, "success");
    expect(state.scanFailureCount).toBe(0);
    expect(state.autoImprovementPaused).toBe(false);

    // Failures restart from 0
    state = simulateScanResult(state, "failure");
    expect(state.scanFailureCount).toBe(1);
    expect(state.autoImprovementPaused).toBe(false);
  });

  it("SCAN_MAX_CONSECUTIVE_FAILURES constant is 3", () => {
    expect(SCAN_MAX_CONSECUTIVE_FAILURES).toBe(3);
  });
});

// ─── 4. isTemplatePlaceholder ─────────────────────────────────────────────────

describe("isTemplatePlaceholder", () => {
  // Values that ARE template placeholders (should return true)
  it('returns true for the literal "..."', () => {
    expect(isTemplatePlaceholder("...")).toBe(true);
  });

  it("returns true for angle-bracket placeholders", () => {
    expect(isTemplatePlaceholder("<specific finding title>")).toBe(true);
    expect(isTemplatePlaceholder("<detailed description>")).toBe(true);
    expect(isTemplatePlaceholder("<concrete action>")).toBe(true);
  });

  it("returns true for pipe-separated enum strings (old prompt format)", () => {
    expect(isTemplatePlaceholder("gap|architecture|coverage|suggestion")).toBe(true);
    expect(isTemplatePlaceholder("low|medium|high|critical")).toBe(true);
  });

  it("returns true for empty string", () => {
    expect(isTemplatePlaceholder("")).toBe(true);
  });

  it("returns true for whitespace-only string", () => {
    expect(isTemplatePlaceholder("   ")).toBe(true);
  });

  // Values that are NOT placeholders (real content)
  it("returns false for a real finding title", () => {
    expect(isTemplatePlaceholder("Missing authentication middleware")).toBe(false);
  });

  it("returns false for a real description", () => {
    expect(isTemplatePlaceholder("API routes do not enforce authentication on protected endpoints.")).toBe(false);
  });

  it("returns false for a valid single enum value", () => {
    expect(isTemplatePlaceholder("gap")).toBe(false);
    expect(isTemplatePlaceholder("high")).toBe(false);
    expect(isTemplatePlaceholder("architecture")).toBe(false);
  });

  it("returns false for a short but real title (3+ chars)", () => {
    expect(isTemplatePlaceholder("N+1")).toBe(false);
  });
});
