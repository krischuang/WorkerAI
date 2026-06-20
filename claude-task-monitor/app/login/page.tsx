"use client";

import { useState, useRef, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Bot } from "lucide-react";
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
        const raw = params.get("redirect") ?? "";
        const redirect = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/dashboard";
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
        <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
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
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-zinc-800 mb-4">
            <Bot className="w-6 h-6 text-zinc-200" />
          </div>
          <h1 className="text-xl font-semibold text-white">Task Monitor</h1>
          <p className="text-sm text-zinc-400 mt-1">Claude AI — local</p>
        </div>

        <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-700 shadow-2xl p-8">
          <Suspense>
            <LoginForm />
          </Suspense>
        </div>

        <p className="mt-5 text-xs text-zinc-600 dark:text-zinc-400 text-center">
          Set <code className="font-mono text-zinc-400">AUTH_SECRET</code> in <code className="font-mono text-zinc-400">.env</code>
        </p>
      </div>
    </div>
  );
}
