/**
 * GitHub REST API integration for reading and writing repository content
 * without requiring a local clone.
 *
 * All functions operate against the public GitHub REST API v3.
 * Set GITHUB_TOKEN env var to increase rate limits and access private repos.
 */

const GITHUB_API = "https://api.github.com";

function authHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function repoOwnerAndName(repoUrl: string): { owner: string; repo: string } {
  // Accepts both https://github.com/owner/repo[.git] and git@github.com:owner/repo[.git]
  const httpsMatch = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!httpsMatch) throw new Error(`Cannot parse GitHub repo URL: ${repoUrl}`);
  return { owner: httpsMatch[1], repo: httpsMatch[2].replace(/\.git$/, "") };
}

export interface GitHubFileContent {
  path: string;
  content: string; // decoded text
  sha: string;
  size: number;
  encoding: string;
  downloadUrl: string | null;
}

export interface GitHubTreeEntry {
  path: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
  url: string;
}

/**
 * Fetch decoded text content of a single file from GitHub.
 * Throws if the path is a directory or not found.
 */
export async function getFileContents(
  repoUrl: string,
  filePath: string,
  ref = "main",
): Promise<GitHubFileContent> {
  const { owner, repo } = repoOwnerAndName(repoUrl);
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", ...authHeaders() },
  });
  if (!res.ok) {
    throw new Error(`GitHub contents API ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    path: string;
    content: string;
    sha: string;
    size: number;
    encoding: string;
    download_url: string | null;
  };
  if (!data.content) throw new Error(`${filePath} is a directory or empty`);
  const decoded = Buffer.from(data.content, "base64").toString("utf-8");
  return {
    path: data.path,
    content: decoded,
    sha: data.sha,
    size: data.size,
    encoding: data.encoding,
    downloadUrl: data.download_url,
  };
}

/**
 * List the flat tree of all files/dirs in a repository at a given ref.
 * Uses the git trees API with recursive=1 for a single round-trip.
 */
export async function listRepositoryTree(
  repoUrl: string,
  ref = "main",
): Promise<GitHubTreeEntry[]> {
  const { owner, repo } = repoOwnerAndName(repoUrl);
  const url = `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", ...authHeaders() },
  });
  if (!res.ok) {
    throw new Error(`GitHub trees API ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    tree: Array<{ path: string; type: string; sha: string; size?: number; url: string }>;
    truncated: boolean;
  };
  if (data.truncated) {
    console.warn(`[github-api] tree for ${repoUrl} was truncated — some paths may be missing`);
  }
  return data.tree.map((e) => ({
    path: e.path,
    type: e.type as "blob" | "tree",
    sha: e.sha,
    size: e.size,
    url: e.url,
  }));
}

/**
 * Create or update a file in the repository via the GitHub contents API.
 * For new files, omit `currentSha`. For updates, pass the blob SHA of the
 * existing file (returned by getFileContents).
 *
 * Only suitable for text files ≤ 1 MB. For larger files, clone instead.
 */
export async function upsertFile(opts: {
  repoUrl: string;
  filePath: string;
  content: string; // plain text
  commitMessage: string;
  branch?: string;
  currentSha?: string; // required when updating an existing file
  committerName?: string;
  committerEmail?: string;
}): Promise<{ commitSha: string; fileSha: string }> {
  const { owner, repo } = repoOwnerAndName(opts.repoUrl);
  const branch = opts.branch ?? "main";
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${opts.filePath}`;

  const body: Record<string, unknown> = {
    message: opts.commitMessage,
    content: Buffer.from(opts.content, "utf-8").toString("base64"),
    branch,
    ...(opts.currentSha ? { sha: opts.currentSha } : {}),
    ...(opts.committerName && opts.committerEmail
      ? { committer: { name: opts.committerName, email: opts.committerEmail } }
      : {}),
  };

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`GitHub upsert API ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    commit: { sha: string };
    content: { sha: string };
  };
  return { commitSha: data.commit.sha, fileSha: data.content.sha };
}
