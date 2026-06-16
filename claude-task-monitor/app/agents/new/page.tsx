"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  PageHeader, BackLink, Btn, FormField, inputCls, ModalActions,
} from "@/app/_components/ui";

interface Server {
  id: string;
  name: string;
  host: string;
}

const PERMISSION_MODES = [
  { value: "workspace_write", label: "Workspace Write (default)" },
  { value: "read_only",       label: "Read Only" },
  { value: "full_autonomous", label: "Full Autonomous (--dangerously-skip-permissions)" },
];

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export default function NewAgentPage() {
  const router = useRouter();
  const [servers, setServers] = useState<Server[]>([]);
  const [serverId, setServerId] = useState("");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [workDir, setWorkDir] = useState("");
  const [tmuxSession, setTmuxSession] = useState("");
  const [mode, setMode] = useState("workspace_write");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/servers")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data) setServers(data); });
  }, []);

  // Auto-derive slug, workDir, and tmuxSession from name
  function handleNameChange(v: string) {
    setName(v);
    const s = slugify(v);
    setSlug(s);
    setWorkDir(`/home/ec2-user/claude-agents/${s}`);
    setTmuxSession(`claude-${s}`);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!serverId) { setError("Please select a server"); return; }

    setSaving(true);
    const res = await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId, name, slug, workDir, tmuxSession, claudePermissionMode: mode }),
    });
    const data = await res.json();
    setSaving(false);

    if (!res.ok) { setError(data.error ?? "Failed to create agent"); return; }
    router.push(`/agents/${data.id}`);
  }

  return (
    <div className="p-6 max-w-xl">
      <BackLink href="/agents" label="Agents" />
      <PageHeader title="New Agent" subtitle="Add a Claude CLI agent with its own isolated auth and session." />

      <form onSubmit={handleSubmit} className="space-y-5">
        <FormField label="Server" required>
          <select
            value={serverId}
            onChange={(e) => setServerId(e.target.value)}
            className={inputCls}
            required
          >
            <option value="">Select a server…</option>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>{s.name} ({s.host})</option>
            ))}
          </select>
        </FormField>

        <FormField label="Agent name" hint="Human-readable display name (e.g. agent-1)" required>
          <input
            type="text"
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            placeholder="agent-1"
            className={inputCls}
            required
          />
        </FormField>

        <FormField label="Slug" hint="Lowercase alphanumeric + hyphens — used in paths and session names" required>
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="agent-1"
            className={`${inputCls} font-mono`}
            required
          />
        </FormField>

        <FormField
          label="Working directory (HOME)"
          hint="Claude CLI config (~/.claude/) will be stored here. Must exist on the server."
          required
        >
          <input
            type="text"
            value={workDir}
            onChange={(e) => setWorkDir(e.target.value)}
            placeholder="/home/ec2-user/claude-agents/agent-1"
            className={`${inputCls} font-mono`}
            required
          />
        </FormField>

        <FormField label="tmux session name" hint="Name for the tmux session on the server" required>
          <input
            type="text"
            value={tmuxSession}
            onChange={(e) => setTmuxSession(e.target.value)}
            placeholder="claude-agent-1"
            className={`${inputCls} font-mono`}
            required
          />
        </FormField>

        <FormField label="Permission mode">
          <select value={mode} onChange={(e) => setMode(e.target.value)} className={inputCls}>
            {PERMISSION_MODES.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </FormField>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="rounded-md bg-amber-50 border border-amber-200 p-4 text-sm text-amber-800 space-y-1">
          <p className="font-medium">Setup required on the server</p>
          <p>After creating this agent, SSH in and run:</p>
          <pre className="mt-2 text-xs font-mono bg-amber-100 rounded p-2 whitespace-pre-wrap">{`mkdir -p ${workDir || "/home/ec2-user/claude-agents/agent-1"}
HOME=${workDir || "/home/ec2-user/claude-agents/agent-1"} claude login`}</pre>
          <p>This authenticates Claude CLI for this agent independently.</p>
          <p>Then click <strong>Launch Claude</strong> on the agent detail page.</p>
        </div>

        <ModalActions>
          <Btn type="button" variant="secondary" onClick={() => router.push("/agents")}>Cancel</Btn>
          <Btn type="submit" variant="primary" disabled={saving}>{saving ? "Creating…" : "Create Agent"}</Btn>
        </ModalActions>
      </form>
    </div>
  );
}
