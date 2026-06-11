import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { recalculateProjectProgress } from "@/lib/project-progress";

type BulkAction = "assign_server" | "assign_agent" | "mark_completed" | "archive";

interface BulkPayload {
  ids: string[];
  action: BulkAction;
  payload?: { serverId?: string; agentId?: string };
}

const VALID_ACTIONS: BulkAction[] = [
  "assign_server",
  "assign_agent",
  "mark_completed",
  "archive",
];

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as BulkPayload;
    const { ids, action, payload } = body;

    // ── Input validation ───────────────────────────────────────────────────
    if (!Array.isArray(ids) || ids.length === 0) {
      return Response.json({ error: "ids must be a non-empty array" }, { status: 400 });
    }
    if (!VALID_ACTIONS.includes(action)) {
      return Response.json(
        { error: `action must be one of: ${VALID_ACTIONS.join(", ")}` },
        { status: 400 },
      );
    }
    if (action === "assign_server" && !payload?.serverId) {
      return Response.json({ error: "payload.serverId is required for assign_server" }, { status: 400 });
    }
    if (action === "assign_agent" && !payload?.agentId) {
      return Response.json({ error: "payload.agentId is required for assign_agent" }, { status: 400 });
    }

    // ── Verify all task IDs exist ──────────────────────────────────────────
    const found = await prisma.task.findMany({
      where: { id: { in: ids } },
      select: { id: true, projectId: true },
    });
    if (found.length !== ids.length) {
      const foundSet = new Set(found.map((t) => t.id));
      const missing  = ids.filter((id) => !foundSet.has(id));
      return Response.json(
        { error: "Some task IDs not found", missing },
        { status: 404 },
      );
    }

    // ── Execute in a single transaction ────────────────────────────────────
    await prisma.$transaction(async (tx) => {
      switch (action) {
        case "assign_server":
          await tx.task.updateMany({
            where: { id: { in: ids } },
            data: { serverId: payload!.serverId, agentId: null },
          });
          // Advance pending tasks to queued now that they have a target.
          await tx.task.updateMany({
            where: { id: { in: ids }, status: "pending", blockedByCount: 0 },
            data: { status: "queued" },
          });
          break;

        case "assign_agent":
          await tx.task.updateMany({
            where: { id: { in: ids } },
            data: { agentId: payload!.agentId, serverId: null },
          });
          await tx.task.updateMany({
            where: { id: { in: ids }, status: "pending", blockedByCount: 0 },
            data: { status: "queued" },
          });
          break;

        case "mark_completed":
          await tx.task.updateMany({
            where: { id: { in: ids } },
            data: { status: "completed" },
          });
          break;

        case "archive":
          await tx.task.updateMany({
            where: { id: { in: ids } },
            data: { status: "archived" },
          });
          break;
      }
    });

    // ── Recalculate progress for every affected project ────────────────────
    const projectIds = [...new Set(found.map((t) => t.projectId))];
    await Promise.all(
      projectIds.map((pId) => recalculateProjectProgress(pId).catch(() => {})),
    );

    return Response.json({ updated: ids.length, action });
  } catch (err) {
    return serverError("tasks/bulk POST", err);
  }
}
