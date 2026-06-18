import { describe, it, expect, afterEach, vi } from "vitest";
import { GitHubOwnerNotAllowedError } from "../github-api";

// We test the allowlist logic by importing the functions and observing thrown errors
// before any network calls are made.  Actual HTTP calls are not made in these tests.

function setAllowedOwners(value: string | undefined) {
  if (value === undefined) {
    delete process.env.GITHUB_ALLOWED_OWNERS;
  } else {
    process.env.GITHUB_ALLOWED_OWNERS = value;
  }
}

const ALLOWED_OWNER = "my-org";
const BLOCKED_OWNER = "random-user";
const ALLOWED_REPO = `https://github.com/${ALLOWED_OWNER}/my-repo`;
const BLOCKED_REPO = `https://github.com/${BLOCKED_OWNER}/private-repo`;
const MALFORMED_URL = "not-a-github-url";

// Helper: call all three public functions and expect them to throw the same error.
async function expectAllFunctionsToThrow(
  repoUrl: string,
  ErrorClass: new (...args: never[]) => Error,
) {
  const { getFileContents, listRepositoryTree, upsertFile } = await import("../github-api");

  await expect(getFileContents(repoUrl, "README.md")).rejects.toBeInstanceOf(ErrorClass);
  await expect(listRepositoryTree(repoUrl)).rejects.toBeInstanceOf(ErrorClass);
  await expect(
    upsertFile({ repoUrl, filePath: "f.txt", content: "c", commitMessage: "m" }),
  ).rejects.toBeInstanceOf(ErrorClass);
}

describe("GitHubOwnerNotAllowedError", () => {
  it("has status 403", () => {
    const err = new GitHubOwnerNotAllowedError("evil-org");
    expect(err.status).toBe(403);
  });

  it("message includes the blocked owner name", () => {
    const err = new GitHubOwnerNotAllowedError("evil-org");
    expect(err.message).toContain("evil-org");
  });
});

describe("GITHUB_ALLOWED_OWNERS allowlist enforcement", () => {
  const savedEnv = process.env.GITHUB_ALLOWED_OWNERS;

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.GITHUB_ALLOWED_OWNERS;
    } else {
      process.env.GITHUB_ALLOWED_OWNERS = savedEnv;
    }
    vi.resetModules();
  });

  it("blocks a repository owned by an unapproved owner", async () => {
    setAllowedOwners(ALLOWED_OWNER);
    await expectAllFunctionsToThrow(BLOCKED_REPO, GitHubOwnerNotAllowedError);
  });

  it("allows a repository owned by an approved owner (proceeds past the guard)", async () => {
    setAllowedOwners(ALLOWED_OWNER);
    const { getFileContents } = await import("../github-api");
    // Allowed owner passes the guard; the network call fails (no real GitHub token in tests)
    // so we expect a generic Error, NOT GitHubOwnerNotAllowedError.
    await expect(getFileContents(ALLOWED_REPO, "README.md")).rejects.not.toBeInstanceOf(
      GitHubOwnerNotAllowedError,
    );
  });

  it("allows all owners when GITHUB_ALLOWED_OWNERS is not set", async () => {
    setAllowedOwners(undefined);
    const { getFileContents } = await import("../github-api");
    // No restriction configured — blocked repo passes guard, then fails on network.
    await expect(getFileContents(BLOCKED_REPO, "README.md")).rejects.not.toBeInstanceOf(
      GitHubOwnerNotAllowedError,
    );
  });

  it("allows all owners when GITHUB_ALLOWED_OWNERS is an empty string", async () => {
    setAllowedOwners("");
    const { getFileContents } = await import("../github-api");
    await expect(getFileContents(BLOCKED_REPO, "README.md")).rejects.not.toBeInstanceOf(
      GitHubOwnerNotAllowedError,
    );
  });

  it("supports multiple allowed owners separated by commas", async () => {
    setAllowedOwners(`${ALLOWED_OWNER}, another-org`);
    const { getFileContents } = await import("../github-api");
    const anotherRepo = "https://github.com/another-org/some-repo";
    await expect(getFileContents(anotherRepo, "README.md")).rejects.not.toBeInstanceOf(
      GitHubOwnerNotAllowedError,
    );
  });

  it("is case-insensitive — uppercase owner is matched", async () => {
    setAllowedOwners(ALLOWED_OWNER.toUpperCase());
    const { getFileContents } = await import("../github-api");
    await expect(getFileContents(ALLOWED_REPO, "README.md")).rejects.not.toBeInstanceOf(
      GitHubOwnerNotAllowedError,
    );
  });

  it("throws a parse error for malformed repository URLs (not an allowlist error)", async () => {
    setAllowedOwners(ALLOWED_OWNER);
    const { getFileContents } = await import("../github-api");
    await expect(getFileContents(MALFORMED_URL, "README.md")).rejects.toThrow(
      /Cannot parse GitHub repo URL/,
    );
  });
});
