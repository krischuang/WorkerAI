import { createYoga } from "graphql-yoga";
import { schema } from "@/lib/graphql/schema";

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

export { handleRequest as GET, handleRequest as POST, handleRequest as OPTIONS };
