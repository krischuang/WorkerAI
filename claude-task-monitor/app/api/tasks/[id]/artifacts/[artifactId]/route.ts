import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import fs from "fs";

type Ctx = { params: Promise<{ id: string; artifactId: string }> };

export async function DELETE(_req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { id, artifactId } = await ctx.params;

  const artifact = await prisma.taskArtifact.findUnique({
    where: { id: artifactId },
    select: { id: true, taskId: true, storagePath: true, filename: true },
  });

  if (!artifact || artifact.taskId !== id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Remove from disk (ignore missing file — DB record still needs to be cleaned up)
  if (artifact.storagePath && fs.existsSync(artifact.storagePath)) {
    fs.unlinkSync(artifact.storagePath);
  }

  await prisma.taskArtifact.delete({ where: { id: artifactId } });

  return new NextResponse(null, { status: 204 });
}
