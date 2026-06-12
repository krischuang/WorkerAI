"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Search, ClipboardList, FolderKanban, Bot, Server, X, FileText } from "lucide-react";

type EntityType = "task" | "project" | "agent" | "server" | "log";

type SearchResult = {
  id: string;
  type: EntityType;
  title: string;
  excerpt: string;
  url: string;
  meta: string;
};

type SearchResponse = {
  query: string;
  results: SearchResult[];
};

const typeConfig: Record<EntityType, { label: string; chip: string; icon: React.ComponentType<{ className?: string }> }> = {
  task:    { label: "Task",    chip: "bg-blue-100 text-blue-700",    icon: ClipboardList },
  project: { label: "Project", chip: "bg-violet-100 text-violet-700", icon: FolderKanban },
  agent:   { label: "Agent",   chip: "bg-green-100 text-green-700",  icon: Bot },
  server:  { label: "Server",  chip: "bg-amber-100 text-amber-700",  icon: Server },
  log:     { label: "Log",     chip: "bg-zinc-100 text-zinc-700",    icon: FileText },
};

const ORDER: EntityType[] = ["project", "task", "log", "agent", "server"];

export function GlobalSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults(null);
      setOpen(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`);
      if (res.ok) {
        const data: SearchResponse = await res.json();
        setResults(data.results);
        setOpen(true);
      }
    } catch {
      // Network error (e.g. server restart) — silently skip, results stay stale
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => doSearch(query), 300);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, doSearch]);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  // Listen for the global "/" shortcut broadcast from GlobalKeyboardShortcuts
  useEffect(() => {
    function onFocusSearch() {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    window.addEventListener("workerai:focus-search", onFocusSearch);
    return () => window.removeEventListener("workerai:focus-search", onFocusSearch);
  }, []);

  function navigate(url: string) {
    setOpen(false);
    setQuery("");
    setResults(null);
    router.push(url);
  }

  function clear() {
    setQuery("");
    setResults(null);
    setOpen(false);
  }

  const hasQuery = query.trim().length > 0;
  const totalResults = results?.length ?? 0;

  // Group results by type in display order
  const grouped = ORDER.map((type) => ({
    type,
    items: results?.filter((r) => r.type === type) ?? [],
  })).filter((g) => g.items.length > 0);

  return (
    <div ref={containerRef} className="relative px-2 mb-3">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => {
            if (results && hasQuery) setOpen(true);
          }}
          placeholder="Search… (/)"
          className="w-full bg-zinc-800 border border-zinc-700 rounded-md pl-7 pr-6 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-500 transition-colors"
        />
        {query && (
          <button
            type="button"
            onClick={clear}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>

      {open && hasQuery && (
        <div className="absolute left-0 top-full mt-1 w-80 bg-white rounded-lg shadow-xl border border-zinc-200 z-50 overflow-hidden">
          {loading && (
            <div className="px-3 py-3 text-xs text-zinc-500">Searching…</div>
          )}

          {!loading && totalResults === 0 && (
            <div className="px-3 py-5 text-center">
              <p className="text-xs font-medium text-zinc-600">No results</p>
              <p className="text-[11px] text-zinc-400 mt-0.5">No matches for &ldquo;{query}&rdquo;</p>
            </div>
          )}

          {!loading && totalResults > 0 && (
            <div className="max-h-80 overflow-y-auto">
              {grouped.map(({ type, items }) => {
                const { label, chip } = typeConfig[type];
                return (
                  <div key={type}>
                    <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-400 bg-zinc-50 border-b border-zinc-100">
                      {label}s
                    </div>
                    {items.map((result) => (
                      <button
                        key={result.id}
                        type="button"
                        onClick={() => navigate(result.url)}
                        className="w-full text-left px-3 py-2 hover:bg-zinc-50 flex items-start gap-2 border-b border-zinc-50 last:border-0 transition-colors"
                      >
                        <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight ${chip}`}>
                          {label}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium text-zinc-900 truncate">{result.title}</p>
                          {result.excerpt && (
                            <p className="text-[11px] text-zinc-500 truncate mt-0.5">{result.excerpt}</p>
                          )}
                          {result.meta && !result.excerpt && (
                            <p className="text-[11px] text-zinc-400 truncate mt-0.5">{result.meta}</p>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
