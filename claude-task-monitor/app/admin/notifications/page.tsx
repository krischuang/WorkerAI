"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader, Btn, FormField, inputCls } from "@/app/_components/ui";

interface Config {
  webhook_url: string;
  webhook_secret: string;
  smtp_host: string;
  smtp_port: string;
  smtp_user: string;
  smtp_from: string;
  alert_email_to: string;
}

type RegenerateStatus = "idle" | "confirming" | "regenerating" | "done" | "error";

interface WebhookDelivery {
  timestamp: string;
  status: string;
}

interface WebhookFailure {
  timestamp: string;
  eventType: string;
  statusCode: number | null;
  error: string;
}

interface WebhookStatus {
  configured: boolean;
  lastDelivery: WebhookDelivery | null;
  lastFailure: WebhookFailure | null;
}

type TestStatus = "idle" | "sending" | "ok" | "error";
type EmailTestStatus = "idle" | "sending" | "ok" | "error";

function formatTs(iso: string): string {
  return new Date(iso).toLocaleString();
}

export default function NotificationsPage() {
  const [config, setConfig] = useState<Config>({
    webhook_url: "", webhook_secret: "",
    smtp_host: "", smtp_port: "587", smtp_user: "", smtp_from: "", alert_email_to: "",
  });
  const [smtpPass, setSmtpPass] = useState("");
  const [emailTestStatus, setEmailTestStatus] = useState<EmailTestStatus>("idle");
  const [emailTestDetail, setEmailTestDetail] = useState<string | null>(null);
  const [webhookStatus, setWebhookStatus] = useState<WebhookStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testDetail, setTestDetail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signingSecret, setSigningSecret] = useState<string | null>(null);
  const [regenerateStatus, setRegenerateStatus] = useState<RegenerateStatus>("idle");

  const loadConfig = useCallback(() => {
    Promise.all([
      fetch("/api/admin/config").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/admin/webhook-status").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/admin/webhook-signing-secret").then((r) => (r.ok ? r.json() : null)),
    ]).then(([configData, statusData, secretData]) => {
      if (configData) {
        setConfig({
          webhook_url: configData.webhook_url ?? "",
          webhook_secret: configData.webhook_secret ?? "",
          smtp_host: configData.smtp_host ?? "",
          smtp_port: configData.smtp_port ?? "587",
          smtp_user: configData.smtp_user ?? "",
          smtp_from: configData.smtp_from ?? "",
          alert_email_to: configData.alert_email_to ?? "",
        });
      }
      if (statusData) {
        setWebhookStatus(statusData as WebhookStatus);
      }
      if (secretData) {
        setSigningSecret((secretData as { secret: string | null }).secret);
      }
      setLoading(false);
    });
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    const body: Record<string, string> = {
      webhook_url: config.webhook_url.trim(),
      webhook_secret: config.webhook_secret.trim(),
      smtp_host: config.smtp_host.trim(),
      smtp_port: config.smtp_port.trim() || "587",
      smtp_user: config.smtp_user.trim(),
      smtp_from: config.smtp_from.trim(),
      alert_email_to: config.alert_email_to.trim(),
    };
    // Only send smtp_pass if the user typed something (empty = don't overwrite stored value)
    if (smtpPass.trim()) body.smtp_pass = smtpPass.trim();

    const res = await fetch("/api/admin/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
    setTimeout(() => {
      setTestStatus("idle");
      // Refresh status after test
      fetch("/api/admin/webhook-status")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => { if (data) setWebhookStatus(data as WebhookStatus); });
    }, 6000);
  }

  async function handleTestEmail() {
    setEmailTestStatus("sending");
    setEmailTestDetail(null);
    const res = await fetch("/api/admin/test-email", { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      setEmailTestStatus("ok");
      setEmailTestDetail(`Test email sent to ${config.alert_email_to}`);
    } else {
      setEmailTestStatus("error");
      setEmailTestDetail((body as { error?: string }).error ?? `HTTP ${res.status}`);
    }
    setTimeout(() => setEmailTestStatus("idle"), 8000);
  }

  async function handleRegenerate() {
    if (regenerateStatus === "idle") { setRegenerateStatus("confirming"); return; }
    if (regenerateStatus !== "confirming") return;
    setRegenerateStatus("regenerating");
    const res = await fetch("/api/admin/webhook-signing-secret", { method: "POST" });
    if (res.ok) {
      const data = await res.json() as { secret: string };
      setSigningSecret(data.secret);
      setRegenerateStatus("done");
      setTimeout(() => setRegenerateStatus("idle"), 5000);
    } else {
      setRegenerateStatus("error");
      setTimeout(() => setRegenerateStatus("idle"), 5000);
    }
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

        {/* Delivery status */}
        {webhookStatus && (
          <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl p-6">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-4">Delivery Status</h2>

            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-sm text-zinc-600 dark:text-zinc-400 w-28 shrink-0">Configured</span>
                <span
                  className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                    webhookStatus.configured
                      ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                      : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                  }`}
                >
                  {webhookStatus.configured ? "Yes" : "No"}
                </span>
              </div>

              <div className="flex items-start gap-2">
                <span className="text-sm text-zinc-600 dark:text-zinc-400 w-28 shrink-0">Last delivery</span>
                {webhookStatus.lastDelivery ? (
                  <div>
                    <span className="text-sm text-zinc-900 dark:text-zinc-100">
                      {formatTs(webhookStatus.lastDelivery.timestamp)}
                    </span>
                    <span className="ml-2 text-xs font-medium px-2 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                      {webhookStatus.lastDelivery.status}
                    </span>
                  </div>
                ) : (
                  <span className="text-sm text-zinc-500 dark:text-zinc-500">No deliveries yet</span>
                )}
              </div>

              <div className="flex items-start gap-2">
                <span className="text-sm text-zinc-600 dark:text-zinc-400 w-28 shrink-0">Last failure</span>
                {webhookStatus.lastFailure ? (
                  <div className="space-y-1">
                    <div>
                      <span className="text-sm text-zinc-900 dark:text-zinc-100">
                        {formatTs(webhookStatus.lastFailure.timestamp)}
                      </span>
                      <span className="ml-2 text-xs text-zinc-600 dark:text-zinc-400">
                        {webhookStatus.lastFailure.eventType}
                      </span>
                    </div>
                    <p className="text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded px-2 py-1">
                      {webhookStatus.lastFailure.statusCode != null
                        ? `HTTP ${webhookStatus.lastFailure.statusCode} — `
                        : ""}
                      {webhookStatus.lastFailure.error}
                    </p>
                  </div>
                ) : (
                  <span className="text-sm text-zinc-500 dark:text-zinc-500">No failures recorded</span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* SMTP Email */}
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-1">Email Alerts (SMTP)</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
            Send email alerts for task failures, stalled tasks, and unhealthy workers. Gate on smtp_host being set.
          </p>

          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <FormField label="SMTP Host" hint="e.g. smtp.gmail.com · leave blank to disable email alerts">
                  <input
                    type="text"
                    value={config.smtp_host}
                    onChange={(e) => setConfig((c) => ({ ...c, smtp_host: e.target.value }))}
                    placeholder="smtp.example.com"
                    className={inputCls}
                  />
                </FormField>
              </div>
              <FormField label="Port">
                <input
                  type="number"
                  value={config.smtp_port}
                  onChange={(e) => setConfig((c) => ({ ...c, smtp_port: e.target.value }))}
                  placeholder="587"
                  className={inputCls}
                />
              </FormField>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormField label="SMTP Username">
                <input
                  type="text"
                  value={config.smtp_user}
                  onChange={(e) => setConfig((c) => ({ ...c, smtp_user: e.target.value }))}
                  placeholder="alerts@example.com"
                  className={inputCls}
                  autoComplete="off"
                />
              </FormField>
              <FormField label="SMTP Password" hint="Leave blank to keep existing password">
                <input
                  type="password"
                  value={smtpPass}
                  onChange={(e) => setSmtpPass(e.target.value)}
                  placeholder="••••••••"
                  className={inputCls}
                  autoComplete="new-password"
                />
              </FormField>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormField label="From Address" hint="Defaults to SMTP Username if blank">
                <input
                  type="email"
                  value={config.smtp_from}
                  onChange={(e) => setConfig((c) => ({ ...c, smtp_from: e.target.value }))}
                  placeholder="alerts@example.com"
                  className={inputCls}
                />
              </FormField>
              <FormField label="Alert Recipient (To)" hint="Where alerts are sent">
                <input
                  type="email"
                  value={config.alert_email_to}
                  onChange={(e) => setConfig((c) => ({ ...c, alert_email_to: e.target.value }))}
                  placeholder="oncall@example.com"
                  className={inputCls}
                />
              </FormField>
            </div>
          </div>

          <div className="mt-5 flex items-center gap-3">
            <Btn
              variant="secondary"
              onClick={handleTestEmail}
              disabled={!config.smtp_host.trim() || !config.alert_email_to.trim() || emailTestStatus === "sending"}
            >
              {emailTestStatus === "sending" ? "Sending…" : "Send test email"}
            </Btn>
            <span className="text-xs text-zinc-500">Save settings first, then test</span>
          </div>

          {(emailTestStatus === "ok" || emailTestStatus === "error") && emailTestDetail && (
            <p
              className={`mt-3 text-sm px-3 py-2 rounded-lg border ${
                emailTestStatus === "ok"
                  ? "text-green-700 bg-green-50 border-green-200"
                  : "text-red-700 bg-red-50 border-red-200"
              }`}
            >
              {emailTestStatus === "ok" ? "✓ " : "✗ "}
              {emailTestDetail}
            </p>
          )}
        </div>

        {/* Webhook Signing Secret */}
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-1">Webhook Signing</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
            Every outbound webhook includes{" "}
            <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1 rounded">X-WorkerAI-Signature: sha256=&lt;hmac&gt;</code>.
            Rotate the secret below if it is ever compromised.
          </p>

          <div className="mb-4">
            <p className="text-xs text-zinc-600 dark:text-zinc-400 mb-1">Current secret</p>
            <code className="block text-xs font-mono bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2 text-zinc-700 dark:text-zinc-300 break-all select-all">
              {signingSecret
                ? `${signingSecret.slice(0, 8)}${"•".repeat(signingSecret.length - 8)}`
                : <span className="text-zinc-400 italic">not yet generated — will be created on first webhook delivery</span>}
            </code>
          </div>

          <div className="flex items-center gap-3">
            <Btn
              variant={regenerateStatus === "confirming" ? "danger" : "secondary"}
              onClick={handleRegenerate}
              disabled={regenerateStatus === "regenerating"}
            >
              {regenerateStatus === "idle" && "Regenerate signing secret"}
              {regenerateStatus === "confirming" && "Click again to confirm rotation"}
              {regenerateStatus === "regenerating" && "Regenerating…"}
              {regenerateStatus === "done" && "Rotated ✓"}
              {regenerateStatus === "error" && "Rotation failed"}
            </Btn>
            {regenerateStatus === "confirming" && (
              <span className="text-xs text-amber-700 dark:text-amber-400">
                Existing receivers will break until updated.
              </span>
            )}
          </div>

          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mt-5 mb-2">Verification (Node.js)</h3>
          <pre className="text-xs bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-700 rounded-lg p-4 overflow-x-auto text-zinc-700 dark:text-zinc-300 leading-relaxed">{`const crypto = require("crypto");

function verifyWorkerAISignature(rawBody, sigHeader, secret) {
  const expected = "sha256=" + crypto
    .createHmac("sha256", secret)
    .update(rawBody)       // raw request body bytes
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(sigHeader),
    Buffer.from(expected),
  );
}

// Express example
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["x-workerai-signature"];
  if (!verifyWorkerAISignature(req.body, sig, process.env.SIGNING_SECRET)) {
    return res.status(401).send("Invalid signature");
  }
  const payload = JSON.parse(req.body);
  // ...
});`}</pre>
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
