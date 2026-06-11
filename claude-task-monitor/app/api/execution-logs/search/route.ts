import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q")?.trim();
    const taskId = searchParams.get("taskId");
    const projectId = searchParams.get("projectId");

    if (!q) return Response.json({ error: "q is required" }, { status: 400 });

    // Full-text search via PostgreSQL tsvector / plainto_tsquery
    type LogRow = {
      id: string;
      taskId: string;
      status: string;
      startedAt: Date;
      finishedAt: Date | null;
      exitReason: string | null;
      durationMs: number | null;
      outputSummary: string | null;
      errorMessage: string | null;
      createdAt: Date;
    };

    let results: LogRow[];

    if (projectId) {
      results = await prisma.$queryRaw<LogRow[]>`
        SELECT el.id, el."taskId", el.status, el."startedAt", el."finishedAt",
               el."exitReason", el."durationMs", el."outputSummary", el."errorMessage", el."createdAt"
        FROM "ExecutionLog" el
        JOIN "Task" t ON t.id = el."taskId"
        WHERE t."projectId" = ${projectId}
          AND el."searchVector" @@ plainto_tsquery('english', ${q})
        ORDER BY el."createdAt" DESC
        LIMIT 50
      `;
    } else if (taskId) {
      results = await prisma.$queryRaw<LogRow[]>`
        SELECT id, "taskId", status, "startedAt", "finishedAt",
               "exitReason", "durationMs", "outputSummary", "errorMessage", "createdAt"
        FROM "ExecutionLog"
        WHERE "taskId" = ${taskId}
          AND "searchVector" @@ plainto_tsquery('english', ${q})
        ORDER BY "createdAt" DESC
        LIMIT 50
      `;
    } else {
      results = await prisma.$queryRaw<LogRow[]>`
        SELECT id, "taskId", status, "startedAt", "finishedAt",
               "exitReason", "durationMs", "outputSummary", "errorMessage", "createdAt"
        FROM "ExecutionLog"
        WHERE "searchVector" @@ plainto_tsquery('english', ${q})
        ORDER BY "createdAt" DESC
        LIMIT 50
      `;
    }

    return Response.json({ results, count: results.length });
  } catch (err) {
    return serverError("execution-logs/search GET", err);
  }
}
