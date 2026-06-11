import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";

export async function GET() {
  try {
    const [servers, agents] = await Promise.all([
      prisma.server.findMany({
        select: {
          id: true,
          name: true,
          host: true,
          status: true,
          healthScore: true,
          consecutiveFailures: true,
          lastHealthCheckAt: true,
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
          server: { select: { id: true, name: true, host: true } },
          workerHealths: {
            orderBy: { checkedAt: "desc" },
            take: 1,
            select: { sshOk: true, tmuxOk: true, claudeOk: true, latencyMs: true, errorMessage: true, checkedAt: true },
          },
        },
        orderBy: { name: "asc" },
      }),
    ]);

    return Response.json({ servers, agents });
  } catch (err) {
    return serverError("health GET", err);
  }
}
