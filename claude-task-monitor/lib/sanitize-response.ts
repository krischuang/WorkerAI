/**
 * Response sanitizers — strip internal infrastructure details before
 * sending server/agent data to the client.
 *
 * Fields removed:
 *   Server: sshKeyPath  (local filesystem path — reveals infra layout)
 *   Agent:  (server.sshKeyPath when nested)
 *
 * workDir and tmuxSession are kept because the admin UI needs them for
 * display and configuration purposes.  sshKeyPath is the only field that
 * serves no client-side purpose and leaks filesystem structure.
 */

export type ServerPublic<T extends { sshKeyPath: unknown }> = Omit<T, "sshKeyPath">;

/** Strip sshKeyPath from a server record before returning to the client. */
export function sanitizeServer<T extends { sshKeyPath: unknown }>(server: T): ServerPublic<T> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { sshKeyPath: _removed, ...rest } = server as Record<string, unknown>;
  return rest as ServerPublic<T>;
}

/** Strip sshKeyPath from every server in an array. */
export function sanitizeServers<T extends { sshKeyPath: unknown }>(servers: T[]): ServerPublic<T>[] {
  return servers.map(sanitizeServer);
}

/** Strip sshKeyPath from the nested server object inside an agent. */
export function sanitizeAgentServer<T extends { server?: { sshKeyPath: unknown } | null }>(
  agent: T,
): T & { server?: Omit<NonNullable<T["server"]>, "sshKeyPath"> | null } {
  if (!agent.server) return agent as unknown as T & { server?: Omit<NonNullable<T["server"]>, "sshKeyPath"> | null };
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { sshKeyPath: _removed, ...serverRest } = agent.server as Record<string, unknown>;
  return { ...agent, server: serverRest } as T & { server?: Omit<NonNullable<T["server"]>, "sshKeyPath"> | null };
}
