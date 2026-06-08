"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
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

interface Server {
  id: string;
  name: string;
  host: string;
  username: string;
  port: number;
  sshKeyPath: string;
  status: "unknown" | "connected" | "failed";
  lastCheckedAt: string | null;
  commandLogs: CommandLog[];
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
  });
  const [connectionResult, setConnectionResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

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
        });
      });
  }, [id, router]);

  useEffect(() => {
    loadServer();
  }, [loadServer]);

  useEffect(() => {
    termBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [termHistory]);

  async function testConnection() {
    setConnecting(true);
    setConnectionResult(null);
    const res = await fetch(`/api/servers/${id}/connect`, { method: "POST" });
    const result = await res.json();
    setConnectionResult(result);
    setConnecting(false);
    loadServer();
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
      body: JSON.stringify({ ...editForm, port: Number(editForm.port) }),
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
          <Btn variant="primary" disabled={connecting} onClick={testConnection}>
            {connecting ? "Connecting…" : "Test SSH Connection"}
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

      {/* ── Command Logs ── */}
      <section>
        <h2 className="font-semibold text-zinc-900 mb-3">
          Command Logs ({server.commandLogs.length})
        </h2>
        {server.commandLogs.length === 0 ? (
          <div className="bg-white rounded-xl border border-zinc-200 p-6 text-center">
            <p className="text-sm text-zinc-600">No commands run yet.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {server.commandLogs.map((log) => (
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
