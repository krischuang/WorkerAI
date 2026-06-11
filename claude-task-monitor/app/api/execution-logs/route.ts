import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const taskId = searchParams.get("taskId");
    const projectId = searchParams.get("projectId");
    const since = searchParams.get("since");
    const exitReason = searchParams.get("exitReason");
    const cursor = searchParams.get("cursor");

    const PAGE = 50;

    const where = {
      ...(taskId && { taskId }),
      ...(projectId && { task: { projectId } }),
      ...(since && { createdAt: { gte: new Date(since) } }),
      ...(exitReason && { exitReason }),
    };

    const logs = await prisma.executionLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PAGE + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      select: {
        id: true,
        taskId: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        exitReason: true,
        durationMs: true,
        retryNumber: true,
        outputSummary: true,
        errorMessage: true,
        failureReason: true,
        archivedAt: true,
        createdAt: true,
        task: { select: { title: true, projectId: true } },
      },
    });

    const hasMore = logs.length > PAGE;
    const items = hasMore ? logs.slice(0, PAGE) : logs;
    return Response.json({ logs: items, nextCursor: hasMore ? items[items.length - 1].id : null });
  } catch (err) {
    return serverError("execution-logs GET", err);
  }
}
