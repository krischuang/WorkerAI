"use client";

import { useState, useRef, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { inputCls, Btn } from "@/app/_components/ui";

function VerifyOtpForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/admin/verify-otp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (res.ok) {
        const raw = params.get("redirect") ?? "";
        const redirect = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/admin/config";
        router.push(redirect);
      } else {
        const body = await res.json().catch(() => ({}));
        if (res.status === 401 && body.error === "Password step not completed") {
          router.push("/admin/login");
          return;
        }
        setError(body.error || "Invalid code");
        setCode("");
        inputRef.current?.focus();
      }
    } catch {
      setError("Could not reach the server");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
          Authenticator Code
        </label>
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          pattern="[0-9 ]*"
          maxLength={7}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="000 000"
          className={`${inputCls} font-mono tracking-widest text-center text-lg`}
          autoComplete="one-time-code"
          required
        />
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Enter the 6-digit code from your authenticator app
        </p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <Btn
        variant="primary"
        size="md"
        type="submit"
        disabled={loading || code.replace(/\s/g, "").length < 6}
        className="w-full justify-center"
      >
        {loading ? "Verifying…" : "Verify"}
      </Btn>

      <p className="text-center text-xs text-zinc-500 dark:text-zinc-400">
        <a href="/admin/login" className="underline hover:text-zinc-700 dark:hover:text-zinc-300">
          Back to login
        </a>
      </p>
    </form>
  );
}

export default function VerifyOtpPage() {
  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-zinc-800 mb-4">
            <ShieldCheck className="w-6 h-6 text-zinc-200" />
          </div>
          <h1 className="text-xl font-semibold text-white">Two-Factor Auth</h1>
          <p className="text-sm text-zinc-400 mt-1">Enter the code from your authenticator app</p>
        </div>

        <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-700 shadow-2xl p-8">
          <Suspense>
            <VerifyOtpForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
