"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  FolderKanban,
  ClipboardList,
  ArrowUpDown,
  Server,
  Bot,
  FileStack,
  BarChart2,
  FileText,
  Activity,
  ShieldCheck,
  Bell,
  LogOut,
  Menu,
  X,
  Sun,
  Moon,
  Monitor,
  HelpCircle,
} from "lucide-react";
import { KeyboardShortcutsModal } from "./KeyboardShortcutsModal";
import { GlobalSearch } from "./GlobalSearch";

type Theme = "light" | "dark" | "system";

const sections = [
  {
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    ],
  },
  {
    label: "Work",
    items: [
      { href: "/projects",  label: "Projects",        icon: FolderKanban },
      { href: "/tasks",     label: "Tasks",           icon: ClipboardList },
      { href: "/queue",     label: "Priority Queue",  icon: ArrowUpDown   },
    ],
  },
  {
    label: "Infrastructure",
    items: [
      { href: "/servers", label: "Servers", icon: Server },
      { href: "/agents",  label: "Agents",  icon: Bot    },
    ],
  },
  {
    label: "Tools",
    items: [
      { href: "/task-templates",  label: "Templates",     icon: FileStack },
      { href: "/analytics",       label: "Analytics",     icon: BarChart2 },
      { href: "/reports/daily",   label: "Daily Report",  icon: FileText  },
      { href: "/reports/weekly",  label: "Weekly Report", icon: FileText  },
      { href: "/reports/monthly", label: "Monthly Report",icon: FileText  },
    ],
  },
  {
    label: "Admin",
    items: [
      { href: "/admin/health",         label: "Health Monitor", icon: Activity    },
      { href: "/admin/audit",          label: "Audit Log",      icon: ShieldCheck },
      { href: "/admin/notifications",  label: "Notifications",  icon: Bell        },
    ],
  },
];

const themeConfig: Record<Theme, { icon: typeof Sun; label: string; next: Theme }> = {
  light:  { icon: Sun,     label: "Light",  next: "dark"   },
  dark:   { icon: Moon,    label: "Dark",   next: "system" },
  system: { icon: Monitor, label: "System", next: "light"  },
};

function applyTheme(pref: Theme) {
  try {
    const html = document.documentElement;
    if (pref === "dark") {
      html.setAttribute("data-theme", "dark");
    } else if (pref === "light") {
      html.setAttribute("data-theme", "light");
    } else {
      const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      html.setAttribute("data-theme", dark ? "dark" : "light");
    }
    localStorage.setItem("theme", pref);
  } catch { /* ignore */ }
}

export function Nav() {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>("system");
  const [showShortcuts, setShowShortcuts] = useState(false);

  useEffect(() => {
    const stored = (localStorage.getItem("theme") as Theme | null) ?? "system";
    setTheme(stored);

    if (stored === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => applyTheme("system");
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
  }, []);

  function cycleTheme() {
    const next = themeConfig[theme].next;
    setTheme(next);
    applyTheme(next);
  }

  if (pathname === "/login") return null;

  function closeDrawer() { setDrawerOpen(false); }

  const ThemeIcon = themeConfig[theme].icon;

  return (
    <>
      {/* ── Mobile top bar (hidden on md+) ──────────────────────────────── */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-40 h-12 bg-zinc-950 border-b border-zinc-800 flex items-center px-4 gap-3">
        <button
          onClick={() => setDrawerOpen(true)}
          aria-label="Open menu"
          className="text-zinc-400 hover:text-zinc-100 transition-colors"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded bg-zinc-700 flex items-center justify-center shrink-0">
            <Bot className="w-3 h-3 text-zinc-200" />
          </div>
          <span className="text-sm font-semibold text-zinc-100">Task Monitor</span>
        </div>
      </div>

      {/* ── Backdrop (mobile only, tap to close) ────────────────────────── */}
      {drawerOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/50"
          onClick={closeDrawer}
          aria-hidden="true"
        />
      )}

      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <nav
        className={`
          fixed md:static inset-y-0 left-0 z-50
          w-64 md:w-52 shrink-0
          bg-zinc-950 text-zinc-100
          h-screen md:min-h-screen
          flex flex-col py-4
          transition-transform duration-200 ease-in-out
          ${drawerOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}
        `}
      >
        {/* Logo row + mobile close button */}
        <div className="px-4 mb-6 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded-md bg-zinc-700 flex items-center justify-center shrink-0">
              <Bot className="w-4 h-4 text-zinc-200" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-zinc-100 leading-tight truncate">Task Monitor</p>
              <p className="text-xs text-zinc-500 leading-tight">Claude AI</p>
            </div>
          </div>
          <button
            onClick={closeDrawer}
            aria-label="Close menu"
            className="md:hidden text-zinc-500 hover:text-zinc-200 transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <GlobalSearch />

        <div className="flex-1 overflow-y-auto px-2 space-y-4">
          {sections.map((section, i) => (
            <div key={i}>
              {section.label && (
                <p className="px-2 mb-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                  {section.label}
                </p>
              )}
              <ul className="space-y-0.5">
                {section.items.map(({ href, label, icon: Icon }) => {
                  const active = pathname === href || pathname.startsWith(href + "/");
                  return (
                    <li key={href}>
                      <Link
                        href={href}
                        onClick={closeDrawer}
                        className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                          active
                            ? "bg-zinc-700 text-white font-medium"
                            : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                        }`}
                      >
                        <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                        {label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        <div className="px-2 mt-4 pt-4 border-t border-zinc-800">
          {/* Theme toggle */}
          <button
            onClick={cycleTheme}
            title={`Theme: ${themeConfig[theme].label} — click to switch to ${themeConfig[themeConfig[theme].next].label}`}
            className="flex items-center gap-2.5 w-full rounded-md px-2.5 py-1.5 text-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 transition-colors mb-0.5"
          >
            <ThemeIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>{themeConfig[theme].label}</span>
          </button>

          {/* Keyboard shortcuts help */}
          <button
            onClick={() => setShowShortcuts(true)}
            title="Keyboard shortcuts (?)"
            className="flex items-center gap-2.5 w-full rounded-md px-2.5 py-1.5 text-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 transition-colors mb-0.5"
          >
            <HelpCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>Shortcuts</span>
            <kbd className="ml-auto text-[10px] font-mono bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-zinc-500">?</kbd>
          </button>

          <button
            onClick={async () => {
              await fetch("/api/auth", { method: "DELETE" });
              window.location.href = "/login";
            }}
            className="flex items-center gap-2.5 w-full rounded-md px-2.5 py-1.5 text-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 transition-colors"
          >
            <LogOut className="w-4 h-4 shrink-0" aria-hidden="true" />
            Sign out
          </button>
          <p className="text-[11px] text-zinc-600 px-2.5 mt-2">v1.0 — local</p>
        </div>
      </nav>

      {showShortcuts && (
        <KeyboardShortcutsModal onClose={() => setShowShortcuts(false)} />
      )}
    </>
  );
}
