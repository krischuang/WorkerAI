/**
 * Fetches Claude CLI usage statistics from a remote server.
 *
 * Strategy (tried in order):
 *
 * 1. Exec (no PTY) — pipe "/usage\n/exit\n" to Claude with TERM=dumb so the
 *    TUI is suppressed and output is clean plain text.
 *
 * 2. PTY fallback — start a PTY shell, launch `claude`, wait for the REPL
 *    prompt, send /usage, capture the box output.  Used when Claude refuses
 *    to run without a TTY.
 *
 * All code paths resolve within the caller's timeout.
 */

import { Client } from "ssh2";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSSH } from "@/lib/ssh";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ClaudeUsageParsed {
  session?: string;
  daily?: string;
  weekly?: string;
  monthly?: string;
  resetDaily?: string;
  resetWeekly?: string;
  resetMonthly?: string;
}

export interface ClaudeUsageResult {
  success: boolean;
  rawOutput: string;
  parsed: ClaudeUsageParsed;
  error?: string;
  /** Claude is installed but `claude login` has not been run */
  notAuthenticated?: boolean;
  /** `claude` binary is not present on the remote PATH */
  claudeNotFound?: boolean;
}

export interface SSHConfig {
  host: string;
  port: number;
  username: string;
  sshKeyPath: string;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Remove all ANSI/VT100 escape sequences from a string */
function stripAnsi(s: string): string {
  return s.replace(
    /[\x1B\x9B](?:[@-Z\\-_]|\[[0-9;]*[A-Za-z]|\][^\x07\x1B]*(?:\x07|\x1B\\))/g,
    ""
  );
}

function resolveKeyPath(keyPath: string): string {
  return keyPath.startsWith("~/")
    ? path.join(os.homedir(), keyPath.slice(2))
    : keyPath;
}

/**
 * Iterate through all ╭…╰ boxes in `text` and return the first one that
 * contains a dollar sign (usage cost data).  Falls back to the last box, then
 * to the raw text.
 */
function findUsageBox(text: string): string {
  let best = "";
  let searchFrom = 0;
  while (true) {
    const start = text.indexOf("╭", searchFrom);
    if (start === -1) break;
    const end = text.indexOf("╰", start);
    if (end === -1) {
      const candidate = text.slice(start);
      if (candidate.includes("$")) return candidate;
      best = candidate;
      break;
    }
    const lineEnd = text.indexOf("\n", end);
    const box = lineEnd !== -1 ? text.slice(start, lineEnd + 1) : text.slice(start);
    if (box.includes("$")) return box;
    best = box;
    searchFrom = end + 1;
  }
  return best;
}

/**
 * Return true if the stripped text looks like real usage data.
 * Accepts both dollar-amount format and token-count format.
 */
function looksLikeUsage(text: string): boolean {
  if (text.includes("$")) return true;
  const lower = text.toLowerCase();
  if (/\d[\d,]*\s*tokens?/i.test(text)) return true;
  if (lower.includes("daily") && (lower.includes("weekly") || lower.includes("monthly"))) return true;
  return false;
}

/** Return common error conditions detected in the raw session output */
function detectErrors(raw: string): Pick<ClaudeUsageResult, "claudeNotFound" | "notAuthenticated"> {
  const notFound = /command not found|claude[:\s]+not found|No such file/i.test(raw);
  const notAuth =
    /not\s+logged\s+in|please\s+login|API\s+key|authenticat/i.test(raw) &&
    /claude/i.test(raw);
  return { claudeNotFound: notFound || undefined, notAuthenticated: notAuth || undefined };
}

/**
 * Best-effort parser for Claude CLI /usage output.
 * Handles both "$X.XX / $X.XX (resets in …)" and "Resets in … \n" formats.
 */
function parseUsage(raw: string): ClaudeUsageParsed {
  const clean = stripAnsi(raw);

  const extractAmount = (label: string): string | undefined =>
    clean.match(
      new RegExp(`${label}[^\\n$]{0,60}?(\\$[\\d.,]+(?:\\s*/\\s*\\$[\\d.,]+)?)`, "i")
    )?.[1]?.trim();

  const extractReset = (label: string): string | undefined => {
    const inline = clean.match(
      new RegExp(`${label}[^\\n]*?(?:resets?\\s+in)\\s+([^\\n)│]+)`, "i")
    )?.[1]?.trim();
    if (inline) return inline;
    return clean.match(
      new RegExp(`${label}[^\\n]*\\n[^\\n]*?(?:resets?\\s+in)\\s+([^\\n│]+)`, "im")
    )?.[1]?.trim();
  };

  return {
    session:      extractAmount("session"),
    daily:        extractAmount("daily"),
    weekly:       extractAmount("weekly"),
    monthly:      extractAmount("monthly"),
    resetDaily:   extractReset("daily"),
    resetWeekly:  extractReset("weekly"),
    resetMonthly: extractReset("monthly"),
  };
}

// ─── Strategy 1: plain SSH exec (no PTY) ─────────────────────────────────────
//
// Pipe "/usage\n/exit\n" to `claude` with TERM=dumb.  Without a real TTY,
// Claude Code should write plain text to stdout rather than rendering a TUI.

async function fetchViaExec(config: SSHConfig): Promise<ClaudeUsageResult | null> {
  try {
    const { stdout, stderr } = await execSSH(
      { host: config.host, port: config.port, username: config.username, sshKeyPath: config.sshKeyPath },
      // Use bash -i so PATH includes nvm/local bins; TERM=dumb suppresses TUI colours
      `bash -ic 'printf "/usage\\n/exit\\n" | TERM=dumb claude 2>&1'`,
      25_000
    );

    const raw = stripAnsi(stdout + stderr).replace(/\r/g, "");

    const errors = detectErrors(raw);
    if (errors.claudeNotFound) {
      return { success: false, rawOutput: raw.slice(-800), parsed: {}, ...errors,
        error: "Claude CLI is not installed on this server." };
    }
    if (errors.notAuthenticated) {
      return { success: false, rawOutput: raw.slice(-800), parsed: {}, ...errors,
        error: "Claude CLI is not authenticated. SSH in and run 'claude login' first." };
    }

    if (looksLikeUsage(raw)) {
      const rawUsage = findUsageBox(raw) || raw.slice(-2000);
      return { success: true, rawOutput: rawUsage, parsed: parseUsage(rawUsage) };
    }

    // Claude ran but output isn't recognisable usage data.
    // Could be a "requires TTY" error — return null to try PTY.
    if (/requires?\s+(a\s+)?(?:tty|terminal|interactive)/i.test(raw)) return null;

    // Return what we got as raw debug output so the user can see it.
    return {
      success: false,
      rawOutput: raw.slice(-1500) || "(no output)",
      parsed: {},
      error: "Claude CLI did not return recognisable usage data (exec mode).",
    };
  } catch {
    return null; // SSH error → try PTY
  }
}

// ─── Strategy 2: PTY shell ────────────────────────────────────────────────────
//
// Open a PTY shell, launch `claude`, wait for its idle prompt, send /usage,
// capture whatever arrives in the next 15 s, then parse.

function fetchViaPTY(config: SSHConfig): Promise<ClaudeUsageResult> {
  return new Promise((resolve) => {
    const keyPath = resolveKeyPath(config.sshKeyPath);
    let privateKey: Buffer;
    try {
      privateKey = fs.readFileSync(keyPath);
    } catch {
      resolve({ success: false, rawOutput: "", parsed: {},
        error: `Cannot read SSH key: ${path.basename(keyPath)}` });
      return;
    }

    const conn = new Client();

    let allText = "";
    let usageText = "";
    let capturingUsage = false;

    type Phase = "shell" | "claude" | "usage" | "done";
    let phase: Phase = "shell";
    const timers: ReturnType<typeof setTimeout>[] = [];
    let finished = false;

    function finish(result: ClaudeUsageResult) {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      try { conn.end(); } catch { /* already closed */ }
      resolve(result);
    }

    function buildResult(): ClaudeUsageResult {
      const rawAll    = stripAnsi(allText).replace(/\r/g, "");
      const fullUsage = stripAnsi(usageText).replace(/\r/g, "");

      const rawUsage =
        findUsageBox(fullUsage) || findUsageBox(rawAll) ||
        fullUsage.slice(-800) || rawAll.slice(-800);

      const errors = detectErrors(rawAll);
      if (errors.claudeNotFound) {
        return { success: false, rawOutput: rawAll.slice(-1000), parsed: {}, ...errors,
          error: "Claude CLI is not installed on this server." };
      }
      if (errors.notAuthenticated) {
        return { success: false, rawOutput: rawAll.slice(-1000), parsed: {}, ...errors,
          error: "Claude CLI is not authenticated. SSH in and run 'claude login' first." };
      }
      if (!looksLikeUsage(rawUsage)) {
        return {
          success: false,
          rawOutput: fullUsage.slice(-1500) || rawAll.slice(-1500),
          parsed: {},
          error:
            "Claude CLI did not return usage data (PTY mode). " +
            "Try running '/usage' manually in an interactive Claude session.",
        };
      }
      return { success: true, rawOutput: rawUsage, parsed: parseUsage(rawUsage) };
    }

    // Hard 90 s deadline
    timers.push(setTimeout(() => {
      finish({ ...buildResult(), success: false,
        error: buildResult().error ?? "Timed out waiting for Claude CLI." });
    }, 90_000));

    conn.on("ready", () => {
      conn.shell({ term: "xterm-256color", cols: 120, rows: 40 }, (err, sh) => {
        if (err) {
          finish({ success: false, rawOutput: "", parsed: {}, error: err.message });
          return;
        }

        sh.on("data", (data: Buffer) => {
          const chunk = data.toString("utf8");
          allText += chunk;
          if (capturingUsage) usageText += chunk;

          if (phase === "shell") {
            if (/[$#%]\s*$/.test(allText.replace(/\r/g, "").slice(-400))) {
              phase = "claude";
              timers.push(setTimeout(() => sh.write("claude\r"), 250));
              // Fallback: force /usage after 15 s if ready signal never arrives
              timers.push(setTimeout(() => {
                if (phase === "claude") {
                  phase = "usage"; capturingUsage = true; usageText = "";
                  sh.write("/usage\r");
                  timers.push(setTimeout(() => { if (phase === "usage") finish(buildResult()); }, 15_000));
                }
              }, 15_000));
            }
          } else if (phase === "claude") {
            const tail = allText.replace(/\r/g, "").slice(-800);
            if (/command not found|claude[:\s]+not found/i.test(tail)) {
              phase = "done"; finish(buildResult()); return;
            }
            const claudeReady =
              tail.includes("for shortcuts") || tail.includes("← for agents") ||
              /^>\s*$/m.test(tail.slice(-120));
            if (claudeReady) {
              phase = "usage"; capturingUsage = true; usageText = "";
              sh.write("/usage\r");
              // Dismiss any blocking panel after 3 s
              timers.push(setTimeout(() => { if (phase === "usage") sh.write("\r"); }, 3_000));
              // Hard finish after 15 s in this phase
              timers.push(setTimeout(() => { if (phase === "usage") finish(buildResult()); }, 15_000));
            }
          } else if (phase === "usage") {
            const recent  = usageText.replace(/\r/g, "").slice(-600);
            const stripped = stripAnsi(usageText).replace(/\r/g, "");

            // Primary: box closed (╰) AND usage data present
            if (recent.includes("╰") && looksLikeUsage(stripped)) {
              phase = "done";
              timers.push(setTimeout(() => { sh.write("/exit\r"); finish(buildResult()); }, 500));
            } else if (
              // Secondary: REPL footer reappeared — only exit if we already have data
              (recent.includes("for shortcuts") || recent.includes("← for agents")) &&
              usageText.length > 80 && looksLikeUsage(stripped)
            ) {
              phase = "done"; sh.write("/exit\r"); finish(buildResult());
            } else if (
              // Tertiary: plain-text usage lines present (no box borders)
              recent.includes("Daily") && recent.includes("Weekly") && usageText.length > 100
            ) {
              phase = "done";
              timers.push(setTimeout(() => { sh.write("/exit\r"); finish(buildResult()); }, 600));
            }
          }
        });

        sh.stderr?.on("data", (d: Buffer) => { allText += d.toString("utf8"); });
        sh.on("close", () => { if (!finished) finish(buildResult()); });

        // Shell-prompt timeout
        timers.push(setTimeout(() => {
          if (phase === "shell") {
            finish({ success: false, rawOutput: stripAnsi(allText).slice(-500), parsed: {},
              error: "Shell did not show a prompt within 15 s. Check the SSH connection." });
          }
        }, 15_000));
      });
    });

    conn.on("error", (err) => {
      finish({ success: false, rawOutput: "", parsed: {}, error: err.message });
    });

    conn.connect({
      host: config.host, port: config.port, username: config.username,
      privateKey, readyTimeout: 30_000,
    });
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch Claude CLI usage from the remote server.
 * Tries the plain-exec approach first (faster, cleaner output), then PTY.
 */
export async function fetchClaudeUsage(config: SSHConfig): Promise<ClaudeUsageResult> {
  const execResult = await fetchViaExec(config);
  if (execResult !== null) return execResult;
  return fetchViaPTY(config);
}

/** @deprecated Use fetchClaudeUsage */
export const fetchClaudeUsageViaPTY = fetchClaudeUsage;
