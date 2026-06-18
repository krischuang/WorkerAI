import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encryptSecret } from "@/lib/task-secrets";
import { apiRateLimit, rateLimitResponse } from "@/lib/api-rate-limit";
import { emitAudit } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { id } = await ctx.params;
  const secrets = await prisma.taskSecret.findMany({
    where: { taskId: id },
    select: { key: true, createdAt: true },
    orderBy: { key: "asc" },
  });
  return NextResponse.json(secrets);
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse | Response> {
  const { id } = await ctx.params;

  const rl = apiRateLimit(`task:secrets:${id}`, 20, 60_000);
  if (rl.limited) return rateLimitResponse(rl.retryAfterSec);

  if (!process.env.TASK_SECRET_KEY) {
    return NextResponse.json(
      { error: "TASK_SECRET_KEY is not configured on the server. Set it in your .env file." },
      { status: 503 },
    );
  }

  const body = await req.json().catch(() => ({})) as { key?: unknown; value?: unknown };
  const key = typeof body.key === "string" ? body.key.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_") : "";
  const value = typeof body.value === "string" ? body.value : "";

  if (!key || !/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    return NextResponse.json({ error: "key must be a valid env var name (A-Z, 0-9, _)" }, { status: 400 });
  }
  if (!value) {
    return NextResponse.json({ error: "value is required" }, { status: 400 });
  }

  const task = await prisma.task.findUnique({ where: { id }, select: { id: true } });
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  const encryptedValue = encryptSecret(value);
  await prisma.taskSecret.upsert({
    where: { taskId_key: { taskId: id, key } },
    create: { taskId: id, key, encryptedValue },
    update: { encryptedValue },
  });

  await emitAudit({
    entityType: "TaskSecret",
    entityId: `${id}:${key}`,
    eventType: "secret.created",
    actorType: "user",
    payload: { key },
  });

  return NextResponse.json({ key }, { status: 201 });
}
