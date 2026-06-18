"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { BackLink, LoadingState, Modal, Btn, ModalActions, FormField, inputCls } from "@/app/_components/ui";

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
  read_only:        "bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700",
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
  claudeSessionResetsAt: string | null;
  claudeWeekPct: number | null;
  claudeWeekResets: string | null;
  claudeWeekResetsAt: string | null;
  claudeUsageRaw: string | null;
  claudeUsageFetchedAt: string | null;
  // Auto-pause
  pausedDueToUsage: boolean;
  pausedAt: string | null;
  autoPauseEnabled: boolean;
}

interface CommandOutput {
  status: "success" | "failed";
  output: string;
  errorMessage: string | null;
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
  unknown: "text-zinc-700 dark:text-zinc-300",
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
  const [editSshKeyError, setEditSshKeyError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [launchResult, setLaunchResult] = useState<{ success: boolean; message: string } | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [recoverResult, setRecoverResult] = useState<{ success: boolean; message: string } | null>(null);
  const [connectionResult, setConnectionResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [resuming, setResuming] = useState(false);
  const [countdown, setCountdown] = useState<string | null>(null);

  // Command logs — loaded lazily when the section scrolls into view
  const [logs, setLogs] = useState<CommandLog[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsInitialized, setLogsInitialized] = useState(false);
  const logsSectionRef = useRef<HTMLElement>(null);

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
      });
  }, [id, router]);

  useEffect(() => {
    loadServer();
  }, [loadServer]);

  // Live countdown timer when server is paused due to usage.
  useEffect(() => {
    if (!server?.pausedDueToUsage) { setCountdown(null); return; }

    function computeCountdown() {
      const now = Date.now();
      const candidates = [server!.claudeSessionResetsAt, server!.claudeWeekResetsAt]
        .filter((s): s is string => s !== null)
        .map((s) => new Date(s).getTime())
        .filter((t) => t > now);
      if (candidates.length === 0) { setCountdown(null); return; }
      const ms = Math.min(...candidates) - now;
      const totalSec = Math.floor(ms / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      setCountdown(h > 0
        ? `Resumes in ${h}h ${m}m ${s}s`
        : `Resumes in ${m}m ${s}s`);
    }

    computeCountdown();
    const interval = setInterval(computeCountdown, 1000);
    return () => clearInterval(interval);
  }, [server]);

  async function handleResume() {
    setResuming(true);
    await fetch(`/api/servers/${id}/resume`, { method: "POST" });
    setResuming(false);
    loadServer();
  }

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

  async function recoverSession() {
    setRecovering(true);
    setRecoverResult(null);
    try {
      const res = await fetch(`/api/servers/${id}/recover`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setRecoverResult({ success: true, message: "Session recovered successfully." });
        loadServer();
      } else {
        setRecoverResult({ success: false, message: data.error ?? "Recovery failed" });
      }
    } catch {
      setRecoverResult({ success: false, message: "Request failed — check the server connection." });
    } finally {
      setRecovering(false);
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
    setEditSshKeyError(null);
    const res = await fetch(`/api/servers/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...editForm,
        port: Number(editForm.port),
      }),
    });
    if (!res.ok) {
      const data = await res.json();
      const msg: string = data.error ?? "Failed to save server";
      if (msg.startsWith("SSH key file not found or not readable")) {
        setEditSshKeyError(msg);
      }
      return;
    }
    setShowEditForm(false);
    loadServer();
  }

  if (!server) return <LoadingState />;


  return (
    <div className="p-8 max-w-4xl">
      <BackLink href="/servers" label="Servers" />

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-3">
          <span className={`w-3 h-3 rounded-full shrink-0 ${STATUS_DOT[server.status]}`} aria-hidden="true" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">{server.name}</h1>
            <p className={`text-sm font-mono mt-0.5 ${STATUS_LABEL[server.status]}`}>
              {server.username}@{server.host}:{server.port}
            </p>
            <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5">Key: {server.sshKeyPath}</p>
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

      {/* ── Usage Pause Banner ── */}
      {server.pausedDueToUsage && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 mb-6 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-amber-900">
              ⏸ Queue paused — usage limit reached
            </p>
            {countdown && (
              <p className="text-sm text-amber-800 mt-0.5">{countdown}</p>
            )}
            {server.pausedAt && (
              <p className="text-xs text-amber-700 mt-0.5">
                Paused at {new Date(server.pausedAt).toLocaleString()}
              </p>
            )}
          </div>
          <Btn variant="secondary" size="sm" onClick={handleResume} disabled={resuming}>
            {resuming ? "Resuming…" : "Resume Now"}
          </Btn>
        </div>
      )}

      {/* ── Claude Settings ── */}
      <section className="mb-6">
        <h2 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-3">Claude Execution Mode</h2>
        <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-5">
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
              <p className="text-sm text-zinc-700 dark:text-zinc-300 mb-3">
                {server.claudePermissionMode === "read_only" &&
                  "Claude can read and analyze files only — no writes or shell execution."}
                {server.claudePermissionMode === "workspace_write" &&
                  "Claude can edit files and run commands; prompts before risky operations."}
                {server.claudePermissionMode === "full_autonomous" &&
                  "Claude skips all permission prompts and runs fully unattended."}
              </p>
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-600 dark:text-zinc-400">Launch command:</span>
                <code className="text-xs font-mono bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 rounded text-zinc-800 dark:text-zinc-200">
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
              <p className="text-xs text-zinc-600 dark:text-zinc-400 text-right">
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

          <div className="mt-4 pt-4 border-t border-zinc-100 dark:border-zinc-800 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Recovery</p>
              <p className="text-xs text-zinc-500 mt-0.5">Relaunch Claude if the session is offline. Will not run if there are active tasks.</p>
            </div>
            <Btn
              variant="secondary"
              size="sm"
              disabled={recovering}
              onClick={recoverSession}
            >
              {recovering ? "Recovering…" : "Recover Session"}
            </Btn>
          </div>
          {recoverResult && (
            <div
              className={`mt-3 rounded-lg border p-3 text-sm font-medium ${
                recoverResult.success
                  ? "bg-green-50 border-green-200 text-green-800"
                  : "bg-red-50 border-red-200 text-red-800"
              }`}
            >
              {recoverResult.success ? "✓ " : "✗ "}
              {recoverResult.message}
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

      {/* ── Environment Checks ── */}
      <div className="space-y-4 mb-8">
        <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Environment Checks</h2>
        {CHECK_GROUPS.map((group) => (
          <div key={group.label} className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950">
              <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{group.label}</span>
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
                      <code className="text-sm font-mono text-zinc-800 dark:text-zinc-200 bg-zinc-50 dark:bg-zinc-950 px-2 py-0.5 rounded">
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
                          className="text-xs text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:text-zinc-100 border border-zinc-300 dark:border-zinc-600 px-2.5 py-1 rounded-md font-medium disabled:opacity-40 transition-colors"
                        >
                          {isRunning ? "Running…" : "Run"}
                        </button>
                      </div>
                    </div>
                    {out && (
                      <pre
                        className={`mt-2 text-xs rounded-lg p-3 overflow-x-auto whitespace-pre-wrap font-mono ${
                          out.status === "success"
                            ? "bg-zinc-50 dark:bg-zinc-950 text-zinc-800 dark:text-zinc-200"
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
        <h2 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-3">
          Command Logs{logsInitialized ? ` (${logs.length}${nextCursor ? "+" : ""})` : ""}
        </h2>

        {!logsInitialized ? (
          <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-6 text-center">
            <p className="text-sm text-zinc-500">{logsLoading ? "Loading…" : "Scroll down to load logs"}</p>
          </div>
        ) : logs.length === 0 ? (
          <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-6 text-center">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">No commands run yet.</p>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              {logs.map((log) => (
                <div key={log.id} className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-xs font-semibold ${
                          log.status === "success" ? "text-green-700" : "text-red-700"
                        }`}
                      >
                        {log.status === "success" ? "✓" : "✗"}
                      </span>
                      <code className="text-sm font-mono text-zinc-800 dark:text-zinc-200">{log.command}</code>
                    </div>
                    <span className="text-xs text-zinc-600 dark:text-zinc-400">
                      {new Date(log.createdAt).toLocaleString()}
                    </span>
                  </div>
                  {(log.output || log.errorMessage) && (
                    <pre
                      className={`text-xs rounded-lg p-2 font-mono overflow-x-auto whitespace-pre-wrap ${
                        log.status === "success" ? "bg-zinc-50 dark:bg-zinc-950 text-zinc-800 dark:text-zinc-200" : "bg-red-50 text-red-700"
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
        <Modal title="Edit Server" onClose={() => { setShowEditForm(false); setEditSshKeyError(null); }}>
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
                onChange={(e) => { setEditSshKeyError(null); setEditForm({ ...editForm, sshKeyPath: e.target.value }); }}
                className={`${inputCls} font-mono${editSshKeyError ? " border-red-400 focus:border-red-500" : ""}`}
              />
              {editSshKeyError && (
                <p className="text-xs text-red-600 mt-1">{editSshKeyError}</p>
              )}
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
              <Btn type="button" variant="secondary" className="flex-1" onClick={() => { setShowEditForm(false); setEditSshKeyError(null); }}>
                Cancel
              </Btn>
            </ModalActions>
          </form>
        </Modal>
      )}
    </div>
  );
}
