/**
 * Shared helpers used by project-scan-service and debt-scan-service.
 */

import { execSSH, type ServerConfig } from "@/lib/ssh";
import { cleanPane } from "@/lib/usage-parser";
import { SCAN_CAPTURE_LINES } from "@/lib/constants";

/** Escape closing tag sequences so user content cannot break out of XML fences. */
export function escapeXml(tag: string, s: string): string {
  return s.replace(new RegExp(`</${tag}>`, "gi"), `[/${tag}]`);
}

/**
 * Returns true when a string looks like a prompt schema placeholder rather
 * than real content.  Catches:
 *   - The literal "..." used as a placeholder in the old prompt format
 *   - Angle-bracket placeholders like "<specific finding title>"
 *   - Pipe-separated enum strings like "gap|architecture|coverage|suggestion"
 *   - Empty / whitespace-only strings
 */
export function isTemplatePlaceholder(value: string): boolean {
  const v = (value ?? "").trim();
  return v.length === 0 || v === "..." || v.startsWith("<") || v.includes("|");
}

/**
 * Walk a string from `start` (a '{') tracking brace depth and string literals,
 * and return the balanced JSON object substring. Returns null if the object is
 * truncated (unbalanced braces — Claude still streaming).
 */
function extractBalancedObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // Truncated — still streaming
}

/**
 * Try three extraction strategies in order:
 *   1. Between SCAN_FINDINGS_START / SCAN_FINDINGS_END markers (uses lastIndexOf
 *      to skip the prompt instruction text that also contains the marker names).
 *   2. Inside a ```json … ``` fence.
 *   3. First balanced JSON object anywhere in the text.
 *
 * Returns `{ raw, source }` if a candidate is found, or null if the output
 * has no recognisable JSON yet (still processing or empty pane).
 */
export function extractJson(
  pane: string,
  startMarker: string,
  endMarker: string,
): { raw: string; source: string } | null {
  // Strategy 1: between markers — use lastIndexOf so we skip the prompt
  // instruction sentence that includes both marker names as literal text.
  const lastStart = pane.lastIndexOf(startMarker);
  if (lastStart !== -1) {
    const endIdx = pane.indexOf(endMarker, lastStart + startMarker.length);
    if (endIdx !== -1) {
      const raw = pane.slice(lastStart + startMarker.length, endIdx).trim();
      if (raw.startsWith("{")) return { raw, source: "markers" };
    }
  }

  // Strategy 2: ```json fence
  const fenceMatch = pane.match(/```json\s*([\s\S]*?)```/);
  if (fenceMatch) {
    const raw = fenceMatch[1].trim();
    if (raw.startsWith("{")) return { raw, source: "json-fence" };
  }

  // Strategy 3: first balanced JSON object in the pane
  const jsonStart = pane.indexOf("{");
  if (jsonStart !== -1) {
    const raw = extractBalancedObject(pane, jsonStart);
    if (raw) return { raw, source: "raw-json" };
  }

  return null;
}

/**
 * Poll a tmux pane until a JSON block appears and `parsed[resultKey]` is a
 * non-empty array.  Three extraction strategies are tried each poll (see
 * `extractJson`).  Polls continue even on parse errors — Claude may still be
 * streaming.  On timeout, returns the last extracted raw text (for debug) or
 * null if nothing was ever found.
 *
 * Returns:
 *   `{ result: T[], raw }` — success
 *   `{ result: null, raw: string }` — timeout / parse failure (raw text available)
 *   `{ result: null, raw: null }` — timeout with no JSON found at all
 */
export async function pollForFindings<T>(opts: {
  ssh: ServerConfig;
  tmuxSession: string;
  timeoutMs: number;
  intervalMs: number;
  startMarker: string;
  endMarker: string;
  resultKey: string;
}): Promise<{ result: T[] | null; raw: string | null }> {
  const { ssh, tmuxSession, timeoutMs, intervalMs, startMarker, endMarker, resultKey } = opts;
  const deadline = Date.now() + timeoutMs;
  let lastRaw: string | null = null;

  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, intervalMs));

    try {
      const { stdout } = await execSSH(
        ssh,
        `tmux capture-pane -t ${tmuxSession} -p -S -${SCAN_CAPTURE_LINES}`,
        5_000,
      );
      const pane = cleanPane(stdout);
      const extracted = extractJson(pane, startMarker, endMarker);

      if (extracted) {
        lastRaw = extracted.raw;
        if (extracted.raw.includes(`"${resultKey}"`)) {
          try {
            const parsed = JSON.parse(extracted.raw) as Record<string, unknown>;
            const items = parsed[resultKey];
            if (Array.isArray(items)) return { result: items as T[], raw: extracted.raw };
            // Parsed but key missing — keep polling; Claude may not have finished
          } catch {
            // JSON parse failed — may be partial/streaming output; keep polling
          }
        }
      }
    } catch {
      // SSH hiccup — keep polling
    }
  }

  // Timeout: return whatever raw fragment we collected (useful for error messages)
  return { result: null, raw: lastRaw };
}
