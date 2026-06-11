"use client";

import { useState, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useKeyboardShortcut } from "@/lib/use-keyboard-shortcut";
import { KeyboardShortcutsModal } from "./KeyboardShortcutsModal";

/**
 * Mounted once in the root layout. Handles app-wide keyboard shortcuts:
 *   D → /dashboard
 *   P → /projects
 *   T → /tasks
 *   Q → /queue
 *   / → focus the global search input
 *   ? → toggle keyboard shortcuts help modal
 */
export function GlobalKeyboardShortcuts() {
  const router = useRouter();
  const pathname = usePathname();
  const [showHelp, setShowHelp] = useState(false);

  const handleKey = useCallback((e: KeyboardEvent) => {
    // Skip when a modal or dialog is open (other than ours)
    const activeModals = document.querySelectorAll("[role=dialog], [data-modal]");
    if (activeModals.length > 0 && !showHelp) return;

    switch (e.key) {
      case "d":
      case "D":
        e.preventDefault();
        router.push("/dashboard");
        break;
      case "p":
      case "P":
        e.preventDefault();
        router.push("/projects");
        break;
      case "t":
      case "T":
        e.preventDefault();
        router.push("/tasks");
        break;
      case "q":
      case "Q":
        e.preventDefault();
        router.push("/queue");
        break;
      case "/":
        e.preventDefault();
        // Broadcast a custom event — GlobalSearch listens and focuses itself
        window.dispatchEvent(new CustomEvent("workerai:focus-search"));
        break;
      case "?":
        e.preventDefault();
        setShowHelp((v) => !v);
        break;
      case "Escape":
        if (showHelp) {
          e.preventDefault();
          setShowHelp(false);
        }
        break;
      case "n":
      case "N":
        // Only fire "new task" on the /tasks page — dispatches to TasksPage listener
        if (pathname === "/tasks" || pathname.startsWith("/tasks")) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("workerai:new-task"));
        }
        break;
    }
  }, [router, pathname, showHelp]);

  useKeyboardShortcut(handleKey, [handleKey]);

  if (pathname === "/login") return null;

  return showHelp ? <KeyboardShortcutsModal onClose={() => setShowHelp(false)} /> : null;
}
