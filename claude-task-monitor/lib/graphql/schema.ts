import { createSchema } from "graphql-yoga";
import { prisma } from "@/lib/prisma";

// Read-only GraphQL query layer over the existing Prisma models. Mutations
// intentionally live only in the REST routes under app/api/**, since those
// already carry the validation and side effects (tmux session checks,
// admin audit logging, etc.) that a GraphQL mutation would otherwise have
// to duplicate. This endpoint is for querying, not writing.

const typeDefs = /* GraphQL */ `
  type Server {
    id: ID!
    name: String!
    host: String!
    status: String!
    lastCheckedAt: String
  }

  type Agent {
    id: ID!
    name: String!
    slug: String!
    status: String!
    workDir: String!
    tags: [String!]!
    healthScore: Int
    server: Server!
    taskCount: Int!
  }

  type ExecutionLog {
    id: ID!
    taskId: ID!
    startedAt: String!
    finishedAt: String
    status: String!
    durationMs: Int
    tokenCount: Int
    actualCostUsd: Float
    errorMessage: String
  }

  type Task {
    id: ID!
    title: String!
    description: String
    priority: String!
    status: String!
    taskType: String!
    createdAt: String!
    updatedAt: String!
    project: Project!
    agent: Agent
    executionLogs: [ExecutionLog!]!
  }

  type Project {
    id: ID!
    name: String!
    description: String
    priority: String!
    status: String!
    completionPct: Float
    totalTasks: Int
    completedTasks: Int
    failedTasks: Int
    createdAt: String!
    tasks(status: String, limit: Int): [Task!]!
  }

  type Query {
    projects(status: String, limit: Int = 20): [Project!]!
    project(id: ID!): Project
    tasks(projectId: ID, status: String, limit: Int = 50): [Task!]!
    task(id: ID!): Task
    agents(serverId: ID): [Agent!]!
    agent(id: ID!): Agent
    executionLogs(taskId: ID!, limit: Int = 20): [ExecutionLog!]!
  }
`;

// Hard ceiling independent of whatever a caller asks for, so a client can't
// request limit: 1000000 and force an unbounded table scan.
const MAX_LIMIT = 200;
function boundedLimit(requested: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(requested ?? fallback, MAX_LIMIT));
}

const resolvers = {
  Query: {
    projects: (_: unknown, args: { status?: string; limit?: number }) =>
      prisma.project.findMany({
        where: args.status ? { status: args.status as never } : undefined,
        orderBy: { updatedAt: "desc" },
        take: boundedLimit(args.limit, 20),
      }),
    project: (_: unknown, args: { id: string }) =>
      prisma.project.findUnique({ where: { id: args.id } }),
    tasks: (_: unknown, args: { projectId?: string; status?: string; limit?: number }) =>
      prisma.task.findMany({
        where: {
          projectId: args.projectId,
          status: args.status as never,
        },
        orderBy: { createdAt: "desc" },
        take: boundedLimit(args.limit, 50),
      }),
    task: (_: unknown, args: { id: string }) =>
      prisma.task.findUnique({ where: { id: args.id } }),
    agents: (_: unknown, args: { serverId?: string }) =>
      prisma.agent.findMany({
        where: args.serverId ? { serverId: args.serverId } : undefined,
        include: { server: true },
        orderBy: { name: "asc" },
      }),
    agent: (_: unknown, args: { id: string }) =>
      prisma.agent.findUnique({ where: { id: args.id }, include: { server: true } }),
    executionLogs: (_: unknown, args: { taskId: string; limit?: number }) =>
      prisma.executionLog.findMany({
        where: { taskId: args.taskId },
        orderBy: { startedAt: "desc" },
        take: boundedLimit(args.limit, 20),
      }),
  },

  Project: {
    tasks: (
      parent: { id: string },
      args: { status?: string; limit?: number },
    ) =>
      prisma.task.findMany({
        where: { projectId: parent.id, status: args.status as never },
        orderBy: { createdAt: "desc" },
        take: boundedLimit(args.limit, 50),
      }),
  },

  Task: {
    project: (parent: { projectId: string }) =>
      prisma.project.findUniqueOrThrow({ where: { id: parent.projectId } }),
    agent: (parent: { agentId: string | null }) =>
      parent.agentId
        ? prisma.agent.findUnique({ where: { id: parent.agentId }, include: { server: true } })
        : null,
    executionLogs: (parent: { id: string }) =>
      prisma.executionLog.findMany({
        where: { taskId: parent.id },
        orderBy: { startedAt: "desc" },
        take: 20,
      }),
  },

  Agent: {
    taskCount: (parent: { id: string }) =>
      prisma.task.count({ where: { agentId: parent.id } }),
  },
};

export const schema = createSchema({ typeDefs, resolvers });
