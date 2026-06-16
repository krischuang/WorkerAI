import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import fs from "fs";
import path from "path";

// Max upload size: 50 MB
const MAX_BYTES = 50 * 1024 * 1024;

function artifactDir(taskId: string): string {
  const base = process.env.ARTIFACT_STORAGE_PATH ?? path.join(process.cwd(), "artifacts");
  return path.join(base, taskId);
}

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { id } = await ctx.params;

  const task = await prisma.task.findUnique({ where: { id }, select: { id: true } });
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  const [artifacts, usageAgg, limitMb] = await Promise.all([
    prisma.taskArtifact.findMany({
      where: { taskId: id },
      select: { id: true, filename: true, sizeBytes: true, mimeType: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.taskArtifact.aggregate({
      where: { taskId: id },
      _sum: { sizeBytes: true },
    }),
    getTotalCapMb(),
  ]);

  const usedBytes = usageAgg._sum.sizeBytes ?? 0;
  const usedMb = Math.round((usedBytes / 1024 / 1024) * 100) / 100;

  return NextResponse.json({
    artifacts: artifacts.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })),
    usedMb,
    limitMb,
  });
}

const DEFAULT_TOTAL_CAP_MB = 500;

async function getTotalCapMb(): Promise<number> {
  const cfg = await prisma.systemConfig.findUnique({
    where: { key: "artifact_max_total_mb_per_task" },
    select: { value: true },
  });
  const parsed = cfg ? parseInt(cfg.value, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOTAL_CAP_MB;
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { id } = await ctx.params;

  const task = await prisma.task.findUnique({ where: { id }, select: { id: true } });
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart form data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!file || typeof file === "string") {
    return NextResponse.json({ error: "No file field in form data" }, { status: 400 });
  }

  const blob = file as File;
  if (blob.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `File too large (max ${MAX_BYTES / 1024 / 1024} MB)` },
      { status: 413 },
    );
  }

  // Enforce per-task total storage cap
  const limitMb = await getTotalCapMb();
  const limitBytes = limitMb * 1024 * 1024;
  const usageAgg = await prisma.taskArtifact.aggregate({
    where: { taskId: id },
    _sum: { sizeBytes: true },
  });
  const usedBytes = usageAgg._sum.sizeBytes ?? 0;
  const usedMb = Math.round((usedBytes / 1024 / 1024) * 100) / 100;
  if (usedBytes + blob.size > limitBytes) {
    return NextResponse.json(
      { error: "Task artifact storage limit exceeded", limitMb, usedMb },
      { status: 413 },
    );
  }

  // Sanitise filename: strip path separators
  const originalName = blob.name.replace(/[/\\]/g, "_") || "artifact";
  const mimeType = blob.type || "application/octet-stream";

  // Create the artifact record to get the id, then use it in the path
  const artifact = await prisma.taskArtifact.create({
    data: {
      taskId: id,
      filename: originalName,
      sizeBytes: blob.size,
      mimeType,
      storagePath: "", // filled below
    },
  });

  const dir = artifactDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const storagePath = path.join(dir, `${artifact.id}_${originalName}`);

  const buffer = Buffer.from(await blob.arrayBuffer());
  fs.writeFileSync(storagePath, buffer);

  await prisma.taskArtifact.update({
    where: { id: artifact.id },
    data: { storagePath },
  });

  return NextResponse.json(
    {
      id: artifact.id,
      filename: originalName,
      sizeBytes: blob.size,
      mimeType,
      createdAt: artifact.createdAt.toISOString(),
    },
    { status: 201 },
  );
}
