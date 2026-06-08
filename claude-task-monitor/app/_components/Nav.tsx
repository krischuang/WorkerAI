"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/projects", label: "Projects" },
  { href: "/tasks", label: "Tasks" },
  { href: "/queue", label: "Priority Queue" },
  { href: "/servers", label: "Servers" },
  { href: "/reports/daily", label: "Daily Report" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="w-56 shrink-0 bg-zinc-900 text-zinc-100 min-h-screen flex flex-col p-4">
      <div className="mb-8">
        <h1 className="text-sm font-semibold text-zinc-100 uppercase tracking-widest">
          Claude Task
        </h1>
        {/* text-zinc-400 = 7.1:1 on zinc-900 — WCAG AA */}
        <p className="text-xs text-zinc-400 mt-0.5">Monitor</p>
      </div>
      <ul className="space-y-1 flex-1">
        {links.map(({ href, label }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <li key={href}>
              <Link
                href={href}
                className={`block rounded-md px-3 py-2 text-sm transition-colors ${
                  active
                    ? "bg-zinc-700 text-white font-medium"
                    : "text-zinc-300 hover:bg-zinc-800 hover:text-white"
                }`}
              >
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="text-xs text-zinc-400 mt-4">v1.0 — local</div>
    </nav>
  );
}
