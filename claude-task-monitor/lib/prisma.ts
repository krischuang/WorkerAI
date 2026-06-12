import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "@/app/generated/prisma/client";
import pg from "pg";

// ── Slow-query circular buffer ──────────────────────────────────────────────
// Queries exceeding this threshold are captured for the admin panel.
const SLOW_QUERY_THRESHOLD_MS = 500;
const SLOW_QUERY_BUFFER_SIZE  = 50;

export interface SlowQueryEntry {
  query:     string; // truncated to 500 chars
  duration:  number; // milliseconds
  timestamp: string; // ISO-8601
}

const g = globalThis as unknown as {
  prisma:          PrismaClient;
  pool:            pg.Pool;
  _slowQueryLog?:  SlowQueryEntry[];
};

function logSlowQuery(e: Prisma.QueryEvent) {
  if (!g._slowQueryLog) g._slowQueryLog = [];
  g._slowQueryLog.push({
    query:     e.query.slice(0, 500),
    duration:  e.duration,
    timestamp: new Date(e.timestamp).toISOString(),
  });
  // Evict the oldest entry once the buffer is full.
  if (g._slowQueryLog.length > SLOW_QUERY_BUFFER_SIZE) {
    g._slowQueryLog.shift();
  }
}

/** Returns the in-memory slow-query log sorted by duration descending. */
export function getSlowQueryLog(): SlowQueryEntry[] {
  return (g._slowQueryLog ?? []).slice().sort((a, b) => b.duration - a.duration);
}

// ── Client factory ──────────────────────────────────────────────────────────

function createPrismaClient() {
  // Use an explicit pool so we can tune idle/reconnect behaviour.
  // idleTimeoutMillis: close idle connections after 30s (before PG kills them).
  // max: keep pool small for a local dev server.
  const p = new pg.Pool({
    connectionString: process.env.DATABASE_URL!,
    max: 15,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  const adapter = new PrismaPg(p);
  // Enable query events so we can detect slow queries.
  const client = new PrismaClient({
    adapter,
    log: [{ level: "query", emit: "event" }],
  });

  // Attach the slow-query listener. We cast to bypass the LogOpts generic that
  // Prisma 7 uses to constrain $on at the type level — at runtime this works.
  (client as unknown as {
    $on(event: "query", cb: (e: Prisma.QueryEvent) => void): void;
  }).$on("query", (e) => {
    if (e.duration > SLOW_QUERY_THRESHOLD_MS) logSlowQuery(e);
  });

  return { prisma: client, pool: p };
}

if (!g.prisma) {
  const created = createPrismaClient();
  g.prisma = created.prisma;
  g.pool   = created.pool;
}

export const prisma = g.prisma;
export const pool   = g.pool;
