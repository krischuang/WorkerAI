type Status = "pending" | "queued" | "running" | "paused" | "completed" | "failed" | "archived" | "needs_review";

const styles: Record<Status, { badge: string; dot: string; pulse?: boolean }> = {
  pending:      { badge: "bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700",              dot: "bg-zinc-400 dark:bg-zinc-500" },
  queued:       { badge: "bg-violet-50 dark:bg-violet-950 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-800",   dot: "bg-violet-500" },
  running:      { badge: "bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800",               dot: "bg-blue-500", pulse: true },
  paused:       { badge: "bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800",         dot: "bg-amber-500" },
  completed:    { badge: "bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800",         dot: "bg-green-500" },
  failed:       { badge: "bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800",                     dot: "bg-red-500" },
  archived:     { badge: "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700",        dot: "bg-slate-400 dark:bg-slate-500" },
  needs_review: { badge: "bg-orange-50 dark:bg-orange-950 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-800",   dot: "bg-orange-500" },
};

export function StatusBadge({ status }: { status: string }) {
  const s = status as Status;
  const style = styles[s] ?? { badge: "bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700", dot: "bg-zinc-400" };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${style.badge}`}
    >
      <span className="relative flex w-1.5 h-1.5 shrink-0" aria-hidden="true">
        {style.pulse && (
          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${style.dot}`} />
        )}
        <span className={`relative inline-flex rounded-full w-1.5 h-1.5 ${style.dot}`} />
      </span>
      {status}
    </span>
  );
}
