import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import fs from "fs";

type Ctx = { params: Promise<{ id: string; artifactId: string }> };

export async function GET(_req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { id, artifactId } = await ctx.params;

  const artifact = await prisma.taskArtifact.findUnique({
    where: { id: artifactId },
    select: { id: true, taskId: true, filename: true, mimeType: true, storagePath: true },
  });

  if (!artifact || artifact.taskId !== id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!fs.existsSync(artifact.storagePath)) {
    return NextResponse.json({ error: "File not found on disk" }, { status: 404 });
  }

  const buffer = fs.readFileSync(artifact.storagePath);

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type": artifact.mimeType,
      "Content-Disposition": `attachment; filename="${artifact.filename}"`,
      "Content-Length": String(buffer.length),
      "Cache-Control": "private, no-cache",
    },
  });
}
