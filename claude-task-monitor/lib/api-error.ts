export function serverError(tag: string, err: unknown): Response {
  console.error(`[${tag}]`, err);
  return Response.json({ error: "Internal server error" }, { status: 500 });
}
