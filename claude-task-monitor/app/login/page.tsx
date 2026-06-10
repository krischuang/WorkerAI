"use client";

import { useState, useRef, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { inputCls, Btn } from "@/app/_components/ui";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        const redirect = params.get("redirect") || "/dashboard";
        router.push(redirect);
      } else {
        const body = await res.json().catch(() => ({}));
        setError(body.error || "Invalid password");
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
        <label className="block text-sm font-medium text-zinc-700 mb-1">
          Password
        </label>
        <input
          ref={inputRef}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Enter AUTH_SECRET"
          className={inputCls}
          autoComplete="current-password"
          required
        />
      </div>

      {error && (
        <p className="text-sm text-red-600">{error}</p>
      )}

      <Btn
        variant="primary"
        size="md"
        type="submit"
        disabled={loading || password.trim() === ""}
        className="w-full justify-center"
      >
        {loading ? "Signing in…" : "Sign in"}
      </Btn>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-zinc-50 flex items-center justify-center">
      <div className="w-full max-w-sm bg-white rounded-xl border border-zinc-200 shadow-sm p-8">
        <div className="mb-8 text-center">
          <h1 className="text-lg font-semibold text-zinc-900 uppercase tracking-widest">
            Claude Task
          </h1>
          <p className="text-xs text-zinc-500 mt-0.5">Monitor</p>
        </div>

        <Suspense>
          <LoginForm />
        </Suspense>

        <p className="mt-6 text-xs text-zinc-400 text-center">
          Local-only · set <code className="font-mono">AUTH_SECRET</code> in <code className="font-mono">.env</code>
        </p>
      </div>
    </div>
  );
}
