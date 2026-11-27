import { createYoga } from "graphql-yoga";
import { schema } from "@/lib/graphql/schema";
import type { NextRequest } from "next/server";

// Auth is handled by middleware.ts exactly like every other /api/** route in
// this app (the AUTH_SECRET cookie check) - this path is not in
// isPublicPath or isServiceAccountPath, so it is covered automatically.
// GraphiQL (the in-browser explorer) is left enabled since it only renders
// behind that same auth check.
const { handleRequest } = createYoga({
  schema,
  graphqlEndpoint: "/api/graphql",
  fetchAPI: { Request, Response },
});

// Next.js 15's route-handler type checker rejects re-exporting
// `handleRequest` directly: its second parameter type
// (Partial<ServerAdapterInitialContext>) doesn't match the shape Next.js
// generates for route context. Wrapping in single-argument functions keeps
// the exported signatures compatible with `next build`'s validator.
export async function GET(request: NextRequest) {
  return handleRequest(request, {});
}

export async function POST(request: NextRequest) {
  return handleRequest(request, {});
}

export async function OPTIONS(request: NextRequest) {
  return handleRequest(request, {});
}
