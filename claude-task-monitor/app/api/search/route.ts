import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import type { NextRequest } from "next/server";

export interface SearchResult {
  id: string;
  type: "task" | "project" | "agent" | "server";
  title: string;
  excerpt: string;
  url: string;
  meta: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
}

function snip(text: string | null | undefined, q: string, maxLen = 90): string {
  if (!text) return "";
  const lower = text.toLowerCase();
  const idx = lower.indexOf(q.toLowerCase());
  if (idx === -1) return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
  const start = Math.max(0, idx - 25);
  const end   = Math.min(text.length, idx + q.length + 40);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

const PER_TYPE = 5;

export async function GET(request: NextRequest) {
  try {
    const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";

    if (q.length < 1) {
      return Response.json({ query: q, results: [] } satisfies SearchResponse);
    }

    const [tasks, projects, agents, servers] = await Promise.all([
      prisma.task.findMany({
        where: {
          status: { not: "archived" },
          OR: [
            { title:         { contains: q, mode: "insensitive" } },
            { description:   { contains: q, mode: "insensitive" } },
            { resultSummary: { contains: q, mode: "insensitive" } },
          ],
        },
        select: {
          id: true, title: true, description: true, status: true, priority: true,
          project: { select: { name: true } },
        },
        take: PER_TYPE,
        orderBy: { updatedAt: "desc" },
      }),
      prisma.project.findMany({
        where: {
          OR: [
            { name:        { contains: q, mode: "insensitive" } },
            { description: { contains: q, mode: "insensitive" } },
          ],
        },
        select: { id: true, name: true, description: true, status: true, priority: true },
        take: PER_TYPE,
        orderBy: { updatedAt: "desc" },
      }),
      prisma.agent.findMany({
        where: {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { slug: { contains: q, mode: "insensitive" } },
          ],
        },
        select: {
          id: true, name: true, slug: true, status: true,
          server: { select: { name: true } },
        },
        take: PER_TYPE,
        orderBy: { name: "asc" },
      }),
      prisma.server.findMany({
        where: {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { host: { contains: q, mode: "insensitive" } },
          ],
        },
        select: { id: true, name: true, host: true, status: true },
        take: PER_TYPE,
        orderBy: { name: "asc" },
      }),
    ]);

    const results: SearchResult[] = [
      ...tasks.map((t) => ({
        id:      t.id,
        type:    "task" as const,
        title:   t.title,
        excerpt: snip(t.description, q) || snip(t.title, q),
        url:     `/tasks?highlight=${t.id}`,
        meta:    `${t.priority} · ${t.status} · ${t.project.name}`,
      })),
      ...projects.map((p) => ({
        id:      p.id,
        type:    "project" as const,
        title:   p.name,
        excerpt: snip(p.description, q) || snip(p.name, q),
        url:     `/projects/${p.id}`,
        meta:    `${p.priority} · ${p.status}`,
      })),
      ...agents.map((a) => ({
        id:      a.id,
        type:    "agent" as const,
        title:   a.name,
        excerpt: a.slug,
        url:     `/agents/${a.id}`,
        meta:    `${a.status} · ${a.server.name}`,
      })),
      ...servers.map((s) => ({
        id:      s.id,
        type:    "server" as const,
        title:   s.name,
        excerpt: s.host,
        url:     `/servers/${s.id}`,
        meta:    s.status ?? "",
      })),
    ];

    return Response.json({ query: q, results } satisfies SearchResponse);
  } catch (err) {
    return serverError("search GET", err);
  }
}
