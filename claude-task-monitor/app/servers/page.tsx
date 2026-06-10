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
  read_only:        "bg-zinc-100 text-zinc-700 border-zinc-200",
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
}

const STATUS_BADGE: Record<string, string> = {
  unknown: "bg-zinc-100 text-zinc-700 border-zinc-200",
  connected: "bg-green-50 text-green-700 border-green-200",
  failed: "bg-red-50 text-red-700 border-red-200",
};

const STATUS_DOT: Record<string, string> = {
  unknown: "bg-zinc-400",
  connected: "bg-green-500",
  failed: "bg-red-500",
};

export default function ServersPage() {
  const [servers, setServers] = useState<Server[]>([]);
  const [testing, setTesting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

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
              className="bg-white rounded-xl border border-zinc-200 p-5 flex items-center gap-4 hover:border-zinc-300 transition-colors"
            >
              <span
                className={`shrink-0 w-2.5 h-2.5 rounded-full ${STATUS_DOT[s.status]}`}
                aria-hidden="true"
              />

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Link
                    href={`/servers/${s.id}`}
                    className="font-semibold text-zinc-900 hover:text-blue-700 transition-colors"
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
                </div>
                <p className="text-sm text-zinc-700 mt-0.5 font-mono">
                  {s.username}@{s.host}:{s.port}
                </p>
                <p className="text-xs text-zinc-600 mt-0.5">
                  Key: {s.sshKeyPath}
                  {s.lastCheckedAt && (
                    <span className="ml-3 text-zinc-600">
                      Last checked: {new Date(s.lastCheckedAt).toLocaleString()}
                    </span>
                  )}
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-zinc-600 font-medium">{s._count.commandLogs} logs</span>
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
                  className="inline-flex items-center text-xs text-zinc-700 border border-zinc-300 px-3 py-1.5 rounded-lg hover:bg-zinc-50 font-medium transition-colors"
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
          <p className="text-sm text-zinc-700 mb-1">
            Delete server <strong>{confirmDelete.name}</strong>?
          </p>
          <p className="text-sm text-zinc-600 mb-4">
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
