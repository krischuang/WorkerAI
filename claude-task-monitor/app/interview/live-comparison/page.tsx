"use client";

import { useEffect, useRef, useState } from "react";
import { PageHeader, Btn, Modal, EmptyState } from "@/app/_components/ui";
import { Play, Square, RotateCcw, FileText, Terminal, ClipboardCheck, AlertTriangle, GitCompare, ClipboardList } from "lucide-react";

type AgentId = "a" | "b";
type RunStatus = "idle" | "running" | "done" | "cancelled" | "error";
type VerificationLabel = "NOT_VERIFIED" | "INDEPENDENTLY_VERIFIED" | "VERIFICATION_FAILED";

interface AgentEvent {
  seq: number;
  agent: AgentId | "system";
  kind: "status" | "text" | "tool_call" | "tool_result" | "final" | "error";
  text?: string;
  tool?: string;
  input?: unknown;
  isError?: boolean;
  costUsd?: number | null;
  durationMs?: number | null;
  timestamp: string;
}

interface AgentOutcome {
  status: "done" | "error" | "timeout" | "cancelled";
  resultText: string | null;
  isError: boolean;
  costUsd: number | null;
  durationMs: number | null;
}

interface CommandResult {
  label: string;
  command: string;
  exitCode: number | null;
  stdoutSummary: string;
  stderrSummary: string;
  durationMs: number;
}

interface BackendVerdict {
  ran: boolean;
  allPassed: boolean;
  commands: CommandResult[];
}

interface RunState {
  runId: string;
  status: RunStatus;
  startedAt: string | null;
  workspaceDir: string | null;
  events: AgentEvent[];
  agentA: AgentOutcome | null;
  agentB: AgentOutcome | null;
  implementationDiff: string | null;
  backendVerdict: BackendVerdict | null;
  verificationLabel: VerificationLabel | null;
  errorMessage: string | null;
}

interface SourceFiles {
  tasksApiJs: string | null;
  testJs: string | null;
  packageJson: string | null;
  requirementsMd: string | null;
  disclosure: string | null;
}

function extractStatusLine(text: string | null): string | null {
  if (!text) return null;
  const match = text.match(/(STATUS|VERDICT):\s*(COMPLETE|INCOMPLETE|SATISFIES_REQUIREMENTS|DOES_NOT_SATISFY_REQUIREMENTS)/i);
  return match ? match[0].toUpperCase() : null;
}

const LABEL_COPY: Record<VerificationLabel, { text: string; className: string }> = {
  INDEPENDENTLY_VERIFIED: { text: "INDEPENDENTLY VERIFIED", className: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-400" },
  VERIFICATION_FAILED: { text: "VERIFICATION FAILED", className: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-400" },
  NOT_VERIFIED: { text: "NOT VERIFIED", className: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" },
};

function StatusPill({ label }: { label: string }) {
  return <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-black/20 text-white">{label}</span>;
}

function AgentPanel({ title, subtitle, evidenceLabel, events, outcome, accent }: {
  title: string;
  subtitle: string;
  evidenceLabel: string;
  events: AgentEvent[];
  outcome: AgentOutcome | null;
  accent: string;
}) {
  const statusLine = extractStatusLine(outcome?.resultText ?? null);
  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden flex flex-col h-[560px]">
      <div className={`px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 ${accent}`}>
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold text-sm text-white">{title}</h3>
          <StatusPill label={evidenceLabel} />
        </div>
        <p className="text-xs text-white/80 mt-0.5">{subtitle}</p>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2 font-mono text-[12px] bg-zinc-950 text-zinc-200">
        {events.length === 0 && <p className="text-zinc-500 italic">Waiting to start…</p>}
        {events.map((e) => {
          if (e.kind === "status") {
            return <p key={e.seq} className="text-zinc-500">· {e.text}</p>;
          }
          if (e.kind === "text") {
            return <p key={e.seq} className="text-zinc-100 whitespace-pre-wrap">{e.text}</p>;
          }
          if (e.kind === "tool_call") {
            return (
              <p key={e.seq} className="text-sky-400">
                → tool call: <span className="text-sky-300">{e.tool}</span>
                {e.input ? <span className="text-sky-600"> {JSON.stringify(e.input).slice(0, 160)}</span> : null}
              </p>
            );
          }
          if (e.kind === "tool_result") {
            return <p key={e.seq} className="text-amber-400 whitespace-pre-wrap">← {e.text}</p>;
          }
          if (e.kind === "final") {
            return (
              <p key={e.seq} className={`whitespace-pre-wrap font-semibold ${e.isError ? "text-red-400" : "text-green-400"}`}>
                [{evidenceLabel}] {e.text}
              </p>
            );
          }
          if (e.kind === "error") {
            return <p key={e.seq} className="text-red-400">⚠ {e.text}</p>;
          }
          return null;
        })}
      </div>
      {outcome && (
        <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-xs flex items-center justify-between">
          <span className={`font-semibold ${outcome.isError ? "text-red-600 dark:text-red-400" : "text-zinc-700 dark:text-zinc-300"}`}>
            {statusLine ? `Claude said: ${statusLine}` : outcome.status}
          </span>
          <span className="text-zinc-500">
            {outcome.durationMs != null ? `${(outcome.durationMs / 1000).toFixed(1)}s` : ""}
            {outcome.costUsd != null ? ` · $${outcome.costUsd.toFixed(3)}` : ""}
          </span>
        </div>
      )}
    </div>
  );
}

const PRODUCTION_REFERENCES = [
  { label: "lib/resource-access.ts", url: "https://github.com/krischuang/WorkerAI/blob/main/claude-task-monitor/lib/resource-access.ts" },
  { label: "lib/service-account.ts", url: "https://github.com/krischuang/WorkerAI/blob/main/claude-task-monitor/lib/service-account.ts" },
  { label: "lib/validation-gate.ts", url: "https://github.com/krischuang/WorkerAI/blob/main/claude-task-monitor/lib/validation-gate.ts" },
];

export default function LiveComparisonPage() {
  const [state, setState] = useState<RunState | null>(null);
  const [sourceFiles, setSourceFiles] = useState<SourceFiles | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const connectStream = (fromSeq: number) => {
    if (typeof EventSource === "undefined") return;
    esRef.current?.close();
    const es = new EventSource(`/api/interview/live-comparison/stream?cursor=${fromSeq}`);
    esRef.current = es;

    es.addEventListener("agent-event", (e: MessageEvent) => {
      const ev = JSON.parse(e.data) as AgentEvent;
      setState((prev) => {
        if (!prev) return prev;
        // Guards against duplicate delivery if React's Strict Mode double-
        // invokes this effect in dev (two EventSource connections briefly
        // overlapping, both replaying from the same cursor) or a browser
        // SSE auto-reconnect replays already-seen events.
        if (prev.events.some((existing) => existing.seq === ev.seq)) return prev;
        return { ...prev, events: [...prev.events, ev] };
      });
    });

    es.addEventListener("run-complete", (e: MessageEvent) => {
      const data = JSON.parse(e.data) as Pick<
        RunState,
        "status" | "agentA" | "agentB" | "implementationDiff" | "backendVerdict" | "verificationLabel" | "errorMessage"
      >;
      setState((prev) => (prev ? { ...prev, ...data } : prev));
      es.close();
    });

    es.onerror = () => {
      // Browser auto-retries SSE by default; nothing to do here.
    };
  };

  useEffect(() => {
    fetch("/api/interview/live-comparison")
      .then((r) => (r.ok ? r.json() : null))
      .then((s: RunState | null) => {
        if (!s) return;
        setState(s);
        if (s.status === "running") connectStream(s.events.length ? s.events[s.events.length - 1].seq : -1);
      });
    return () => esRef.current?.close();
  }, []);

  const start = async () => {
    setActionError(null);
    setStarting(true);
    try {
      const res = await fetch("/api/interview/live-comparison", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.error ?? "Failed to start.");
        return;
      }
      setState(data as RunState);
      connectStream(-1);
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    setActionError(null);
    const res = await fetch("/api/interview/live-comparison/cancel", { method: "POST" });
    const data = await res.json();
    if (!res.ok) setActionError(data.error ?? "Failed to cancel.");
    else setState(data as RunState);
  };

  const reset = async () => {
    setActionError(null);
    esRef.current?.close();
    const res = await fetch("/api/interview/live-comparison", { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) setActionError(data.error ?? "Failed to reset.");
    else setState(data as RunState);
  };

  const openSource = async () => {
    const res = await fetch("/api/interview/live-comparison/source");
    setSourceFiles(await res.json());
    setShowSource(true);
  };

  const isRunning = state?.status === "running";
  const isTerminal = state?.status === "done" || state?.status === "error" || state?.status === "cancelled";
  const aEvents = state?.events.filter((e) => e.agent === "a") ?? [];
  const bEvents = state?.events.filter((e) => e.agent === "b") ?? [];
  const systemEvents = state?.events.filter((e) => e.agent === "system") ?? [];
  const label = state?.verificationLabel;

  return (
    <div className="p-8 max-w-6xl">
      <PageHeader
        title="Live Two-Agent Comparison"
        subtitle="Interview demo only. Agent A implements a fix for a real, seeded multi-tenant authorization bug; Agent B independently reviews the result; WorkerAI's backend independently re-runs the real acceptance tests. The verdict comes from a real exit code, not either agent's words."
      />

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Btn variant="primary" onClick={start} disabled={isRunning || starting}>
          <Play className="w-4 h-4" /> {starting ? "Starting…" : "Start Live Two-Agent Comparison"}
        </Btn>
        <Btn variant="danger" onClick={cancel} disabled={!isRunning}>
          <Square className="w-4 h-4" /> Cancel
        </Btn>
        <Btn variant="secondary" onClick={reset} disabled={isRunning}>
          <RotateCcw className="w-4 h-4" /> Reset Demo
        </Btn>
        <Btn variant="secondary" onClick={openSource} disabled={!state?.workspaceDir}>
          <FileText className="w-4 h-4" /> View Source Code
        </Btn>
        <Btn variant="secondary" onClick={() => setShowDiff(true)} disabled={!state?.implementationDiff}>
          <GitCompare className="w-4 h-4" /> View Implementation Diff
        </Btn>
        <Btn variant="secondary" onClick={() => setShowLogs(true)} disabled={!state || state.events.length === 0}>
          <Terminal className="w-4 h-4" /> View Execution Logs
        </Btn>
        <Btn variant="secondary" onClick={() => setShowReport(true)} disabled={!isTerminal}>
          <ClipboardCheck className="w-4 h-4" /> View Final Verification Report
        </Btn>
      </div>

      {actionError && (
        <div className="mb-4 flex items-center gap-2 text-sm text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {actionError}
        </div>
      )}

      {!state && <EmptyState message="No run yet. Press Start Live Two-Agent Comparison to spawn two real claude CLI processes against a real tenant-isolation vulnerability." />}

      {state && (
        <>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
            Run: {state.runId || "none"} · Status: <span className="font-semibold">{state.status}</span>
            {state.workspaceDir ? ` · Workspace: ${state.workspaceDir}` : ""}
          </p>

          <div className="bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl p-4 mb-6">
            <h3 className="font-semibold text-xs uppercase tracking-wide text-zinc-500 mb-2 flex items-center gap-1.5">
              <ClipboardList className="w-3.5 h-3.5" /> Task Requirements (given to both agents, acceptance criteria only)
            </h3>
            <pre className="text-[11px] font-mono text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">
              {sourceFiles?.requirementsMd ?? "Fix tasks-api.js's GET /tasks handler so tenant scope is derived only from the authenticated caller, never from a client-supplied value, while keeping the existing positive-path test passing."}
            </pre>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <AgentPanel
              title="Claude A: Implementation Agent"
              subtitle="Read + Edit + Write + Bash. Genuinely fixes the code and may run tests itself."
              evidenceLabel="SELF-REPORTED"
              events={aEvents}
              outcome={state.agentA}
              accent="bg-indigo-600"
            />
            <AgentPanel
              title="Claude B: Independent Reviewer"
              subtitle="Read + Bash only, no Edit/Write. Reviews the resulting code, not Agent A's reasoning."
              evidenceLabel="REVIEWED"
              events={bEvents}
              outcome={state.agentB}
              accent="bg-teal-600"
            />
          </div>

          {systemEvents.length > 0 && (
            <div className="bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl p-4 mb-6 text-xs font-mono space-y-1">
              {systemEvents.map((e) => (
                <p key={e.seq} className={e.isError ? "text-red-600 dark:text-red-400" : "text-zinc-600 dark:text-zinc-300"}>
                  {e.text}
                </p>
              ))}
            </div>
          )}

          {isTerminal && (
            <div className="bg-white dark:bg-zinc-900 border-2 border-zinc-900 dark:border-zinc-100 rounded-xl p-5">
              <h3 className="font-semibold text-sm mb-3 text-zinc-900 dark:text-zinc-100">Final decision</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm mb-4">
                <div>
                  <p className="text-xs text-zinc-500 mb-1">
                    <span className="inline-block px-1.5 py-0.5 rounded bg-zinc-200 dark:bg-zinc-700 text-[10px] font-bold mr-1">SELF-REPORTED</span>
                    Agent A&apos;s own claim
                  </p>
                  <p className="font-semibold text-zinc-900 dark:text-zinc-100">{extractStatusLine(state.agentA?.resultText ?? null) ?? "no status"}</p>
                </div>
                <div>
                  <p className="text-xs text-zinc-500 mb-1">
                    <span className="inline-block px-1.5 py-0.5 rounded bg-zinc-200 dark:bg-zinc-700 text-[10px] font-bold mr-1">REVIEWED</span>
                    Agent B&apos;s own claim
                  </p>
                  <p className="font-semibold text-zinc-900 dark:text-zinc-100">{extractStatusLine(state.agentB?.resultText ?? null) ?? "no verdict"}</p>
                </div>
                <div>
                  <p className="text-xs text-zinc-500 mb-1">WorkerAI backend (authoritative, real exit code)</p>
                  <p className={`font-bold ${label ? LABEL_COPY[label].className : ""} inline-block px-2 py-0.5 rounded`}>
                    {label ? LABEL_COPY[label].text : "not run"}
                  </p>
                </div>
              </div>
              <p className="text-xs text-zinc-500">
                The backend verdict comes from an actual <code>npm test</code> re-execution against this run&apos;s final
                workspace state, independent of anything either Claude process said. A real implementation diff and the
                real command exit codes are available above.
              </p>
              <div className="flex gap-3 mt-3 text-[11px] text-zinc-500">
                <span>Real production equivalents:</span>
                {PRODUCTION_REFERENCES.map((r) => (
                  <a key={r.url} href={r.url} target="_blank" rel="noreferrer" className="underline hover:text-zinc-700 dark:hover:text-zinc-300">
                    {r.label}
                  </a>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {showSource && (
        <Modal title="Source Code (seeded fixture, current state)" onClose={() => setShowSource(false)} size="lg">
          {sourceFiles?.disclosure && (
            <p className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2 mb-3">
              {sourceFiles.disclosure}
            </p>
          )}
          <p className="text-xs font-semibold text-zinc-500 mb-1">tasks-api.js</p>
          <pre className="text-xs bg-zinc-950 text-zinc-100 rounded-lg p-3 overflow-x-auto mb-3">{sourceFiles?.tasksApiJs ?? "(no run yet)"}</pre>
          <p className="text-xs font-semibold text-zinc-500 mb-1">test.js</p>
          <pre className="text-xs bg-zinc-950 text-zinc-100 rounded-lg p-3 overflow-x-auto">{sourceFiles?.testJs ?? "(no run yet)"}</pre>
        </Modal>
      )}

      {showDiff && state && (
        <Modal title="Implementation Diff (real git diff vs. the vulnerable baseline)" onClose={() => setShowDiff(false)} size="lg">
          <pre className="text-[11px] bg-zinc-950 text-zinc-100 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
            {state.implementationDiff ?? "(no diff captured yet)"}
          </pre>
        </Modal>
      )}

      {showLogs && state && (
        <Modal title="Real Execution Logs (raw events)" onClose={() => setShowLogs(false)} size="xl">
          <pre className="text-[11px] bg-zinc-950 text-zinc-200 rounded-lg p-3 overflow-x-auto max-h-[60vh]">
            {JSON.stringify(state.events, null, 2)}
          </pre>
        </Modal>
      )}

      {showReport && state && (
        <Modal title="Final Verification Report" onClose={() => setShowReport(false)} size="lg">
          <div className="space-y-4 text-sm">
            <div>
              <p className="font-semibold text-zinc-900 dark:text-zinc-100 mb-1">WorkerAI backend verdict</p>
              <p className={`font-bold px-2 py-0.5 rounded inline-block ${label ? LABEL_COPY[label].className : ""}`}>
                {label ? LABEL_COPY[label].text : "not run (run was cancelled or errored before verification)"}
              </p>
            </div>
            {state.backendVerdict?.commands.map((c) => (
              <div key={c.label} className="border border-zinc-200 dark:border-zinc-700 rounded-lg p-3">
                <p className="font-mono text-xs text-zinc-500">
                  {c.label}: <code>{c.command}</code> → exit {c.exitCode ?? "n/a"} ({c.durationMs}ms)
                </p>
                {c.exitCode !== 0 && (
                  <pre className="text-[11px] bg-zinc-950 text-red-300 rounded p-2 mt-2 overflow-x-auto">{c.stderrSummary || c.stdoutSummary}</pre>
                )}
              </div>
            ))}
            <div>
              <p className="font-semibold text-zinc-900 dark:text-zinc-100 mb-1">Implementation diff</p>
              <pre className="text-[11px] bg-zinc-950 text-zinc-100 rounded-lg p-2 overflow-x-auto max-h-40 whitespace-pre-wrap">
                {state.implementationDiff ?? "n/a"}
              </pre>
            </div>
            <div>
              <p className="font-semibold text-zinc-900 dark:text-zinc-100 mb-1">Agent A&apos;s own text (SELF-REPORTED)</p>
              <p className="text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">{state.agentA?.resultText ?? "n/a"}</p>
            </div>
            <div>
              <p className="font-semibold text-zinc-900 dark:text-zinc-100 mb-1">Agent B&apos;s own text (REVIEWED)</p>
              <p className="text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">{state.agentB?.resultText ?? "n/a"}</p>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
