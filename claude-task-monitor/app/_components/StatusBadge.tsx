type Status = "pending" | "queued" | "running" | "paused" | "completed" | "failed";

const styles: Record<Status, { badge: string; dot: string }> = {
  pending:   { badge: "bg-zinc-100 text-zinc-700 border-zinc-200",     dot: "bg-zinc-500" },
  queued:    { badge: "bg-violet-50 text-violet-700 border-violet-200", dot: "bg-violet-500" },
  running:   { badge: "bg-blue-50 text-blue-700 border-blue-200",       dot: "bg-blue-500" },
  paused:    { badge: "bg-amber-50 text-amber-700 border-amber-200",    dot: "bg-amber-500" },
  completed: { badge: "bg-green-50 text-green-700 border-green-200",    dot: "bg-green-500" },
  failed:    { badge: "bg-red-50 text-red-700 border-red-200",          dot: "bg-red-500" },
};

export function StatusBadge({ status }: { status: string }) {
  const s = status as Status;
  const style = styles[s] ?? { badge: "bg-zinc-100 text-zinc-700 border-zinc-200", dot: "bg-zinc-400" };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${style.badge}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${style.dot}`} aria-hidden="true" />
      {status}
    </span>
  );
}
