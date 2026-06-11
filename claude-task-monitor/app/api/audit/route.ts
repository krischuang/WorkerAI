import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";

const PAGE_SIZE = 50;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const entityType = searchParams.get("entityType");
    const entityId = searchParams.get("entityId");
    const eventType = searchParams.get("eventType");
    const since = searchParams.get("since");
    const cursor = searchParams.get("cursor");

    const where = {
      ...(entityType && { entityType }),
      ...(entityId && { entityId }),
      ...(eventType && { eventType }),
      ...(since && { createdAt: { gte: new Date(since) } }),
    };

    const events = await prisma.auditEvent.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PAGE_SIZE + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });

    const hasMore = events.length > PAGE_SIZE;
    const items = hasMore ? events.slice(0, PAGE_SIZE) : events;
    const nextCursor = hasMore ? items[items.length - 1].id : null;

    return Response.json({ events: items, nextCursor });
  } catch (err) {
    return serverError("audit GET", err);
  }
}
