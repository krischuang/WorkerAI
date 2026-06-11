"use client";

import { useEffect } from "react";

/** Returns true if the event target is a text-editable element. */
export function isEditableTarget(e: KeyboardEvent): boolean {
  const tag = (e.target as HTMLElement)?.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    (e.target as HTMLElement)?.isContentEditable
  );
}

type Handler = (e: KeyboardEvent) => void;

/**
 * Registers a global keydown handler that fires only when focus is NOT inside
 * a text-editing element (input / textarea / select / contenteditable).
 * The returned cleanup is handled automatically via useEffect.
 */
export function useKeyboardShortcut(
  handler: Handler,
  deps: React.DependencyList = [],
) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isEditableTarget(e)) return;
      handler(e);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
