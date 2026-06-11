import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import type { NextRequest } from "next/server";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const activeOnly = searchParams.get("active") === "true";

    const resumes = await prisma.scheduledResume.findMany({
      where: activeOnly ? { triggered: false } : undefined,
      orderBy: { resumeAt: "asc" },
    });

    return Response.json(resumes);
  } catch (err) {
    return serverError("scheduled-resumes GET", err);
  }
}
