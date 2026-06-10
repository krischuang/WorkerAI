"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { BackLink, LoadingState, Modal, Btn, ModalActions, FormField, inputCls } from "@/app/_components/ui";

interface ClaudeUsageParsed {
  sessionPct?: number;
  sessionResets?: string;
  weekPct?: number;
  weekResets?: string;
}

type ClaudeUsageStatus = "ok" | "auth_required" | "rate_limited" | "offline" | "error";

interface UsageData {
  success: boolean;
  status: ClaudeUsageStatus;
  rawOutput: string;
  parsed: ClaudeUsageParsed;
  error?: string;
}

interface CommandLog {
  id: string;
  command: string;
  status: "success" | "failed";
  output: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
}

type ClaudePermissionMode = "read_only" | "workspace_write" | "full_autonomous";

const PERMISSION_MODE_LABEL: Record<ClaudePermissionMode, string> = {
  read_only:        "Read Only",
  workspace_write:  "Workspace Write",
  full_autonomous:  "Full Autonomous",
};

const PERMISSION_MODE_BADGE: Record<ClaudePermissionMode, string> = {
  read_only:        "bg-zinc-100 text-zinc-700 border-zinc-200",
  workspace_write:  "bg-blue-50 text-blue-700 border-blue-200",
  full_autonomous:  "bg-amber-50 text-amber-700 border-amber-200",
};

const PERMISSION_MODE_COMMAND: Record<ClaudePermissionMode, string> = {
  read_only:        `claude --allowedTools "Read,Grep,Glob,LS,WebSearch,WebFetch"`,
  workspace_write:  "claude",
  full_autonomous:  "claude --dangerously-skip-permissions",
};

interface Server {
  id: string;
  name: string;
  host: string;
  username: string;
  port: number;
  sshKeyPath: string;
  status: "unknown" | "connected" | "failed";
  lastCheckedAt: string | null;
  claudePermissionMode: ClaudePermissionMode;
  // Persisted Claude usage
  claudeSessionPct: number | null;
  claudeSessionResets: string | null;
  claudeWeekPct: number | null;
  claudeWeekResets: string | null;
  claudeUsageRaw: string | null;
  claudeUsageFetchedAt: string | null;
}

interface CommandOutput {
  status: "success" | "failed";
  output: string;
  errorMessage: string | null;
}

interface TerminalEntry {
  id: number;
  command: string;
  status: "running" | "success" | "failed";
  output?: string;
  errorMessage?: string | null;
}

const CHECK_GROUPS = [
  { label: "System Info", commands: ["whoami", "hostname", "uptime", "df -h", "free -m"] as const },
  { label: "Node.js", commands: ["node -v", "npm -v"] as const },
  { label: "Git", commands: ["git --version"] as const },
  { label: "Docker", commands: ["docker --version"] as const },
  { label: "Claude CLI", commands: ["claude --version"] as const },
] as const;

const STATUS_DOT: Record<string, string> = {
  unknown: "bg-zinc-400",
  connected: "bg-green-500",
  failed: "bg-red-500",
};

const STATUS_LABEL: Record<string, string> = {
  unknown: "text-zinc-700",
  connected: "text-green-700",
  failed: "text-red-700",
};

export default function ServerDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [server, setServer] = useState<Server | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<Record<string, CommandOutput>>({});
  const [showEditForm, setShowEditForm] = useState(false);
  const [editForm, setEditForm] = useState({
    name: "",
    host: "",
    username: "",
    port: "22",
    sshKeyPath: "",
    claudePermissionMode: "workspace_write" as ClaudePermissionMode,
  });
  const [launching, setLaunching] = useState(false);
  const [launchResult, setLaunchResult] = useState<{ success: boolean; message: string } | null>(null);
  const [connectionResult, setConnectionResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  // Command logs — loaded lazily when the section scrolls into view
  const [logs, setLogs] = useState<CommandLog[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsInitialized, setLogsInitialized] = useState(false);
  const logsSectionRef = useRef<HTMLElement>(null);

  // Claude Usage state
  const [usageData, setUsageData] = useState<UsageData | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageFetchedAt, setUsageFetchedAt] = useState<Date | null>(null);
  const usageAutoFetchedRef = useRef(false);

  // Terminal state
  const [termInput, setTermInput] = useState("");
  const [termRunning, setTermRunning] = useState(false);
  const [termElapsed, setTermElapsed] = useState(0);
  const [termHistory, setTermHistory] = useState<TerminalEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const termBottomRef = useRef<HTMLDivElement>(null);
  const termInputRef = useRef<HTMLInputElement>(null);
  const termCounter = useRef(0);
  const elapsedTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadServer = useCallback(() => {
    fetch(`/api/servers/${id}`)
      .then((r) => {
        if (!r.ok) { router.push("/servers"); return null; }
        return r.json();
      })
      .then((data: Server | null) => {
        if (!data) return;
        setServer(data);
        setEditForm({
          name: data.name,
          host: data.host,
          username: data.username,
          port: String(data.port),
          sshKeyPath: data.sshKeyPath,
          claudePermissionMode: data.claudePermissionMode ?? "workspace_write",
        });
        // Seed usage display from persisted DB fields (no wait needed on page load)
        if (data.claudeUsageFetchedAt && !usageAutoFetchedRef.current) {
          setUsageData({
            success: true,
            status: "ok",
            rawOutput: data.claudeUsageRaw ?? "",
            parsed: {
              sessionPct:    data.claudeSessionPct ?? undefined,
              sessionResets: data.claudeSessionResets ?? undefined,
              weekPct:       data.claudeWeekPct ?? undefined,
              weekResets:    data.claudeWeekResets ?? undefined,
            },
          });
          setUsageFetchedAt(new Date(data.claudeUsageFetchedAt));
        }
      });
  }, [id, router]);

  useEffect(() => {
    loadServer();
  }, [loadServer]);

  const loadLogs = useCallback(async (cursor?: string) => {
    setLogsLoading(true);
    try {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      const res = await fetch(`/api/servers/${id}/logs?${params}`);
      if (!res.ok) return;
      const data: { logs: CommandLog[]; nextCursor: string | null } = await res.json();
      setLogs((prev) => (cursor ? [...prev, ...data.logs] : data.logs));
      setNextCursor(data.nextCursor);
      setLogsInitialized(true);
    } finally {
      setLogsLoading(false);
    }
  }, [id]);

  // Lazy-load logs when the section scrolls near the viewport.
  useEffect(() => {
    const el = logsSectionRef.current;
    if (!el || logsInitialized) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { obs.disconnect(); loadLogs(); } },
      { rootMargin: "300px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [logsInitialized, loadLogs]);

  // Auto-fetch Claude usage once if there is no persisted data yet
  useEffect(() => {
    if (server?.status === "connected" && !usageAutoFetchedRef.current && !server.claudeUsageFetchedAt) {
      usageAutoFetchedRef.current = true;
      fetchClaudeUsage();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.status]);

  async function fetchClaudeUsage() {
    setUsageLoading(true);
    try {
      const res = await fetch(`/api/servers/${id}/claude-usage`, { method: "POST" });
      let result: UsageData = await res.json();
      // If auth_required on first attempt, wait and retry once — it may be a
      // transient false positive from stale pane content after a session restart.
      if (!result.success && result.status === "auth_required") {
        await new Promise<void>((resolve) => setTimeout(resolve, 4_000));
        const retryRes = await fetch(`/api/servers/${id}/claude-usage`, { method: "POST" });
        const retryResult: UsageData = await retryRes.json();
        if (retryResult.success || retryResult.status !== "auth_required") {
          result = retryResult;
        }
      }
      setUsageData(result);
      setUsageFetchedAt(new Date());
    } catch {
      setUsageData({
        success: false,
        status: "error",
        rawOutput: "",
        parsed: {},
        error: "Request failed — check the server connection.",
      });
    } finally {
      setUsageLoading(false);
    }
  }

  useEffect(() => {
    termBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [termHistory]);

  async function launchClaudeSession() {
    setLaunching(true);
    setLaunchResult(null);
    try {
      const res = await fetch(`/api/servers/${id}/launch-claude`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        const cmd = server ? PERMISSION_MODE_COMMAND[server.claudePermissionMode] : "";
        setLaunchResult({ success: true, message: `Claude launched: ${cmd}` });
      } else {
        setLaunchResult({ success: false, message: data.error ?? "Launch failed" });
      }
    } catch {
      setLaunchResult({ success: false, message: "Request failed — check the server connection." });
    } finally {
      setLaunching(false);
    }
  }

  async function testConnection() {
    setConnecting(true);
    setConnectionResult(null);
    const res = await fetch(`/api/servers/${id}/connect`, { method: "POST" });
    const result = await res.json();
    setConnectionResult(result);
    setConnecting(false);
    loadServer();
    if (logsInitialized) loadLogs();
  }

  async function runCommand(command: string) {
    setRunning(command);
    const res = await fetch(`/api/servers/${id}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command }),
    });
    const result: CommandOutput = await res.json();
    setOutputs((prev) => ({ ...prev, [command]: result }));
    setRunning(null);
    loadServer();
    if (logsInitialized) loadLogs();
  }

  async function runGroup(commands: readonly string[]) {
    for (const cmd of commands) {
      await runCommand(cmd);
    }
  }

  async function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    await fetch(`/api/servers/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...editForm,
        port: Number(editForm.port),
      }),
    });
    setShowEditForm(false);
    loadServer();
  }

  async function handleTermSubmit(e: React.FormEvent) {
    e.preventDefault();
    const cmd = termInput.trim();
    if (!cmd) return;

    const entryId = ++termCounter.current;
    setTermHistory((prev) => [...prev, { id: entryId, command: cmd, status: "running" }]);
    setTermInput("");
    setHistoryIndex(-1);
    setTermRunning(true);
    setTermElapsed(0);
    elapsedTimer.current = setInterval(() => setTermElapsed((s) => s + 1), 1000);

    const controller = new AbortController();
    abortRef.current = controller;

    function stopTimer() {
      if (elapsedTimer.current) clearInterval(elapsedTimer.current);
      setTermRunning(false);
      setTermElapsed(0);
      abortRef.current = null;
    }

    try {
      const res = await fetch(`/api/servers/${id}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd }),
        signal: controller.signal,
      });
      const result = await res.json();
      setTermHistory((prev) =>
        prev.map((e) =>
          e.id === entryId
            ? { ...e, status: result.status, output: result.output, errorMessage: result.errorMessage }
            : e
        )
      );
    } catch (err) {
      const cancelled = err instanceof DOMException && err.name === "AbortError";
      setTermHistory((prev) =>
        prev.map((e) =>
          e.id === entryId
            ? {
                ...e,
                status: "failed" as const,
                errorMessage: cancelled ? "Cancelled" : String(err),
              }
            : e
        )
      );
    } finally {
      stopTimer();
      loadServer();
      if (logsInitialized) loadLogs();
      termInputRef.current?.focus();
    }
  }

  function handleForceStop() {
    abortRef.current?.abort();
  }

  function handleTermKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const cmds = termHistory.map((h) => h.command);
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const nextIdx = Math.min(historyIndex + 1, cmds.length - 1);
      setHistoryIndex(nextIdx);
      setTermInput(cmds[cmds.length - 1 - nextIdx] ?? "");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const nextIdx = Math.max(historyIndex - 1, -1);
      setHistoryIndex(nextIdx);
      setTermInput(nextIdx === -1 ? "" : (cmds[cmds.length - 1 - nextIdx] ?? ""));
    }
  }

  if (!server) return <LoadingState />;

  const promptLabel = `${server.username}@${server.host}`;


  return (
    <div className="p-8 max-w-4xl">
      <BackLink href="/servers" label="Servers" />

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-3">
          <span className={`w-3 h-3 rounded-full shrink-0 ${STATUS_DOT[server.status]}`} aria-hidden="true" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{server.name}</h1>
            <p className={`text-sm font-mono mt-0.5 ${STATUS_LABEL[server.status]}`}>
              {server.username}@{server.host}:{server.port}
            </p>
            <p className="text-xs text-zinc-600 mt-0.5">Key: {server.sshKeyPath}</p>
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          <Btn variant="secondary" size="sm" onClick={() => setShowEditForm(true)}>
            Edit
          </Btn>
          <Link
            href={`/servers/${id}/terminal`}
            className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-100 hover:bg-zinc-700 transition-colors border border-zinc-700"
          >
            <span className="text-green-400 text-xs">▶</span>
            Terminal
          </Link>
          <Btn variant="primary" disabled={connecting} onClick={testConnection}>
            {connecting ? "Connecting…" : "Test SSH"}
          </Btn>
        </div>
      </div>

      {connectionResult && (
        <div
          className={`rounded-xl border p-4 mb-6 text-sm font-medium ${
            connectionResult.success
              ? "bg-green-50 border-green-200 text-green-800"
              : "bg-red-50 border-red-200 text-red-800"
          }`}
        >
          {connectionResult.success ? "✓ " : "✗ "}
          {connectionResult.message}
        </div>
      )}

      {/* ── Claude Settings ── */}
      <section className="mb-6">
        <h2 className="font-semibold text-zinc-900 mb-3">Claude Execution Mode</h2>
        <div className="bg-white rounded-xl border border-zinc-200 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1.5">
                <span
                  className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
                    PERMISSION_MODE_BADGE[server.claudePermissionMode]
                  }`}
                >
                  {PERMISSION_MODE_LABEL[server.claudePermissionMode]}
                </span>
              </div>
              <p className="text-sm text-zinc-700 mb-3">
                {server.claudePermissionMode === "read_only" &&
                  "Claude can read and analyze files only — no writes or shell execution."}
                {server.claudePermissionMode === "workspace_write" &&
                  "Claude can edit files and run commands; prompts before risky operations."}
                {server.claudePermissionMode === "full_autonomous" &&
                  "Claude skips all permission prompts and runs fully unattended."}
              </p>
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-600">Launch command:</span>
                <code className="text-xs font-mono bg-zinc-100 px-2 py-0.5 rounded text-zinc-800">
                  {PERMISSION_MODE_COMMAND[server.claudePermissionMode]}
                </code>
              </div>
            </div>
            <div className="flex flex-col items-end gap-2 shrink-0">
              <Btn
                variant="primary"
                size="sm"
                disabled={launching}
                onClick={launchClaudeSession}
              >
                {launching ? "Launching…" : "Launch Claude Session"}
              </Btn>
              <p className="text-xs text-zinc-600 text-right">
                Restarts Claude in the tmux session with the configured mode flags.
              </p>
            </div>
          </div>

          {launchResult && (
            <div
              className={`mt-4 rounded-lg border p-3 text-sm font-medium ${
                launchResult.success
                  ? "bg-green-50 border-green-200 text-green-800"
                  : "bg-red-50 border-red-200 text-red-800"
              }`}
            >
              {launchResult.success ? "✓ " : "✗ "}
              {launchResult.message}
            </div>
          )}

          {server.claudePermissionMode === "full_autonomous" && (
            <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
              <strong>Warning:</strong> Full Autonomous mode passes{" "}
              <code className="font-mono bg-amber-100 px-1 rounded">--dangerously-skip-permissions</code> to Claude CLI.
              Claude will execute shell commands, modify files, and install packages without confirmation prompts.
            </div>
          )}
        </div>
      </section>

      {/* ── Claude Usage ── */}
      <section className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-zinc-900">Claude Usage</h2>
          <div className="flex items-center gap-3">
            {usageFetchedAt && (
              <span className="text-xs text-zinc-500">
                fetched {usageFetchedAt.toLocaleTimeString()}
              </span>
            )}
            <Btn
              variant="secondary"
              size="sm"
              disabled={usageLoading}
              onClick={fetchClaudeUsage}
            >
              {usageLoading ? "Fetching…" : "Refresh"}
            </Btn>
          </div>
        </div>

        {/* Status banners */}
        {usageData && !usageData.success && usageData.status === "auth_required" && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-3 text-sm text-amber-800">
            <span className="font-semibold">Claude CLI is not authenticated.</span>{" "}
            If Claude was recently restarted this may be a transient glitch — try{" "}
            <button
              onClick={fetchClaudeUsage}
              disabled={usageLoading}
              className="underline font-semibold disabled:opacity-50"
            >
              refreshing again
            </button>
            . If it persists, SSH in and run{" "}
            <code className="font-mono bg-amber-100 px-1 rounded">claude login</code>.
          </div>
        )}
        {usageData && !usageData.success && usageData.status === "offline" && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-3 text-sm text-amber-800">
            <p className="font-semibold mb-1.5">tmux session not found.</p>
            <p className="mb-1">Run once on the server to set it up:</p>
            <pre className="bg-amber-100 rounded p-2 text-xs font-mono whitespace-pre-wrap">
              {`tmux new-session -d -s claude\ntmux send-keys -t claude 'claude' Enter`}
            </pre>
          </div>
        )}
        {usageData && !usageData.success && usageData.status === "rate_limited" && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-3 text-sm text-amber-800">
            <span className="font-semibold">Rate limited.</span> Wait a moment and try again.
          </div>
        )}

        <div className="bg-zinc-950 rounded-xl border border-zinc-800 overflow-hidden">
          {/* ── Usage meters ── */}
          {usageData?.success && (() => {
            const { sessionPct, sessionResets, weekPct, weekResets } = usageData.parsed;
            const meters = [
              { label: "Current session", pct: sessionPct, resets: sessionResets },
              { label: "Current week", pct: weekPct, resets: weekResets },
            ].filter((m) => m.pct !== undefined);

            if (meters.length === 0) return null;

            return (
              <div className="grid grid-cols-2 gap-px bg-zinc-800 border-b border-zinc-800">
                {meters.map(({ label, pct, resets }) => {
                  const p = pct ?? 0;
                  const barColor =
                    p >= 90 ? "bg-red-500" :
                    p >= 70 ? "bg-amber-500" :
                    "bg-green-500";
                  return (
                    <div key={label} className="bg-zinc-900 px-4 py-3">
                      <p className="text-xs text-zinc-500 font-mono mb-2">{label}</p>
                      <div className="flex items-center gap-2 mb-1.5">
                        <div className="flex-1 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${barColor}`}
                            style={{ width: `${Math.min(p, 100)}%` }}
                          />
                        </div>
                        <span className={`text-xs font-mono tabular-nums ${
                          p >= 90 ? "text-red-400" : p >= 70 ? "text-amber-400" : "text-zinc-300"
                        }`}>{p}%</span>
                      </div>
                      {resets && (
                        <p className="text-xs text-zinc-500 font-mono">Resets {resets}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}

          {/* Empty / loading state when no meters to show */}
          {(!usageData || (usageData.success && !usageData.parsed.sessionPct && !usageData.parsed.weekPct)) && (
            <div className="px-4 py-4 text-xs font-mono text-zinc-600 min-h-[56px]">
              {usageLoading
                ? "Sending /usage to the Claude tmux session…"
                : !usageData
                  ? server.status === "connected" ? "Loading…" : "Test the SSH connection above to fetch Claude usage."
                  : null}
            </div>
          )}

          {/* Error footer */}
          {usageData && !usageData.success &&
            usageData.status !== "auth_required" &&
            usageData.status !== "offline" &&
            usageData.status !== "rate_limited" &&
            usageData.error && (
            <div className="px-4 py-3 text-xs text-red-400 font-mono min-h-[56px]">
              {usageData.error}
            </div>
          )}
        </div>
      </section>

      {/* ── Terminal ── */}
      <section className="mb-8">
        <h2 className="font-semibold text-zinc-900 mb-3">Terminal</h2>
        <div className="bg-zinc-950 rounded-xl overflow-hidden border border-zinc-800">
          {/* title bar */}
          <div className="flex items-center gap-2 px-4 py-2 bg-zinc-900 border-b border-zinc-800">
            <span className="w-2.5 h-2.5 rounded-full bg-zinc-600" />
            <span className="w-2.5 h-2.5 rounded-full bg-zinc-600" />
            <span className="w-2.5 h-2.5 rounded-full bg-zinc-600" />
            <span className="ml-2 text-xs text-zinc-500 font-mono flex-1">{promptLabel}</span>
            {termRunning && (
              <button
                onClick={handleForceStop}
                className="text-xs text-red-400 hover:text-red-300 border border-red-800 hover:border-red-600 px-2.5 py-1 rounded font-mono transition-colors"
              >
                ■ stop
              </button>
            )}
          </div>

          {/* output history */}
          <div className="px-4 py-3 min-h-[120px] max-h-80 overflow-y-auto space-y-3 font-mono text-xs">
            {termHistory.length === 0 && (
              <p className="text-zinc-600">Type a command below to run it on the server.</p>
            )}
            {termHistory.map((entry) => (
              <div key={entry.id}>
                <div className="flex items-start gap-2">
                  <span className="text-green-500 shrink-0 select-none">$</span>
                  <span className="text-zinc-200">{entry.command}</span>
                  {entry.status === "running" && (
                    <span className="text-zinc-500 ml-2 tabular-nums">
                      {termElapsed}s…
                    </span>
                  )}
                </div>
                {entry.status !== "running" && (
                  <pre
                    className={`mt-1 ml-4 whitespace-pre-wrap break-all leading-relaxed ${
                      entry.status === "success" ? "text-zinc-300" : "text-red-400"
                    }`}
                  >
                    {entry.status === "success"
                      ? entry.output || "(no output)"
                      : entry.errorMessage || entry.output || "(error)"}
                  </pre>
                )}
              </div>
            ))}
            <div ref={termBottomRef} />
          </div>

          {/* input row */}
          <form
            onSubmit={handleTermSubmit}
            className="flex items-center gap-2 px-4 py-3 border-t border-zinc-800 bg-zinc-900"
          >
            <span className="text-green-500 font-mono text-xs shrink-0 select-none">$</span>
            <input
              ref={termInputRef}
              value={termInput}
              onChange={(e) => setTermInput(e.target.value)}
              onKeyDown={handleTermKeyDown}
              disabled={termRunning}
              placeholder="enter command…"
              spellCheck={false}
              autoComplete="off"
              className="flex-1 bg-transparent text-zinc-100 font-mono text-xs placeholder:text-zinc-600 focus:outline-none disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={termRunning || termInput.trim() === ""}
              className="text-xs text-zinc-400 hover:text-zinc-100 disabled:opacity-30 transition-colors px-2 py-1 border border-zinc-700 rounded font-mono"
            >
              {termRunning ? `${termElapsed}s` : "run"}
            </button>
          </form>
        </div>
        <p className="text-xs text-zinc-600 mt-1.5">↑ ↓ to navigate history</p>
      </section>

      {/* ── Environment Checks ── */}
      <div className="space-y-4 mb-8">
        <h2 className="font-semibold text-zinc-900">Environment Checks</h2>
        {CHECK_GROUPS.map((group) => (
          <div key={group.label} className="bg-white rounded-xl border border-zinc-200 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-100 bg-zinc-50">
              <span className="text-sm font-semibold text-zinc-800">{group.label}</span>
              <Btn
                size="sm"
                variant="primary"
                disabled={running !== null}
                onClick={() => runGroup(group.commands)}
              >
                Check all
              </Btn>
            </div>
            <div className="divide-y divide-zinc-50">
              {group.commands.map((cmd) => {
                const out = outputs[cmd];
                const isRunning = running === cmd;
                return (
                  <div key={cmd} className="px-5 py-3">
                    <div className="flex items-center justify-between">
                      <code className="text-sm font-mono text-zinc-800 bg-zinc-50 px-2 py-0.5 rounded">
                        {cmd}
                      </code>
                      <div className="flex items-center gap-2">
                        {out && (
                          <span
                            className={`text-xs font-semibold ${
                              out.status === "success" ? "text-green-700" : "text-red-700"
                            }`}
                          >
                            {out.status === "success" ? "✓" : "✗"}
                          </span>
                        )}
                        <button
                          onClick={() => runCommand(cmd)}
                          disabled={running !== null}
                          className="text-xs text-zinc-700 hover:text-zinc-900 border border-zinc-300 px-2.5 py-1 rounded-md font-medium disabled:opacity-40 transition-colors"
                        >
                          {isRunning ? "Running…" : "Run"}
                        </button>
                      </div>
                    </div>
                    {out && (
                      <pre
                        className={`mt-2 text-xs rounded-lg p-3 overflow-x-auto whitespace-pre-wrap font-mono ${
                          out.status === "success"
                            ? "bg-zinc-50 text-zinc-800"
                            : "bg-red-50 text-red-700"
                        }`}
                      >
                        {out.status === "success"
                          ? out.output || "(no output)"
                          : out.errorMessage || out.output || "(no output)"}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* ── Command Logs ── lazy-loaded when section enters the viewport ── */}
      <section ref={logsSectionRef}>
        <h2 className="font-semibold text-zinc-900 mb-3">
          Command Logs{logsInitialized ? ` (${logs.length}${nextCursor ? "+" : ""})` : ""}
        </h2>

        {!logsInitialized ? (
          <div className="bg-white rounded-xl border border-zinc-200 p-6 text-center">
            <p className="text-sm text-zinc-500">{logsLoading ? "Loading…" : "Scroll down to load logs"}</p>
          </div>
        ) : logs.length === 0 ? (
          <div className="bg-white rounded-xl border border-zinc-200 p-6 text-center">
            <p className="text-sm text-zinc-600">No commands run yet.</p>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              {logs.map((log) => (
                <div key={log.id} className="bg-white rounded-xl border border-zinc-200 p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-xs font-semibold ${
                          log.status === "success" ? "text-green-700" : "text-red-700"
                        }`}
                      >
                        {log.status === "success" ? "✓" : "✗"}
                      </span>
                      <code className="text-sm font-mono text-zinc-800">{log.command}</code>
                    </div>
                    <span className="text-xs text-zinc-600">
                      {new Date(log.createdAt).toLocaleString()}
                    </span>
                  </div>
                  {(log.output || log.errorMessage) && (
                    <pre
                      className={`text-xs rounded-lg p-2 font-mono overflow-x-auto whitespace-pre-wrap ${
                        log.status === "success" ? "bg-zinc-50 text-zinc-800" : "bg-red-50 text-red-700"
                      }`}
                    >
                      {log.output || log.errorMessage}
                    </pre>
                  )}
                </div>
              ))}
            </div>

            {nextCursor && (
              <div className="mt-4 text-center">
                <Btn
                  variant="secondary"
                  size="sm"
                  disabled={logsLoading}
                  onClick={() => loadLogs(nextCursor)}
                >
                  {logsLoading ? "Loading…" : "Load older logs"}
                </Btn>
              </div>
            )}
          </>
        )}
      </section>

      {/* ── Edit Modal ── */}
      {showEditForm && (
        <Modal title="Edit Server" onClose={() => setShowEditForm(false)}>
          <form onSubmit={handleEditSubmit} className="space-y-4">
            <FormField label="Name" required>
              <input
                required
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                className={inputCls}
              />
            </FormField>
            <FormField label="Host" required>
              <input
                required
                value={editForm.host}
                onChange={(e) => setEditForm({ ...editForm, host: e.target.value })}
                className={`${inputCls} font-mono`}
              />
            </FormField>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <FormField label="Username" required>
                  <input
                    required
                    value={editForm.username}
                    onChange={(e) => setEditForm({ ...editForm, username: e.target.value })}
                    className={`${inputCls} font-mono`}
                  />
                </FormField>
              </div>
              <FormField label="Port" required>
                <input
                  required
                  type="number"
                  value={editForm.port}
                  onChange={(e) => setEditForm({ ...editForm, port: e.target.value })}
                  className={`${inputCls} font-mono`}
                />
              </FormField>
            </div>
            <FormField label="SSH Key Path" required>
              <input
                required
                value={editForm.sshKeyPath}
                onChange={(e) => setEditForm({ ...editForm, sshKeyPath: e.target.value })}
                className={`${inputCls} font-mono`}
              />
            </FormField>
            <FormField label="Claude Execution Mode">
              <select
                value={editForm.claudePermissionMode}
                onChange={(e) =>
                  setEditForm({ ...editForm, claudePermissionMode: e.target.value as ClaudePermissionMode })
                }
                className={inputCls}
              >
                <option value="read_only">Read Only</option>
                <option value="workspace_write">Workspace Write</option>
                <option value="full_autonomous">Full Autonomous</option>
              </select>
            </FormField>
            {editForm.claudePermissionMode === "full_autonomous" && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
                <strong>Warning:</strong> Full Autonomous passes{" "}
                <code className="font-mono bg-amber-100 px-1 rounded">--dangerously-skip-permissions</code> to Claude CLI.
              </div>
            )}
            <ModalActions>
              <Btn type="submit" variant="primary" className="flex-1">
                Save Changes
              </Btn>
              <Btn type="button" variant="secondary" className="flex-1" onClick={() => setShowEditForm(false)}>
                Cancel
              </Btn>
            </ModalActions>
          </form>
        </Modal>
      )}
    </div>
  );
}
