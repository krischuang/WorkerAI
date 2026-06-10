import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";

export async function GET() {
  try {
    const reports = await prisma.dailyReport.findMany({
      orderBy: { date: "desc" },
      take: 30,
    });
    return Response.json(reports);
  } catch (err) {
    return serverError("reports/daily GET", err);
  }
}

export async function POST() {
  try {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const [completedToday, failedToday, running, pending, allProjects] =
      await Promise.all([
        prisma.task.findMany({
          where: { status: "completed", updatedAt: { gte: startOfDay } },
          include: { project: { select: { name: true } } },
        }),
        prisma.task.findMany({
          where: { status: "failed", updatedAt: { gte: startOfDay } },
          include: { project: { select: { name: true } } },
        }),
        prisma.task.findMany({
          where: { status: "running" },
          include: { project: { select: { name: true } } },
        }),
        prisma.task.findMany({
          where: { status: "pending" },
          include: {
            project: { select: { name: true, priority: true, status: true } },
          },
          orderBy: [{ priority: "asc" }],
          take: 5,
        }),
        prisma.project.findMany({
          where: { status: "active" },
          include: {
            tasks: { where: { status: "pending" }, select: { priority: true } },
          },
          orderBy: { priority: "asc" },
        }),
      ]);

    const topProject = allProjects[0] ?? null;

    const completedLines = completedToday.length
      ? completedToday.map((t) => `- [${t.project.name}] ${t.title}`).join("\n")
      : "None";

    const failedLines = failedToday.length
      ? failedToday.map((t) => `- [${t.project.name}] ${t.title}`).join("\n")
      : "None";

    const runningLines = running.length
      ? running.map((t) => `- [${t.project.name}] ${t.title}`).join("\n")
      : "None";

    const nextLines = pending.length
      ? pending
          .map((t) => `- [${t.priority}] [${t.project.name}] ${t.title}`)
          .join("\n")
      : "None";

    const reportText = `# Daily Report — ${now.toDateString()}

## Completed Today
${completedLines}

## Currently Running
${runningLines}

## Failed Today
${failedLines}

## Recommended Next Tasks
${nextLines}

## Highest Priority Project Tomorrow
${topProject ? `${topProject.name} (${topProject.priority})` : "N/A"}
`;

    const report = await prisma.dailyReport.create({
      data: {
        date: now,
        completedCount: completedToday.length,
        failedCount: failedToday.length,
        runningCount: running.length,
        pendingCount: pending.length,
        reportText,
        topProjectId: topProject?.id ?? null,
        topProjectName: topProject?.name ?? null,
      },
    });

    return Response.json(report, { status: 201 });
  } catch (err) {
    return serverError("reports/daily POST", err);
  }
}
