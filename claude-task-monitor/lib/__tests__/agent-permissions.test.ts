import { describe, it, expect } from "vitest";
import { inferRequiredPermissions, AgentPermission } from "../agent-permissions";

// ── inferRequiredPermissions ───────────────────────────────────────────────────

describe("agent permissions — inferRequiredPermissions", () => {
  it("always includes READ_FILES", () => {
    const perms = inferRequiredPermissions({ title: "any task", description: null });
    expect(perms).toContain(AgentPermission.READ_FILES);
  });

  it("infers WRITE_FILES for 'fix' tasks", () => {
    const perms = inferRequiredPermissions({ title: "fix the failing test" });
    expect(perms).toContain(AgentPermission.WRITE_FILES);
  });

  it("infers WRITE_FILES for 'create' tasks", () => {
    const perms = inferRequiredPermissions({ title: "create a new component" });
    expect(perms).toContain(AgentPermission.WRITE_FILES);
  });

  it("infers RUN_TESTS when description mentions tests", () => {
    const perms = inferRequiredPermissions({
      title: "update auth logic",
      description: "run the vitest suite to verify",
    });
    expect(perms).toContain(AgentPermission.RUN_TESTS);
  });

  it("infers COMMIT_CODE for commit tasks", () => {
    const perms = inferRequiredPermissions({ title: "commit the changes and push" });
    expect(perms).toContain(AgentPermission.COMMIT_CODE);
  });

  it("infers CREATE_PR for PR tasks", () => {
    const perms = inferRequiredPermissions({ title: "open a pull request with the changes" });
    expect(perms).toContain(AgentPermission.CREATE_PR);
  });

  it("infers DEPLOY_STAGING for staging deployment tasks", () => {
    const perms = inferRequiredPermissions({ title: "deploy the build to staging" });
    expect(perms).toContain(AgentPermission.DEPLOY_STAGING);
  });

  it("infers DEPLOY_PRODUCTION for production deployment tasks", () => {
    const perms = inferRequiredPermissions({ title: "release to production" });
    expect(perms).toContain(AgentPermission.DEPLOY_PRODUCTION);
  });

  it("infers ACCESS_SECRETS when secrets are mentioned", () => {
    const perms = inferRequiredPermissions({
      title: "update the API key",
      description: "read the secret from the .env file",
    });
    expect(perms).toContain(AgentPermission.ACCESS_SECRETS);
  });

  it("infers NETWORK_EGRESS for HTTP API tasks", () => {
    const perms = inferRequiredPermissions({
      title: "fetch data from the external API",
      description: "use curl to call the endpoint",
    });
    expect(perms).toContain(AgentPermission.NETWORK_EGRESS);
  });

  it("infers MODIFY_CI for GitHub Actions tasks", () => {
    const perms = inferRequiredPermissions({
      title: "update the GitHub Actions workflow",
    });
    expect(perms).toContain(AgentPermission.MODIFY_CI);
  });

  it("infers EXECUTE_COMMANDS for shell script tasks", () => {
    const perms = inferRequiredPermissions({
      title: "run the build script",
      description: "execute the bash setup script",
    });
    expect(perms).toContain(AgentPermission.EXECUTE_COMMANDS);
  });

  it("returns minimal permissions for a read-only research task", () => {
    const perms = inferRequiredPermissions({
      title: "research the best approach for caching",
      description: "review the existing documentation",
    });
    expect(perms).toContain(AgentPermission.READ_FILES);
    expect(perms).not.toContain(AgentPermission.DEPLOY_PRODUCTION);
    expect(perms).not.toContain(AgentPermission.ACCESS_SECRETS);
  });
});
