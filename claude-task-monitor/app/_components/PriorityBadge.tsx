type Priority = "P1" | "P2" | "P3" | "P4";

const styles: Record<Priority, string> = {
  P1: "bg-red-100 text-red-700 border-red-200",
  P2: "bg-orange-100 text-orange-700 border-orange-200",
  P3: "bg-blue-100 text-blue-700 border-blue-200",
  P4: "bg-zinc-100 text-zinc-600 border-zinc-200",
};

export function PriorityBadge({ priority }: { priority: string }) {
  const p = priority as Priority;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${styles[p] ?? "bg-zinc-100 text-zinc-600"}`}
    >
      {priority}
    </span>
  );
}
