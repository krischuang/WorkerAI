"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader, Btn, FormField, inputCls } from "@/app/_components/ui";

interface Config {
  webhook_url: string;
  webhook_secret: string;
}

type TestStatus = "idle" | "sending" | "ok" | "error";

export default function NotificationsPage() {
  const [config, setConfig] = useState<Config>({ webhook_url: "", webhook_secret: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testDetail, setTestDetail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadConfig = useCallback(() => {
    fetch("/api/admin/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) {
          setConfig({
            webhook_url: data.webhook_url ?? "",
            webhook_secret: data.webhook_secret ?? "",
          });
        }
        setLoading(false);
      });
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    const res = await fetch("/api/admin/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        webhook_url: config.webhook_url.trim(),
        webhook_secret: config.webhook_secret.trim(),
      }),
    });
    setSaving(false);
    if (res.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Save failed");
    }
  }

  async function handleTest() {
    setTestStatus("sending");
    setTestDetail(null);
    const res = await fetch("/api/webhooks/test", { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      setTestStatus("ok");
      setTestDetail(`HTTP ${body.status ?? res.status} — delivery succeeded`);
    } else {
      setTestStatus("error");
      setTestDetail(body.error ?? `HTTP ${res.status}`);
    }
    setTimeout(() => setTestStatus("idle"), 6000);
  }

  if (loading) {
    return (
      <main className="flex-1 p-8">
        <PageHeader title="Notifications" subtitle="Webhook delivery settings" />
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-4">Loading…</p>
      </main>
    );
  }

  return (
    <main className="flex-1 p-8 max-w-2xl">
      <PageHeader
        title="Notifications"
        subtitle="Configure webhook delivery for task completions and failures"
      />

      <div className="mt-8 space-y-6">
        {/* Webhook URL */}
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-4">Webhook Endpoint</h2>

          <div className="space-y-4">
            <FormField
              label="Webhook URL"
              hint="Receives a POST when any task completes or fails. Discord and Slack webhook URLs are auto-detected and formatted as rich embeds."
            >
              <input
                type="url"
                value={config.webhook_url}
                onChange={(e) => setConfig((c) => ({ ...c, webhook_url: e.target.value }))}
                placeholder="https://hooks.slack.com/… or https://discord.com/api/webhooks/…"
                className={inputCls}
              />
            </FormField>

            <FormField
              label="Signing Secret"
              hint="Optional. When set, each request includes X-Webhook-Signature: sha256=<hmac> so you can verify authenticity."
            >
              <input
                type="password"
                value={config.webhook_secret}
                onChange={(e) => setConfig((c) => ({ ...c, webhook_secret: e.target.value }))}
                placeholder="Leave blank to disable signing"
                className={inputCls}
                autoComplete="new-password"
              />
            </FormField>
          </div>

          {error && (
            <p className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <div className="mt-5 flex items-center gap-3">
            <Btn variant="primary" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : saved ? "Saved ✓" : "Save"}
            </Btn>
            <Btn
              variant="secondary"
              onClick={handleTest}
              disabled={!config.webhook_url.trim() || testStatus === "sending"}
            >
              {testStatus === "sending" ? "Sending…" : "Test webhook"}
            </Btn>
          </div>

          {(testStatus === "ok" || testStatus === "error") && testDetail && (
            <p
              className={`mt-3 text-sm px-3 py-2 rounded-lg border ${
                testStatus === "ok"
                  ? "text-green-700 bg-green-50 border-green-200"
                  : "text-red-700 bg-red-50 border-red-200"
              }`}
            >
              {testStatus === "ok" ? "✓ " : "✗ "}
              {testDetail}
            </p>
          )}
        </div>

        {/* Payload reference */}
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">Payload Reference</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-3">
            Generic (non-Discord/Slack) endpoints receive this JSON body:
          </p>
          <pre className="text-xs bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-700 rounded-lg p-4 overflow-x-auto text-zinc-700 dark:text-zinc-300 leading-relaxed">{`{
  "event":       "task.completed" | "task.failed",
  "taskId":      "clxxx…",
  "title":       "Task title",
  "status":      "completed" | "failed",
  "projectId":   "clxxx…",
  "projectName": "My Project",
  "agentId":     "clxxx…" | null,
  "serverId":    "clxxx…" | null,
  "errorMessage": null | "Error details",
  "durationMs":  12345 | null,
  "timestamp":   "2025-01-01T00:00:00.000Z"
}`}</pre>

          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mt-5 mb-2">Signature verification</h3>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-2">
            When a secret is set, each request includes:
          </p>
          <pre className="text-xs bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-700 rounded-lg p-4 overflow-x-auto text-zinc-700 dark:text-zinc-300">{`X-Webhook-Signature: sha256=<hmac>
X-Webhook-Timestamp: <unix-ms>

// Compute: HMAC-SHA256(secret, "<timestamp>.<body>")`}</pre>

          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mt-5 mb-2">Discord / Slack</h3>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            URLs matching <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1 rounded">discord.com/api/webhooks</code> or{" "}
            <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1 rounded">hooks.slack.com</code> automatically receive
            rich embed / block-kit payloads instead of the raw JSON.
          </p>
        </div>
      </div>
    </main>
  );
}
