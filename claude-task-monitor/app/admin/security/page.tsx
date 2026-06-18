"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader, Btn, inputCls } from "@/app/_components/ui";
import { ShieldCheck, ShieldOff, RefreshCw, KeyRound } from "lucide-react";

interface TotpStatus {
  enabled: boolean;
  setupUri?: string;
  qrDataUrl?: string;
  secret?: string;
}

export default function AdminSecurityPage() {
  const [status, setStatus] = useState<TotpStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState("");
  const [confirmCode, setConfirmCode] = useState("");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);

  // Key rotation state
  const [rotateOldKey, setRotateOldKey] = useState("");
  const [rotateNewKey, setRotateNewKey] = useState("");
  const [rotateWorking, setRotateWorking] = useState(false);
  const [rotateMessage, setRotateMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/admin/totp")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: TotpStatus | null) => {
        if (data) setStatus(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleEnable(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    setWorking(true);
    try {
      const res = await fetch("/api/admin/totp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.replace(/\s/g, "") }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setMessage({ type: "success", text: "Two-factor authentication is now enabled." });
        setCode("");
        load();
      } else {
        setMessage({ type: "error", text: body.error || "Failed to enable 2FA" });
      }
    } catch {
      setMessage({ type: "error", text: "Could not reach the server" });
    } finally {
      setWorking(false);
    }
  }

  async function handleDisable(e: React.FormEvent) {
    e.preventDefault();
    if (confirmCode !== "DISABLE") return;
    setMessage(null);
    setWorking(true);
    try {
      const res = await fetch("/api/admin/totp", { method: "DELETE" });
      if (res.ok) {
        setMessage({ type: "success", text: "Two-factor authentication has been disabled." });
        setShowDisableConfirm(false);
        setConfirmCode("");
        load();
      } else {
        const body = await res.json().catch(() => ({}));
        setMessage({ type: "error", text: body.error || "Failed to disable 2FA" });
      }
    } catch {
      setMessage({ type: "error", text: "Could not reach the server" });
    } finally {
      setWorking(false);
    }
  }

  async function handleRefreshSecret() {
    // Delete pending secret so GET generates a fresh one.
    setLoading(true);
    try {
      await fetch("/api/admin/totp", { method: "DELETE" });
    } catch { /* ignore */ }
    load();
  }

  async function handleRotateKey(e: React.FormEvent) {
    e.preventDefault();
    setRotateMessage(null);
    setRotateWorking(true);
    try {
      const res = await fetch("/api/admin/secrets/rotate-key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oldKey: rotateOldKey, newKey: rotateNewKey }),
      });
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (res.ok) {
        const migrated = typeof body.migrated === "number" ? body.migrated : 0;
        setRotateMessage({
          type: "success",
          text: `Re-encrypted ${migrated} secret row(s). Update TASK_SECRET_KEY to the new key and restart the server.`,
        });
        setRotateOldKey("");
        setRotateNewKey("");
      } else {
        setRotateMessage({ type: "error", text: String(body.error || "Key rotation failed") });
      }
    } catch {
      setRotateMessage({ type: "error", text: "Could not reach the server" });
    } finally {
      setRotateWorking(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto py-8 px-4 space-y-8">
      <PageHeader
        title="Security"
        subtitle="Manage two-factor authentication for the admin panel."
      />

      {message && (
        <div
          className={`rounded-lg px-4 py-3 text-sm ${
            message.type === "success"
              ? "bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300"
              : "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300"
          }`}
        >
          {message.text}
        </div>
      )}

      {loading && (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      )}

      {!loading && status && (
        <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-6 space-y-6">
          {/* Status banner */}
          <div className="flex items-center gap-3">
            {status.enabled ? (
              <>
                <ShieldCheck className="w-5 h-5 text-green-600 dark:text-green-400 shrink-0" />
                <div>
                  <p className="font-medium text-zinc-900 dark:text-zinc-100">2FA is enabled</p>
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">
                    A TOTP code is required after each password login.
                  </p>
                </div>
              </>
            ) : (
              <>
                <ShieldOff className="w-5 h-5 text-amber-500 shrink-0" />
                <div>
                  <p className="font-medium text-zinc-900 dark:text-zinc-100">2FA is not enabled</p>
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">
                    Only the admin password protects this panel. Enable 2FA for stronger security.
                  </p>
                </div>
              </>
            )}
          </div>

          {/* Setup flow */}
          {!status.enabled && status.qrDataUrl && (
            <form onSubmit={handleEnable} className="space-y-5 border-t border-zinc-100 dark:border-zinc-800 pt-5">
              <div>
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">
                  Step 1 — Scan the QR code
                </h2>
                <div className="inline-block p-3 bg-white rounded-lg border border-zinc-200">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={status.qrDataUrl} alt="TOTP QR code" width={200} height={200} />
                </div>
                <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                  Scan with Google Authenticator, Authy, 1Password, or any TOTP-compatible app.
                </p>
                {status.secret && (
                  <details className="mt-2">
                    <summary className="text-xs text-zinc-500 dark:text-zinc-400 cursor-pointer hover:text-zinc-700 dark:hover:text-zinc-300">
                      Can&apos;t scan? Enter the key manually
                    </summary>
                    <code className="block mt-1 text-xs font-mono bg-zinc-100 dark:bg-zinc-800 px-3 py-2 rounded break-all">
                      {status.secret}
                    </code>
                  </details>
                )}
              </div>

              <div>
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
                  Step 2 — Confirm with a code
                </h2>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9 ]*"
                  maxLength={7}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="000 000"
                  className={`${inputCls} font-mono tracking-widest max-w-xs`}
                  autoComplete="one-time-code"
                  required
                />
              </div>

              <div className="flex items-center gap-3">
                <Btn
                  variant="primary"
                  size="md"
                  type="submit"
                  disabled={working || code.replace(/\s/g, "").length < 6}
                >
                  {working ? "Enabling…" : "Enable 2FA"}
                </Btn>
                <button
                  type="button"
                  onClick={handleRefreshSecret}
                  className="inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                >
                  <RefreshCw className="w-3 h-3" />
                  Generate new secret
                </button>
              </div>
            </form>
          )}

          {/* Disable flow */}
          {status.enabled && !showDisableConfirm && (
            <div className="border-t border-zinc-100 dark:border-zinc-800 pt-5">
              <Btn
                variant="danger"
                size="sm"
                onClick={() => { setShowDisableConfirm(true); setMessage(null); }}
              >
                Disable 2FA
              </Btn>
            </div>
          )}

          {status.enabled && showDisableConfirm && (
            <form onSubmit={handleDisable} className="space-y-4 border-t border-zinc-100 dark:border-zinc-800 pt-5">
              <p className="text-sm text-zinc-700 dark:text-zinc-300">
                Type <strong>DISABLE</strong> to confirm removing two-factor authentication.
              </p>
              <input
                type="text"
                value={confirmCode}
                onChange={(e) => setConfirmCode(e.target.value)}
                placeholder="DISABLE"
                className={`${inputCls} max-w-xs`}
              />
              <div className="flex items-center gap-3">
                <Btn
                  variant="danger"
                  size="sm"
                  type="submit"
                  disabled={working || confirmCode !== "DISABLE"}
                >
                  {working ? "Disabling…" : "Confirm disable"}
                </Btn>
                <Btn
                  variant="secondary"
                  size="sm"
                  type="button"
                  onClick={() => { setShowDisableConfirm(false); setConfirmCode(""); }}
                >
                  Cancel
                </Btn>
              </div>
            </form>
          )}
        </div>
      )}
      {/* ── Task Secret Key Rotation ─────────────────────────────────── */}
      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 p-6 space-y-4">
        <div className="flex items-center gap-3">
          <KeyRound className="w-5 h-5 text-zinc-600 dark:text-zinc-400 shrink-0" />
          <div>
            <p className="font-medium text-zinc-900 dark:text-zinc-100">Task Secret Key Rotation</p>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Re-encrypt all stored task secrets when rotating <code className="font-mono text-xs bg-zinc-100 dark:bg-zinc-800 px-1 rounded">TASK_SECRET_KEY</code>.
            </p>
          </div>
        </div>

        <div className="text-sm text-zinc-600 dark:text-zinc-400 space-y-1 bg-zinc-50 dark:bg-zinc-800/50 rounded-lg px-4 py-3">
          <p className="font-medium text-zinc-700 dark:text-zinc-300">Rotation steps:</p>
          <ol className="list-decimal list-inside space-y-1">
            <li>Generate a new 64-character hex key: <code className="font-mono text-xs bg-zinc-100 dark:bg-zinc-700 px-1 rounded">node -e &quot;console.log(require(&apos;crypto&apos;).randomBytes(32).toString(&apos;hex&apos;))&quot;</code></li>
            <li>Enter the current key (oldKey) and the new key (newKey) below and submit.</li>
            <li>Verify the response shows the expected row count.</li>
            <li>Update <code className="font-mono text-xs bg-zinc-100 dark:bg-zinc-700 px-1 rounded">TASK_SECRET_KEY</code> to the new value and restart the server.</li>
          </ol>
        </div>

        {rotateMessage && (
          <div className={`rounded-lg px-4 py-3 text-sm ${
            rotateMessage.type === "success"
              ? "bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300"
              : "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300"
          }`}>
            {rotateMessage.text}
          </div>
        )}

        <form onSubmit={handleRotateKey} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Current key (oldKey) — 64 hex chars
            </label>
            <input
              type="password"
              value={rotateOldKey}
              onChange={(e) => setRotateOldKey(e.target.value)}
              placeholder="e.g. a3f1..."
              className={`${inputCls} font-mono text-xs`}
              autoComplete="off"
              required
              minLength={64}
              maxLength={64}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              New key (newKey) — 64 hex chars
            </label>
            <input
              type="password"
              value={rotateNewKey}
              onChange={(e) => setRotateNewKey(e.target.value)}
              placeholder="e.g. 9d2b..."
              className={`${inputCls} font-mono text-xs`}
              autoComplete="off"
              required
              minLength={64}
              maxLength={64}
            />
          </div>
          <Btn
            variant="secondary"
            size="sm"
            type="submit"
            disabled={rotateWorking || rotateOldKey.length !== 64 || rotateNewKey.length !== 64}
          >
            {rotateWorking ? "Rotating…" : "Rotate key"}
          </Btn>
        </form>
      </div>
    </div>
  );
}
