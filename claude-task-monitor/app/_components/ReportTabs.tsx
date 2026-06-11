"use client";

import Link from "next/link";

type ReportType = "daily" | "weekly" | "monthly";

const TABS: { type: ReportType; label: string; href: string }[] = [
  { type: "daily",   label: "Daily",   href: "/reports/daily"   },
  { type: "weekly",  label: "Weekly",  href: "/reports/weekly"  },
  { type: "monthly", label: "Monthly", href: "/reports/monthly" },
];

export function ReportTabs({ active }: { active: ReportType }) {
  return (
    <div className="flex gap-1 p-1 bg-zinc-100 rounded-lg w-fit mb-6">
      {TABS.map((tab) => (
        <Link
          key={tab.type}
          href={tab.href}
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
            active === tab.type
              ? "bg-white text-zinc-900 shadow-sm"
              : "text-zinc-500 hover:text-zinc-800"
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}
