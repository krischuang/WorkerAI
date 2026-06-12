import { prisma, pool } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";

export async function GET() {
  try {
    const [servers, agents, heartbeatRow] = await Promise.all([
      prisma.server.findMany({
        select: {
          id: true,
          name: true,
          host: true,
          status: true,
          healthScore: true,
          consecutiveFailures: true,
          lastHealthCheckAt: true,
          diskUsedBytes: true,
          diskTotalBytes: true,
          workerHealths: {
            orderBy: { checkedAt: "desc" },
            take: 1,
            select: { sshOk: true, tmuxOk: true, claudeOk: true, latencyMs: true, errorMessage: true, checkedAt: true },
          },
        },
        orderBy: { name: "asc" },
      }),
      prisma.agent.findMany({
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          healthScore: true,
          consecutiveFailures: true,
          lastHealthCheckAt: true,
          diskUsedBytes: true,
          diskTotalBytes: true,
          server: { select: { id: true, name: true, host: true } },
          workerHealths: {
            orderBy: { checkedAt: "desc" },
            take: 1,
            select: { sshOk: true, tmuxOk: true, claudeOk: true, latencyMs: true, errorMessage: true, checkedAt: true },
          },
        },
        orderBy: { name: "asc" },
      }),
      prisma.systemConfig.findUnique({
        where: { key: "poller_last_heartbeat_at" },
        select: { value: true },
      }),
    ]);

    const lastHeartbeatAt = heartbeatRow?.value ?? null;
    const secondsSinceHeartbeat = lastHeartbeatAt
      ? Math.floor((Date.now() - new Date(lastHeartbeatAt).getTime()) / 1000)
      : null;
    const pollerAlive = secondsSinceHeartbeat !== null && secondsSinceHeartbeat <= 180;

    const total = pool.totalCount;
    const idle = pool.idleCount;
    const waiting = pool.waitingCount;
    const utilisation = total > 0 ? (total - idle) / total : 0;

    // BigInt fields (diskUsedBytes, diskTotalBytes) aren't JSON-serializable by default.
    // Convert to number (safe: disk sizes won't exceed Number.MAX_SAFE_INTEGER for years).
    const serializeDisk = <T extends { diskUsedBytes: bigint | null; diskTotalBytes: bigint | null }>(
      items: T[]
    ) =>
      items.map((item) => ({
        ...item,
        diskUsedBytes: item.diskUsedBytes !== null ? Number(item.diskUsedBytes) : null,
        diskTotalBytes: item.diskTotalBytes !== null ? Number(item.diskTotalBytes) : null,
      }));

    return Response.json({
      servers: serializeDisk(servers),
      agents: serializeDisk(agents),
      dbPool: { total, idle, waiting, utilisation: Math.round(utilisation * 1000) / 1000 },
      poller: { pollerAlive, lastHeartbeatAt, secondsSinceHeartbeat },
    });
  } catch (err) {
    return serverError("health GET", err);
  }
}
