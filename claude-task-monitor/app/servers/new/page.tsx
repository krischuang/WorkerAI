"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { BackLink, Btn, FormField, inputCls } from "@/app/_components/ui";

export default function NewServerPage() {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    host: "",
    username: "ec2-user",
    port: "22",
    sshKeyPath: "~/.ssh/",
    claudePermissionMode: "workspace_write",
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);

    const res = await fetch("/api/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, port: Number(form.port) }),
    });

    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Failed to save server");
      setSaving(false);
      return;
    }

    const server = await res.json();
    router.push(`/servers/${server.id}`);
  }

  return (
    <div className="p-8 max-w-xl">
      <BackLink href="/servers" label="Servers" />

      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100 mb-6">
        Add AWS EC2 Server
      </h1>

      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6 text-sm text-amber-800">
        <strong>Security note:</strong> Only the path to your SSH key is stored — never the key content itself. The key is read from the local filesystem when a connection is made.
      </div>

      <form onSubmit={handleSubmit} className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-6 space-y-5">
        <FormField label="Server Name" required>
          <input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="e.g. Production EC2"
            className={inputCls}
          />
        </FormField>

        <FormField label="Host / IP Address" required>
          <input
            required
            value={form.host}
            onChange={(e) => setForm({ ...form, host: e.target.value })}
            placeholder="e.g. ec2-12-34-56-78.compute-1.amazonaws.com"
            className={`${inputCls} font-mono`}
          />
        </FormField>

        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <FormField
              label="Username"
              required
              hint="Amazon Linux: ec2-user · Ubuntu: ubuntu"
            >
              <input
                required
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                placeholder="ec2-user"
                className={`${inputCls} font-mono`}
              />
            </FormField>
          </div>
          <div>
            <FormField label="Port">
              <input
                required
                type="number"
                min={1}
                max={65535}
                value={form.port}
                onChange={(e) => setForm({ ...form, port: e.target.value })}
                className={`${inputCls} font-mono`}
              />
            </FormField>
          </div>
        </div>

        <FormField
          label="SSH Key Path"
          required
          hint="Absolute path or ~/path from home directory. The key must be readable by this app's process."
        >
          <input
            required
            value={form.sshKeyPath}
            onChange={(e) => setForm({ ...form, sshKeyPath: e.target.value })}
            placeholder="~/.ssh/my-aws-key.pem"
            className={`${inputCls} font-mono`}
          />
        </FormField>

        <FormField
          label="Claude Execution Mode"
          hint="Controls which flags are passed when launching Claude CLI on this server."
        >
          <select
            value={form.claudePermissionMode}
            onChange={(e) => setForm({ ...form, claudePermissionMode: e.target.value })}
            className={inputCls}
          >
            <option value="read_only">Read Only — analyze files, no writes or shell</option>
            <option value="workspace_write">Workspace Write — edit files, prompts before risky ops</option>
            <option value="full_autonomous">Full Autonomous — skip all permission prompts</option>
          </select>
        </FormField>

        {form.claudePermissionMode === "full_autonomous" && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
            <strong>Warning:</strong> Full Autonomous mode passes <code className="font-mono bg-amber-100 px-1 rounded">--dangerously-skip-permissions</code> to Claude CLI.
            Claude will execute shell commands, modify files, and run installs without asking for confirmation.
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <Btn type="submit" variant="primary" disabled={saving} className="flex-1">
            {saving ? "Saving…" : "Add Server"}
          </Btn>
          <Link
            href="/servers"
            className="flex-1 text-center border border-zinc-300 dark:border-zinc-600 text-zinc-800 dark:text-zinc-200 text-sm font-medium py-2 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-800 dark:bg-zinc-950 transition-colors"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
