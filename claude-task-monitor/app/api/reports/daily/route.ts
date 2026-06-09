import { prisma } from "@/lib/prisma";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 60;

const anthropic = new Anthropic();

export async function GET() {
  const reports = await prisma.dailyReport.findMany({
    orderBy: { date: "desc" },
    take: 30,
  });
  return Response.json(reports);
}

export async function POST() {
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
        take: 10,
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

  // Build structured data for Claude
  const dataForClaude = {
    date: now.toDateString(),
    completedToday: completedToday.map((t) => ({
      project: t.project.name,
      title: t.title,
    })),
    failedToday: failedToday.map((t) => ({
      project: t.project.name,
      title: t.title,
    })),
    currentlyRunning: running.map((t) => ({
      project: t.project.name,
      title: t.title,
    })),
    pendingTasks: pending.map((t) => ({
      project: t.project.name,
      priority: t.priority,
      title: t.title,
    })),
    activeProjects: allProjects.map((p) => ({
      name: p.name,
      priority: p.priority,
      pendingTaskCount: p.tasks.length,
    })),
  };

  const prompt = `You are an AI assistant generating a daily work report for an AI-assisted software development team.

Here is today's task data (${dataForClaude.date}):

**Completed Today (${dataForClaude.completedToday.length} tasks):**
${dataForClaude.completedToday.length > 0 ? dataForClaude.completedToday.map((t) => `- [${t.project}] ${t.title}`).join("\n") : "None"}

**Currently Running (${dataForClaude.currentlyRunning.length} tasks):**
${dataForClaude.currentlyRunning.length > 0 ? dataForClaude.currentlyRunning.map((t) => `- [${t.project}] ${t.title}`).join("\n") : "None"}

**Failed Today (${dataForClaude.failedToday.length} tasks):**
${dataForClaude.failedToday.length > 0 ? dataForClaude.failedToday.map((t) => `- [${t.project}] ${t.title}`).join("\n") : "None"}

**Pending Tasks (top ${dataForClaude.pendingTasks.length} by priority):**
${dataForClaude.pendingTasks.length > 0 ? dataForClaude.pendingTasks.map((t) => `- [${t.priority}] [${t.project}] ${t.title}`).join("\n") : "None"}

**Active Projects:**
${dataForClaude.activeProjects.map((p) => `- ${p.name} (${p.priority}) — ${p.pendingTaskCount} pending tasks`).join("\n")}

Generate a concise, insightful daily report in Markdown format. Include:
1. **Summary** — 2-3 sentence overview of today's progress
2. **Highlights** — key wins or notable completions (if any)
3. **In Progress** — what is currently running and any concerns
4. **Blockers & Issues** — analysis of failed tasks and what they suggest (if any)
5. **Recommended Next Actions** — prioritised suggestions for what to tackle next, based on the pending queue
6. **Focus for Tomorrow** — which project deserves the most attention and why

Be specific, actionable, and concise. Avoid generic filler.`;

  let reportText: string;

  try {
    const message = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: prompt }],
    });

    const textBlock = message.content.find((b) => b.type === "text");
    reportText = textBlock && textBlock.type === "text"
      ? textBlock.text
      : fallbackReport(now, completedToday, running, failedToday, pending, topProject);
  } catch (err) {
    console.error("[daily-report] Claude API error:", err);
    reportText = fallbackReport(now, completedToday, running, failedToday, pending, topProject);
  }

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
}

function fallbackReport(
  now: Date,
  completed: { title: string; project: { name: string } }[],
  running: { title: string; project: { name: string } }[],
  failed: { title: string; project: { name: string } }[],
  pending: { title: string; priority: string; project: { name: string; priority: string; status: string } }[],
  topProject: { name: string; priority: string } | null
): string {
  const completedLines = completed.length
    ? completed.map((t) => `- [${t.project.name}] ${t.title}`).join("\n")
    : "None";
  const failedLines = failed.length
    ? failed.map((t) => `- [${t.project.name}] ${t.title}`).join("\n")
    : "None";
  const runningLines = running.length
    ? running.map((t) => `- [${t.project.name}] ${t.title}`).join("\n")
    : "None";
  const nextLines = pending.length
    ? pending.map((t) => `- [${t.priority}] [${t.project.name}] ${t.title}`).join("\n")
    : "None";

  return `# Daily Report — ${now.toDateString()}

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
}
