import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";

const DEFAULTS: Record<string, string> = {
  stall_threshold_minutes: "30",
  confirm_cycles: "2",
};

export async function GET() {
  try {
    const rows = await prisma.systemConfig.findMany({ orderBy: { key: "asc" } });
    // Merge with defaults so keys not yet written still appear.
    const config: Record<string, string> = { ...DEFAULTS };
    for (const row of rows) {
      config[row.key] = row.value;
    }
    return Response.json(config);
  } catch (err) {
    return serverError("admin/config GET", err);
  }
}

export async function PUT(request: Request) {
  try {
    const body: Record<string, string> = await request.json();

    // Only allow known config keys; ignore others.
    const allowed = new Set(Object.keys(DEFAULTS));
    const updates = Object.entries(body).filter(([k]) => allowed.has(k));

    if (updates.length === 0) {
      return Response.json({ error: "No valid config keys provided" }, { status: 400 });
    }

    await Promise.all(
      updates.map(([key, value]) =>
        prisma.systemConfig.upsert({
          where: { key },
          create: { key, value },
          update: { value },
        })
      )
    );

    return Response.json({ updated: updates.map(([k]) => k) });
  } catch (err) {
    return serverError("admin/config PUT", err);
  }
}
