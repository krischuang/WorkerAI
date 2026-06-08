import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../app/generated/prisma/client";

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const prisma = new PrismaClient({ adapter });

async function main() {
  // Clear existing data
  await prisma.executionLog.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
  await prisma.dailyReport.deleteMany();

  // Tarot AI Project
  const tarot = await prisma.project.create({
    data: {
      name: "Tarot AI",
      description:
        "AI-powered tarot reading platform with personalized interpretations and daily card pulls",
      priority: "P1",
      status: "active",
    },
  });

  // Quant Platform
  const quant = await prisma.project.create({
    data: {
      name: "Quant Platform",
      description:
        "Quantitative trading strategy research platform with backtesting and live signal generation",
      priority: "P2",
      status: "active",
    },
  });

  // Research Project
  const research = await prisma.project.create({
    data: {
      name: "Research Project",
      description:
        "Ongoing research into AI agent architectures and multi-agent coordination patterns",
      priority: "P3",
      status: "active",
    },
  });

  // Job Search
  const jobSearch = await prisma.project.create({
    data: {
      name: "Job Search",
      description:
        "Targeted job search campaign focusing on AI/ML engineering roles at leading labs",
      priority: "P2",
      status: "active",
    },
  });

  // Tarot AI Tasks
  const t1 = await prisma.task.create({
    data: {
      projectId: tarot.id,
      title: "Design tarot card interpretation prompt system",
      description:
        "Create a structured prompt system that provides rich, personalized tarot interpretations based on card position, spread type, and user context",
      priority: "P1",
      status: "completed",
      taskType: "coding",
      estimatedCostLevel: "medium",
      resultSummary:
        "Designed a 3-layer prompt system: base card meaning → positional context → personal integration. Works well for Celtic Cross spread.",
      nextAction:
        "Expand to cover Horseshoe and custom spreads. Add reversal handling.",
    },
  });

  const t2 = await prisma.task.create({
    data: {
      projectId: tarot.id,
      title: "Build daily card pull feature",
      description:
        "Daily card pull with persistent history, journaling, and pattern tracking over time",
      priority: "P1",
      status: "running",
      taskType: "coding",
      estimatedCostLevel: "medium",
    },
  });

  await prisma.task.create({
    data: {
      projectId: tarot.id,
      title: "Research tarot symbolism database",
      description:
        "Compile a comprehensive database of tarot symbolism, numerology, and astrological associations",
      priority: "P2",
      status: "pending",
      taskType: "research",
      estimatedCostLevel: "low",
    },
  });

  await prisma.task.create({
    data: {
      projectId: tarot.id,
      title: "Design landing page copy and UI flow",
      description:
        "Write compelling landing page copy and design the user onboarding flow",
      priority: "P3",
      status: "pending",
      taskType: "writing",
      estimatedCostLevel: "low",
    },
  });

  // Quant Platform Tasks
  await prisma.task.create({
    data: {
      projectId: quant.id,
      title: "Implement momentum strategy backtester",
      description:
        "Build a vectorized backtesting engine for momentum strategies with configurable lookback periods and rebalancing frequency",
      priority: "P1",
      status: "pending",
      taskType: "coding",
      estimatedCostLevel: "high",
    },
  });

  await prisma.task.create({
    data: {
      projectId: quant.id,
      title: "Research mean reversion alpha signals",
      description:
        "Survey academic literature on mean reversion signals for equities, identify top 5 implementable strategies",
      priority: "P2",
      status: "pending",
      taskType: "research",
      estimatedCostLevel: "low",
    },
  });

  await prisma.task.create({
    data: {
      projectId: quant.id,
      title: "Set up data pipeline for market data ingestion",
      description:
        "Configure automated data pipeline pulling OHLCV data from multiple sources with quality checks",
      priority: "P2",
      status: "failed",
      taskType: "coding",
      estimatedCostLevel: "medium",
      resultSummary:
        "Polygon.io API has rate limits that make real-time ingestion infeasible at free tier.",
      nextAction:
        "Evaluate Alpaca or Interactive Brokers data feeds as alternatives.",
    },
  });

  // Research Project Tasks
  await prisma.task.create({
    data: {
      projectId: research.id,
      title: "Summarize recent multi-agent coordination papers",
      description:
        "Review 10 recent papers on multi-agent LLM systems and summarize key architectural patterns",
      priority: "P2",
      status: "pending",
      taskType: "research",
      estimatedCostLevel: "low",
    },
  });

  await prisma.task.create({
    data: {
      projectId: research.id,
      title: "Write blog post: Local-first AI infrastructure",
      description:
        "Technical blog post about building local-first AI workflows with Claude API and Prisma",
      priority: "P3",
      status: "pending",
      taskType: "writing",
      estimatedCostLevel: "low",
    },
  });

  await prisma.task.create({
    data: {
      projectId: research.id,
      title: "Review AutoGPT and BabyAGI architectures",
      description:
        "Code review of existing open-source agent frameworks to identify reusable patterns",
      priority: "P3",
      status: "completed",
      taskType: "review",
      estimatedCostLevel: "low",
      resultSummary:
        "Both use a task queue + tool call loop. AutoGPT has better error recovery. BabyAGI simpler to understand.",
      nextAction: "Extract tool abstraction pattern for WorkerAI architecture.",
    },
  });

  // Job Search Tasks
  await prisma.task.create({
    data: {
      projectId: jobSearch.id,
      title: "Update resume for AI/ML roles",
      description:
        "Revise resume to emphasize AI projects, LLM experience, and systems engineering background",
      priority: "P1",
      status: "completed",
      taskType: "writing",
      estimatedCostLevel: "low",
      resultSummary:
        "Resume updated. Highlighted Tarot AI and Quant Platform projects. One-page format.",
      nextAction: "Get feedback from 2-3 people in industry before applying.",
    },
  });

  await prisma.task.create({
    data: {
      projectId: jobSearch.id,
      title: "Research and apply to Anthropic research engineer roles",
      description:
        "Review open positions, customize application materials, and submit applications",
      priority: "P1",
      status: "pending",
      taskType: "research",
      estimatedCostLevel: "low",
    },
  });

  await prisma.task.create({
    data: {
      projectId: jobSearch.id,
      title: "Prepare system design interview materials",
      description:
        "Study distributed systems, ML system design, and prepare 5 detailed system design answers",
      priority: "P2",
      status: "pending",
      taskType: "research",
      estimatedCostLevel: "low",
    },
  });

  // Add execution logs for completed tasks
  await prisma.executionLog.create({
    data: {
      taskId: t1.id,
      status: "completed",
      logText:
        "Analyzed 50 example tarot readings. Designed 3-layer prompt architecture. Tested with Claude sonnet-4. Accuracy rated 8.5/10 by 3 test users.",
      outputSummary:
        "3-layer prompt system implemented. Ready for Celtic Cross spread integration.",
      finishedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    },
  });

  await prisma.executionLog.create({
    data: {
      taskId: t2.id,
      status: "running",
      logText:
        "Started database schema design for daily pull history. User model and CardPull model created.",
      startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    },
  });

  console.log("Seed completed successfully.");
  console.log(`Projects: 4`);
  console.log(`Tasks: 13`);
  console.log(`Logs: 2`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
