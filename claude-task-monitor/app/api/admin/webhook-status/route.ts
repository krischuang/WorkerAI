import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";

export async function GET() {
  try {
    const rows = await prisma.systemConfig.findMany({
      where: { key: { in: ["webhook_url", "webhook_last_delivery", "webhook_last_failure"] } },
      select: { key: true, value: true },
    });
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

    const webhookUrl = map["webhook_url"] ?? process.env.WEBHOOK_URL ?? "";
    const configured = !!webhookUrl.trim();

    const lastDelivery = map["webhook_last_delivery"]
      ? (JSON.parse(map["webhook_last_delivery"]) as { timestamp: string; status: string })
      : null;

    const lastFailure = map["webhook_last_failure"]
      ? (JSON.parse(map["webhook_last_failure"]) as {
          timestamp: string;
          eventType: string;
          statusCode: number | null;
          error: string;
        })
      : null;

    return Response.json({ configured, lastDelivery, lastFailure });
  } catch (err) {
    return serverError("admin/webhook-status GET", err);
  }
}
