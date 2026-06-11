"use client";

import { useEffect } from "react";

const NAV_SHORTCUTS = [
  { key: "D", description: "Go to Dashboard" },
  { key: "P", description: "Go to Projects" },
  { key: "T", description: "Go to Tasks" },
  { key: "Q", description: "Go to Queue" },
];

const ACTION_SHORTCUTS = [
  { key: "N", description: "New task (on Tasks page)" },
  { key: "/", description: "Focus search bar" },
  { key: "?", description: "Show this help panel" },
  { key: "Esc", description: "Close modal / panel" },
];

const LIST_SHORTCUTS = [
  { key: "J", description: "Move selection down" },
  { key: "K", description: "Move selection up" },
  { key: "↵ Enter", description: "Open selected item" },
];

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[2rem] px-1.5 py-0.5 rounded border border-zinc-300 dark:border-zinc-600 bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 text-xs font-mono font-semibold shadow-[0_1px_0_0_rgba(0,0,0,0.15)] dark:shadow-[0_1px_0_0_rgba(255,255,255,0.1)]">
      {children}
    </kbd>
  );
}

function ShortcutRow({ shortcut }: { shortcut: { key: string; description: string } }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-sm text-zinc-600 dark:text-zinc-400">{shortcut.description}</span>
      <Kbd>{shortcut.key}</Kbd>
    </div>
  );
}

function Section({ title, shortcuts }: { title: string; shortcuts: { key: string; description: string }[] }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-2">{title}</h3>
      <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {shortcuts.map((s) => <ShortcutRow key={s.key} shortcut={s} />)}
      </div>
    </div>
  );
}

export function KeyboardShortcutsModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl w-full max-w-sm ring-1 ring-zinc-200 dark:ring-zinc-700"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-zinc-100 dark:border-zinc-800">
          <div>
            <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Keyboard Shortcuts</h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">Shortcuts are disabled while typing in a field</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 w-7 h-7 flex items-center justify-center rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors text-lg"
          >
            ×
          </button>
        </div>
        <div className="p-6 space-y-5">
          <Section title="Navigation" shortcuts={NAV_SHORTCUTS} />
          <Section title="Actions" shortcuts={ACTION_SHORTCUTS} />
          <Section title="List navigation (Tasks page)" shortcuts={LIST_SHORTCUTS} />
        </div>
      </div>
    </div>
  );
}
