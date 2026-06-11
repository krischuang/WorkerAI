"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader, Btn, EmptyState, Modal, ModalActions } from "@/app/_components/ui";

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

interface Server {
  id: string;
  name: string;
  host: string;
  username: string;
  port: number;
  sshKeyPath: string;
  status: "unknown" | "connected" | "failed";
  claudePermissionMode: ClaudePermissionMode;
  lastCheckedAt: string | null;
  _count: { commandLogs: number };
  queuedCount: number;
  runningCount: number;
  pausedDueToUsage: boolean;
  claudeSessionResetsAt: string | null;
  claudeWeekResetsAt: string | null;
  capacityScore: number | null;
  activeTaskCount: number;
  maxConcurrentTasks: number;
  capacityUpdatedAt: string | null;
}

function resumeCountdown(sessionResetsAt: string | null, weekResetsAt: string | null): string | null {
  const now = Date.now();
  const candidates = [sessionResetsAt, weekResetsAt]
    .filter((s): s is string => s !== null)
    .map((s) => new Date(s).getTime())
    .filter((t) => t > now);
  if (candidates.length === 0) return null;
  const ms = Math.min(...candidates) - now;
  const totalMin = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours > 0) return `Resumes in ${hours}h ${mins}m`;
  return `Resumes in ${mins}m`;
}

const STATUS_BADGE: Record<string, string> = {
  unknown: "bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700",
  connected: "bg-green-50 text-green-700 border-green-200",
  failed: "bg-red-50 text-red-700 border-red-200",
};

const STATUS_DOT: Record<string, string> = {
  unknown: "bg-zinc-400",
  connected: "bg-green-500",
  failed: "bg-red-500",
};

function capacityBarColor(score: number): string {
  if (score >= 60) return "bg-green-500";
  if (score >= 30) return "bg-amber-400";
  return "bg-red-500";
}

export default function ServersPage() {
  const [servers, setServers] = useState<Server[]>([]);
  const [testing, setTesting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [resuming, setResuming] = useState<string | null>(null);

  function loadServers() {
    fetch("/api/servers")
      .then((r) => r.json())
      .then(setServers);
  }

  useEffect(() => {
    loadServers();
  }, []);

  async function testConnection(id: string) {
    setTesting(id);
    await fetch(`/api/servers/${id}/connect`, { method: "POST" });
    setTesting(null);
    loadServers();
  }

  async function handleResume(id: string) {
    setResuming(id);
    await fetch(`/api/servers/${id}/resume`, { method: "POST" });
    setResuming(null);
    loadServers();
  }

  async function doDelete() {
    if (!confirmDelete) return;
    setDeleting(true);
    await fetch(`/api/servers/${confirmDelete.id}`, { method: "DELETE" });
    setDeleting(false);
    setConfirmDelete(null);
    loadServers();
  }

  return (
    <div className="p-8 max-w-4xl">
      <PageHeader
        title="Servers"
        subtitle="AWS EC2 servers connected via SSH"
        action={
          <Link
            href="/servers/new"
            className="inline-flex items-center justify-center bg-zinc-900 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-zinc-800 transition-colors"
          >
            + Add Server
          </Link>
        }
      />

      {servers.length === 0 ? (
        <EmptyState
          message="No servers configured yet."
          action={
            <Link
              href="/servers/new"
              className="inline-flex items-center text-sm text-blue-700 hover:text-blue-900 font-medium transition-colors"
            >
              Add your first AWS EC2 server →
            </Link>
          }
        />
      ) : (
        <div className="space-y-3">
          {servers.map((s) => (
            <div
              key={s.id}
              className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-5 flex items-center gap-4 hover:border-zinc-300 dark:border-zinc-600 transition-colors"
            >
              <span
                className={`shrink-0 w-2.5 h-2.5 rounded-full ${STATUS_DOT[s.status]}`}
                aria-hidden="true"
              />

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Link
                    href={`/servers/${s.id}`}
                    className="font-semibold text-zinc-900 dark:text-zinc-100 hover:text-blue-700 transition-colors"
                  >
                    {s.name}
                  </Link>
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[s.status]}`}
                  >
                    {s.status}
                  </span>
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                      PERMISSION_MODE_BADGE[s.claudePermissionMode ?? "workspace_write"]
                    }`}
                  >
                    {PERMISSION_MODE_LABEL[s.claudePermissionMode ?? "workspace_write"]}
                  </span>
                  {s.queuedCount > 0 && (
                    <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-violet-50 text-violet-700 border-violet-200">
                      {s.queuedCount} queued
                    </span>
                  )}
                  {s.runningCount > 0 && (
                    <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-blue-50 text-blue-700 border-blue-200">
                      {s.runningCount} running
                    </span>
                  )}
                  {s.pausedDueToUsage && (
                    <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-amber-50 text-amber-700 border-amber-200">
                      ⏸ usage paused
                    </span>
                  )}
                </div>
                <p className="text-sm text-zinc-700 dark:text-zinc-300 mt-0.5 font-mono">
                  {s.username}@{s.host}:{s.port}
                </p>
                <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5">
                  Key: {s.sshKeyPath}
                  {s.lastCheckedAt && (
                    <span className="ml-3 text-zinc-600 dark:text-zinc-400">
                      Last checked: {new Date(s.lastCheckedAt).toLocaleString()}
                    </span>
                  )}
                </p>
                {s.capacityScore !== null && (
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="flex-1 max-w-[160px] h-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${capacityBarColor(s.capacityScore)}`}
                        style={{ width: `${s.capacityScore}%` }}
                      />
                    </div>
                    <span className="text-xs text-zinc-600 dark:text-zinc-400">
                      {Math.round(s.capacityScore)}% capacity · {s.activeTaskCount}/{s.maxConcurrentTasks} tasks
                    </span>
                  </div>
                )}
                {s.pausedDueToUsage && (() => {
                  const cd = resumeCountdown(s.claudeSessionResetsAt, s.claudeWeekResetsAt);
                  return cd ? (
                    <p className="text-xs text-amber-600 mt-0.5 font-medium">{cd}</p>
                  ) : null;
                })()}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-zinc-600 dark:text-zinc-400 font-medium">{s._count.commandLogs} logs</span>
                {s.pausedDueToUsage && (
                  <Btn
                    size="sm"
                    variant="secondary"
                    disabled={resuming === s.id}
                    onClick={() => handleResume(s.id)}
                  >
                    {resuming === s.id ? "Resuming…" : "Resume"}
                  </Btn>
                )}
                <Btn
                  size="sm"
                  variant="secondary"
                  disabled={testing === s.id}
                  onClick={() => testConnection(s.id)}
                >
                  {testing === s.id ? "Testing…" : "Test SSH"}
                </Btn>
                <Link
                  href={`/servers/${s.id}`}
                  className="inline-flex items-center text-xs text-zinc-700 dark:text-zinc-300 border border-zinc-300 dark:border-zinc-600 px-3 py-1.5 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-800 dark:bg-zinc-950 font-medium transition-colors"
                >
                  Open
                </Link>
                <button
                  onClick={() => setConfirmDelete({ id: s.id, name: s.name })}
                  className="text-xs text-red-700 hover:text-red-900 font-medium transition-colors px-1"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {confirmDelete && (
        <Modal title="Delete Server" onClose={() => setConfirmDelete(null)}>
          <p className="text-sm text-zinc-700 dark:text-zinc-300 mb-1">
            Delete server <strong>{confirmDelete.name}</strong>?
          </p>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
            All command logs will be permanently deleted. Assigned tasks will be unassigned.
            This cannot be undone.
          </p>
          <ModalActions>
            <Btn variant="secondary" onClick={() => setConfirmDelete(null)}>Cancel</Btn>
            <Btn variant="danger" onClick={doDelete} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete Server"}
            </Btn>
          </ModalActions>
        </Modal>
      )}
    </div>
  );
}
