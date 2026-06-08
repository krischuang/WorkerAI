"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader, Btn, EmptyState } from "@/app/_components/ui";

interface Server {
  id: string;
  name: string;
  host: string;
  username: string;
  port: number;
  sshKeyPath: string;
  status: "unknown" | "connected" | "failed";
  lastCheckedAt: string | null;
  _count: { commandLogs: number };
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

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete server "${name}"?`)) return;
    await fetch(`/api/servers/${id}`, { method: "DELETE" });
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
                  onClick={() => handleDelete(s.id, s.name)}
                  className="text-xs text-red-700 hover:text-red-900 font-medium transition-colors px-1"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
