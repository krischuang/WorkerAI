"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
  LineChart,
  Line,
} from "recharts";
import type { TrendDay, ProjectSparkline } from "@/app/api/dashboard/trends/route";

function shortDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function ThroughputChart({ days }: { days: TrendDay[] }) {
  const data = days.map(d => ({
    date: shortDate(d.date),
    Completed: d.completed,
    Failed: d.failed,
  }));

  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }} barCategoryGap="30%">
        <XAxis
          dataKey="date"
          tick={{ fontSize: 11, fill: "#71717a" }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          allowDecimals={false}
          tick={{ fontSize: 11, fill: "#71717a" }}
          axisLine={false}
          tickLine={false}
          width={32}
        />
        <Tooltip
          contentStyle={{
            fontSize: 12,
            borderRadius: 8,
            border: "1px solid #e4e4e7",
            boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
          }}
          cursor={{ fill: "#f4f4f5" }}
        />
        <Legend
          wrapperStyle={{ fontSize: 12, paddingTop: 4 }}
          iconSize={10}
          iconType="square"
        />
        <Bar dataKey="Completed" fill="#22c55e" radius={[3, 3, 0, 0]} maxBarSize={32} />
        <Bar dataKey="Failed"    fill="#ef4444" radius={[3, 3, 0, 0]} maxBarSize={32} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function ProjectSparklineRow({ sparkline }: { sparkline: ProjectSparkline }) {
  const data = sparkline.days.map(d => ({ date: shortDate(d.date), v: d.completed }));
  const total = sparkline.days.reduce((s, d) => s + d.completed, 0);

  return (
    <div className="flex items-center gap-3">
      <div className="w-28 shrink-0">
        <p className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate" title={sparkline.projectName}>
          {sparkline.projectName}
        </p>
        <p className="text-xs text-zinc-400">{total} total</p>
      </div>
      <div className="flex-1 h-10">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
            <Line
              type="monotone"
              dataKey="v"
              stroke="#22c55e"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <Tooltip
              contentStyle={{ fontSize: 11, borderRadius: 6, border: "1px solid #e4e4e7" }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
