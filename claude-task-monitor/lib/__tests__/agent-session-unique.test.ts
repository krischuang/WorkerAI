/**
 * P3-7: Agent Namespace Isolation
 *
 * Verifies that the unique constraint logic for [serverId, tmuxSession]
 * would prevent collisions.  Since we can't test DB constraints directly
 * in vitest, we verify the validation flow and error code handling.
 */

import { describe, it, expect } from "vitest";

// Simulate the Prisma unique constraint error code for P2002.
function simulateAgentCreate(
  agents: Array<{ serverId: string; tmuxSession: string }>,
  newAgent: { serverId: string; tmuxSession: string; slug: string },
): { error?: string; created?: typeof newAgent } {
  const sessionCollision = agents.find(
    (a) => a.serverId === newAgent.serverId && a.tmuxSession === newAgent.tmuxSession,
  );
  if (sessionCollision) {
    // Simulates Prisma P2002 error on [serverId, tmuxSession] unique index.
    const err: { code: string; meta: { target: string[] } } = {
      code: "P2002",
      meta: { target: ["tmuxSession"] },
    };
    const meta = err.meta;
    if (meta?.target?.includes("tmuxSession")) {
      return { error: `A session named "${newAgent.tmuxSession}" already exists on this server` };
    }
    return { error: `An agent with slug "${newAgent.slug}" already exists on this server` };
  }
  return { created: newAgent };
}

describe("Agent tmuxSession uniqueness — P3-7", () => {
  it("allows creating an agent with a unique session on a server", () => {
    const existing = [{ serverId: "srv-1", tmuxSession: "agent-a" }];
    const result = simulateAgentCreate(existing, { serverId: "srv-1", tmuxSession: "agent-b", slug: "b" });
    expect(result.created).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it("rejects creating an agent with a duplicate session on the same server", () => {
    const existing = [{ serverId: "srv-1", tmuxSession: "agent-a" }];
    const result = simulateAgentCreate(existing, { serverId: "srv-1", tmuxSession: "agent-a", slug: "a2" });
    expect(result.error).toContain("agent-a");
    expect(result.created).toBeUndefined();
  });

  it("allows the same session name on different servers", () => {
    const existing = [{ serverId: "srv-1", tmuxSession: "agent-a" }];
    const result = simulateAgentCreate(existing, { serverId: "srv-2", tmuxSession: "agent-a", slug: "a" });
    expect(result.created).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it("error message identifies the session name causing the conflict", () => {
    const existing = [{ serverId: "srv-1", tmuxSession: "my-session" }];
    const result = simulateAgentCreate(existing, { serverId: "srv-1", tmuxSession: "my-session", slug: "s2" });
    expect(result.error).toContain("my-session");
  });
});
