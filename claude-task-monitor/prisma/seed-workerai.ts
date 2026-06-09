import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../app/generated/prisma/client";

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const prisma = new PrismaClient({ adapter });

const INSTRUCTIONS = (specific: string) =>
  `Before starting:\n1. Read CLAUDE.md thoroughly.\n\n${specific}\n\nAfter all changes:\n- git commit (no Co-Authored-By line)\n- git push`;

async function main() {
  let project = await prisma.project.findFirst({ where: { name: "WorkerAI" } });
  if (!project) {
    project = await prisma.project.create({
      data: {
        name: "WorkerAI",
        description: "Claude task monitor — self-improvement tasks for the WorkerAI platform",
        priority: "P1",
        status: "active",
      },
    });
    console.log("Created WorkerAI project");
  } else {
    console.log("Using existing WorkerAI project");
  }

  const tasks = [
    {
      title: "Show queue depth badge on server cards",
      description: INSTRUCTIONS(
        "On the /servers page, add a small badge to each server card showing how many tasks are currently queued for that server. Fetch the count from the existing server API response (or add it). Use a violet badge for queued, blue for running."
      ),
      priority: "P2" as const,
      taskType: "coding" as const,
      estimatedCostLevel: "low" as const,
    },
    {
      title: "Add bulk delete for completed tasks",
      description: INSTRUCTIONS(
        "On the /tasks page, add a 'Clear completed' button that deletes all completed tasks in one click. Show a confirmation dialog before deleting. Wire it to a new DELETE /api/tasks endpoint that accepts { status: 'completed' } as a filter."
      ),
      priority: "P2" as const,
      taskType: "coding" as const,
      estimatedCostLevel: "low" as const,
    },
    {
      title: "Show last run timestamp in task list",
      description: INSTRUCTIONS(
        "In the task list table/cards on /tasks, show 'Last run X mins ago' using the most recent ExecutionLog startedAt. The task list API at GET /api/tasks should include the latest executionLog startedAt in the response."
      ),
      priority: "P3" as const,
      taskType: "coding" as const,
      estimatedCostLevel: "low" as const,
    },
    {
      title: "Add status filter tabs to task list page",
      description: INSTRUCTIONS(
        "On the /tasks page, add filter tabs for: All / Pending / Queued / Running / Completed / Failed. The tabs should filter the displayed list client-side (no extra API calls). Highlight the active tab. Default to 'All'."
      ),
      priority: "P3" as const,
      taskType: "coding" as const,
      estimatedCostLevel: "low" as const,
    },
    {
      title: "Add running task count to dashboard stats",
      description: INSTRUCTIONS(
        "The dashboard at /dashboard currently shows aggregate counts. Add a 'Queued' count card alongside the existing ones. Also show the total number of servers in 'connected' status. Pull these from the existing GET /api/dashboard response (extend it if needed)."
      ),
      priority: "P3" as const,
      taskType: "coding" as const,
      estimatedCostLevel: "low" as const,
    },
    {
      title: "Add archive flow: Review button on completed tasks",
      description: INSTRUCTIONS(
        `Implement the archive review flow for completed tasks:

1. Schema: Add 'archived' to the TaskStatus enum in prisma/schema.prisma. Run db:migrate.

2. API — new POST /api/tasks/[id]/review route:
   - Reads the task's title, description, resultSummary, and latest ExecutionLog.
   - Sends a structured prompt to Claude (via sendTaskToTmux) asking it to verify whether the task was truly completed.
   - The prompt must instruct Claude to reply with exactly one line: 'VERDICT: done' or 'VERDICT: incomplete'.
   - Poll tmux capture-pane (up to 30 s, 2 s intervals) for the verdict line.
   - If 'done'  → update task status to 'archived'.
   - If 'incomplete' → update task status to 'pending', clear resultSummary.
   - Return { verdict: 'done' | 'incomplete', status: newStatus }.

3. UI — task detail page (app/tasks/[id]/page.tsx):
   - When task.status === 'completed': show a 'Review' button (secondary style) next to the existing status.
   - Clicking 'Review' calls POST /api/tasks/[id]/review and shows a loading state ('Reviewing…').
   - On success, update the displayed status to 'archived' or 'pending' based on the response.
   - Show a brief result banner: green 'Archived — Claude confirmed complete' or amber 'Back to pending — Claude found it incomplete'.

4. Anywhere task status badges are shown, add 'archived' as a grey/slate badge.`
      ),
      priority: "P2" as const,
      taskType: "coding" as const,
      estimatedCostLevel: "medium" as const,
    },
  ];

  let created = 0;
  for (const t of tasks) {
    const exists = await prisma.task.findFirst({
      where: { projectId: project.id, title: t.title },
    });
    if (!exists) {
      await prisma.task.create({ data: { projectId: project.id, ...t } });
      console.log(`  + ${t.title}`);
      created++;
    } else {
      console.log(`  ~ skipped (exists): ${t.title}`);
    }
  }

  console.log(`\nDone — created ${created} task(s).`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
