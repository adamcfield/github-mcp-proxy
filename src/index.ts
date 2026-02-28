import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

const OWNER = "adamcfield";
const REPO = "rightcraft-io";
const API = "https://api.github.com";

// ── GitHub API helpers ────────────────────────────────────────────

async function ghFetch(
  path: string,
  pat: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = path.startsWith("http") ? path : `${API}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "github-mcp-worker/1.0",
      ...(options.headers || {}),
    },
  });
}

// ── MCP Agent ─────────────────────────────────────────────────────

export class GitHubMCP extends McpAgent {
  server = new McpServer({
    name: "RightCraft GitHub MCP",
    version: "1.0.0",
  });

  async init() {
    const pat = (this.env as Env).GITHUB_PAT;
    if (!pat) {
      console.error("GITHUB_PAT secret not configured");
    }

    // ── read_file ──────────────────────────────────────────────
    this.server.tool(
      "read_file",
      "Read a file from the RightCraft GitHub repository. Returns the file content as text. Use for any file: source code, markdown, JSON, config, etc.",
      {
        path: z.string().describe("File path relative to repo root, e.g. 'src/agents/customer-care/index.ts'"),
        branch: z.string().optional().describe("Branch name (defaults to 'main')"),
      },
      async ({ path, branch }) => {
        const ref = branch || "main";
        const res = await ghFetch(
          `/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}?ref=${ref}`,
          pat
        );

        if (!res.ok) {
          const err = await res.text();
          return {
            content: [{ type: "text" as const, text: `Error ${res.status}: ${err}` }],
            isError: true,
          };
        }

        const data = (await res.json()) as { content?: string; encoding?: string; size?: number; type?: string };

        if (data.type !== "file" || !data.content) {
          return {
            content: [{ type: "text" as const, text: `Path '${path}' is a directory, not a file. Use list_files instead.` }],
            isError: true,
          };
        }

        const decoded = atob(data.content.replace(/\n/g, ""));
        return {
          content: [{ type: "text" as const, text: decoded }],
        };
      }
    );

    // ── write_file ─────────────────────────────────────────────
    this.server.tool(
      "write_file",
      "Create or update a file in the RightCraft GitHub repository. Commits directly to the specified branch.",
      {
        path: z.string().describe("File path relative to repo root"),
        content: z.string().describe("The full file content to write"),
        message: z.string().describe("Git commit message"),
        branch: z.string().optional().describe("Branch name (defaults to 'main')"),
      },
      async ({ path, content, message, branch }) => {
        const ref = branch || "main";

        // Check if file exists to get its SHA (needed for updates)
        let sha: string | undefined;
        const existing = await ghFetch(
          `/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}?ref=${ref}`,
          pat
        );
        if (existing.ok) {
          const data = (await existing.json()) as { sha?: string };
          sha = data.sha;
        }

        const body: Record<string, string> = {
          message,
          content: btoa(unescape(encodeURIComponent(content))),
          branch: ref,
        };
        if (sha) body.sha = sha;

        const res = await ghFetch(
          `/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}`,
          pat,
          {
            method: "PUT",
            body: JSON.stringify(body),
          }
        );

        if (!res.ok) {
          const err = await res.text();
          return {
            content: [{ type: "text" as const, text: `Error ${res.status}: ${err}` }],
            isError: true,
          };
        }

        const result = (await res.json()) as { commit?: { sha?: string } };
        return {
          content: [
            {
              type: "text" as const,
              text: `File ${sha ? "updated" : "created"}: ${path} (commit: ${result.commit?.sha?.slice(0, 7) || "unknown"})`,
            },
          ],
        };
      }
    );

    // ── list_files ─────────────────────────────────────────────
    this.server.tool(
      "list_files",
      "List files and directories in a path within the RightCraft GitHub repository.",
      {
        path: z.string().optional().describe("Directory path relative to repo root (defaults to root)"),
        branch: z.string().optional().describe("Branch name (defaults to 'main')"),
      },
      async ({ path, branch }) => {
        const ref = branch || "main";
        const dirPath = path || "";
        const url = dirPath
          ? `/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(dirPath)}?ref=${ref}`
          : `/repos/${OWNER}/${REPO}/contents/?ref=${ref}`;

        const res = await ghFetch(url, pat);

        if (!res.ok) {
          const err = await res.text();
          return {
            content: [{ type: "text" as const, text: `Error ${res.status}: ${err}` }],
            isError: true,
          };
        }

        const items = (await res.json()) as Array<{ name: string; type: string; size?: number; path: string }>;

        if (!Array.isArray(items)) {
          return {
            content: [{ type: "text" as const, text: `Path '${dirPath}' is a file, not a directory. Use read_file instead.` }],
            isError: true,
          };
        }

        const listing = items
          .map((item) => {
            const icon = item.type === "dir" ? "📁" : "📄";
            const size = item.size ? ` (${item.size}B)` : "";
            return `${icon} ${item.path}${size}`;
          })
          .join("\n");

        return {
          content: [{ type: "text" as const, text: listing || "(empty directory)" }],
        };
      }
    );

    // ── search_files ───────────────────────────────────────────
    this.server.tool(
      "search_files",
      "Search for files or code in the RightCraft GitHub repository using GitHub's code search API.",
      {
        query: z.string().describe("Search query (code, filename, etc.)"),
      },
      async ({ query }) => {
        const res = await ghFetch(
          `/search/code?q=${encodeURIComponent(query + ` repo:${OWNER}/${REPO}`)}&per_page=20`,
          pat
        );

        if (!res.ok) {
          const err = await res.text();
          return {
            content: [{ type: "text" as const, text: `Error ${res.status}: ${err}` }],
            isError: true,
          };
        }

        const data = (await res.json()) as {
          total_count: number;
          items: Array<{ path: string; name: string }>;
        };

        if (data.total_count === 0) {
          return {
            content: [{ type: "text" as const, text: `No results found for: ${query}` }],
          };
        }

        const results = data.items
          .map((item) => `  ${item.path}`)
          .join("\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${data.total_count} result(s):\n${results}`,
            },
          ],
        };
      }
    );

    // ── list_branches ──────────────────────────────────────────
    this.server.tool(
      "list_branches",
      "List branches in the RightCraft GitHub repository.",
      {},
      async () => {
        const res = await ghFetch(
          `/repos/${OWNER}/${REPO}/branches?per_page=30`,
          pat
        );

        if (!res.ok) {
          const err = await res.text();
          return {
            content: [{ type: "text" as const, text: `Error ${res.status}: ${err}` }],
            isError: true,
          };
        }

        const branches = (await res.json()) as Array<{ name: string; commit: { sha: string } }>;
        const listing = branches
          .map((b) => `  ${b.name} (${b.commit.sha.slice(0, 7)})`)
          .join("\n");

        return {
          content: [{ type: "text" as const, text: `Branches:\n${listing}` }],
        };
      }
    );

    // ── get_file_tree ──────────────────────────────────────────
    this.server.tool(
      "get_file_tree",
      "Get the full recursive file tree of the RightCraft GitHub repository. Useful for understanding project structure.",
      {
        branch: z.string().optional().describe("Branch name (defaults to 'main')"),
        path_prefix: z.string().optional().describe("Filter results to paths starting with this prefix, e.g. 'src/agents/'"),
      },
      async ({ branch, path_prefix }) => {
        const ref = branch || "main";

        // First get the branch ref to find tree SHA
        const refRes = await ghFetch(
          `/repos/${OWNER}/${REPO}/git/ref/heads/${ref}`,
          pat
        );
        if (!refRes.ok) {
          const err = await refRes.text();
          return {
            content: [{ type: "text" as const, text: `Error ${refRes.status}: ${err}` }],
            isError: true,
          };
        }
        const refData = (await refRes.json()) as { object: { sha: string } };

        // Get commit to find tree SHA
        const commitRes = await ghFetch(
          `/repos/${OWNER}/${REPO}/git/commits/${refData.object.sha}`,
          pat
        );
        if (!commitRes.ok) {
          const err = await commitRes.text();
          return {
            content: [{ type: "text" as const, text: `Error ${commitRes.status}: ${err}` }],
            isError: true,
          };
        }
        const commitData = (await commitRes.json()) as { tree: { sha: string } };

        // Get recursive tree
        const treeRes = await ghFetch(
          `/repos/${OWNER}/${REPO}/git/trees/${commitData.tree.sha}?recursive=1`,
          pat
        );
        if (!treeRes.ok) {
          const err = await treeRes.text();
          return {
            content: [{ type: "text" as const, text: `Error ${treeRes.status}: ${err}` }],
            isError: true,
          };
        }
        const treeData = (await treeRes.json()) as {
          tree: Array<{ path: string; type: string; size?: number }>;
          truncated: boolean;
        };

        let entries = treeData.tree.filter((e) => e.type === "blob");
        if (path_prefix) {
          entries = entries.filter((e) => e.path.startsWith(path_prefix));
        }

        const listing = entries.map((e) => e.path).join("\n");
        const suffix = treeData.truncated ? "\n\n(tree was truncated — repo has many files)" : "";

        return {
          content: [
            {
              type: "text" as const,
              text: `${entries.length} files${path_prefix ? ` under '${path_prefix}'` : ""}:\n${listing}${suffix}`,
            },
          ],
        };
      }
    );

    // ── list_prs ───────────────────────────────────────────────
    this.server.tool(
      "list_prs",
      "List pull requests for the RightCraft GitHub repository.",
      {
        state: z.enum(["open", "closed", "all"]).optional().describe("PR state filter (defaults to 'open')"),
        base: z.string().optional().describe("Filter by base branch name"),
        head: z.string().optional().describe("Filter by head branch name (format: 'user:branch' or just 'branch')"),
      },
      async ({ state, base, head }) => {
        const params = new URLSearchParams({ state: state || "open", per_page: "50" });
        if (base) params.set("base", base);
        if (head) params.set("head", head);

        const res = await ghFetch(
          `/repos/${OWNER}/${REPO}/pulls?${params}`,
          pat
        );

        if (!res.ok) {
          const err = await res.text();
          return {
            content: [{ type: "text" as const, text: `Error ${res.status}: ${err}` }],
            isError: true,
          };
        }

        const prs = (await res.json()) as Array<{
          number: number;
          title: string;
          state: string;
          draft: boolean;
          user: { login: string };
          head: { ref: string };
          base: { ref: string };
          created_at: string;
          html_url: string;
        }>;

        if (prs.length === 0) {
          return { content: [{ type: "text" as const, text: `No ${state || "open"} pull requests found.` }] };
        }

        const lines = prs.map((pr) =>
          `#${pr.number}${pr.draft ? " [DRAFT]" : ""} [${pr.state}] ${pr.title}\n  ${pr.head.ref} → ${pr.base.ref} by @${pr.user.login} (${pr.created_at.slice(0, 10)})\n  ${pr.html_url}`
        );

        return {
          content: [{ type: "text" as const, text: lines.join("\n\n") }],
        };
      }
    );

    // ── get_pr ─────────────────────────────────────────────────
    this.server.tool(
      "get_pr",
      "Get details of a specific pull request by number.",
      {
        pull_number: z.number().int().positive().describe("The pull request number"),
      },
      async ({ pull_number }) => {
        const res = await ghFetch(
          `/repos/${OWNER}/${REPO}/pulls/${pull_number}`,
          pat
        );

        if (!res.ok) {
          const err = await res.text();
          return {
            content: [{ type: "text" as const, text: `Error ${res.status}: ${err}` }],
            isError: true,
          };
        }

        const pr = (await res.json()) as {
          number: number;
          title: string;
          body: string | null;
          state: string;
          draft: boolean;
          mergeable: boolean | null;
          merged: boolean;
          user: { login: string };
          head: { ref: string; sha: string };
          base: { ref: string };
          created_at: string;
          updated_at: string;
          merged_at: string | null;
          html_url: string;
          requested_reviewers: Array<{ login: string }>;
          labels: Array<{ name: string }>;
          commits: number;
          additions: number;
          deletions: number;
          changed_files: number;
        };

        const lines = [
          `PR #${pr.number}${pr.draft ? " [DRAFT]" : ""}: ${pr.title}`,
          `State: ${pr.state}${pr.merged ? " (merged)" : ""}`,
          `Author: @${pr.user.login}`,
          `Branch: ${pr.head.ref} → ${pr.base.ref}`,
          `Commits: ${pr.commits} | +${pr.additions} -${pr.deletions} in ${pr.changed_files} file(s)`,
          `Created: ${pr.created_at.slice(0, 10)} | Updated: ${pr.updated_at.slice(0, 10)}`,
          pr.requested_reviewers.length > 0
            ? `Reviewers: ${pr.requested_reviewers.map((r) => "@" + r.login).join(", ")}`
            : "",
          pr.labels.length > 0 ? `Labels: ${pr.labels.map((l) => l.name).join(", ")}` : "",
          pr.body ? `\nDescription:\n${pr.body}` : "",
          `\nURL: ${pr.html_url}`,
        ].filter(Boolean);

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      }
    );

    // ── create_pr ──────────────────────────────────────────────
    this.server.tool(
      "create_pr",
      "Create a new pull request in the RightCraft GitHub repository.",
      {
        title: z.string().describe("Title of the pull request"),
        body: z.string().optional().describe("Body/description of the pull request (markdown supported)"),
        head: z.string().describe("The branch containing changes (e.g. 'feature/my-feature')"),
        base: z.string().describe("The branch to merge into (e.g. 'main')"),
        draft: z.boolean().optional().describe("Create as draft PR (defaults to false)"),
      },
      async ({ title, body, head, base, draft }) => {
        const res = await ghFetch(
          `/repos/${OWNER}/${REPO}/pulls`,
          pat,
          {
            method: "POST",
            body: JSON.stringify({ title, body: body || "", head, base, draft: draft ?? false }),
          }
        );

        if (!res.ok) {
          const data = (await res.json()) as { message: string; errors?: Array<{ message: string }> };
          const msg = data.errors ? data.errors.map((e) => e.message).join("; ") : data.message;
          return {
            content: [{ type: "text" as const, text: `Error ${res.status}: ${msg}` }],
            isError: true,
          };
        }

        const pr = (await res.json()) as { number: number; html_url: string; title: string };
        return {
          content: [{ type: "text" as const, text: `PR #${pr.number} created: ${pr.title}\n${pr.html_url}` }],
        };
      }
    );

    // ── merge_pr ───────────────────────────────────────────────
    this.server.tool(
      "merge_pr",
      "Merge a pull request. The PR must be open and mergeable.",
      {
        pull_number: z.number().int().positive().describe("The pull request number to merge"),
        commit_title: z.string().optional().describe("Title for the merge commit (optional)"),
        commit_message: z.string().optional().describe("Extra detail for the merge commit message (optional)"),
        merge_method: z.enum(["merge", "squash", "rebase"]).optional().describe("Merge method (defaults to 'merge')"),
      },
      async ({ pull_number, commit_title, commit_message, merge_method }) => {
        const body: Record<string, string> = { merge_method: merge_method || "merge" };
        if (commit_title) body.commit_title = commit_title;
        if (commit_message) body.commit_message = commit_message;

        const res = await ghFetch(
          `/repos/${OWNER}/${REPO}/pulls/${pull_number}/merge`,
          pat,
          { method: "PUT", body: JSON.stringify(body) }
        );

        if (!res.ok) {
          const err = await res.text();
          return {
            content: [{ type: "text" as const, text: `Error ${res.status}: ${err}` }],
            isError: true,
          };
        }

        const data = (await res.json()) as { sha: string; merged: boolean; message: string };
        return {
          content: [{ type: "text" as const, text: `PR #${pull_number} merged successfully.\n${data.message}\nCommit: ${data.sha}` }],
        };
      }
    );

    // ── close_pr ───────────────────────────────────────────────
    this.server.tool(
      "close_pr",
      "Close a pull request without merging it.",
      {
        pull_number: z.number().int().positive().describe("The pull request number to close"),
      },
      async ({ pull_number }) => {
        const res = await ghFetch(
          `/repos/${OWNER}/${REPO}/pulls/${pull_number}`,
          pat,
          { method: "PATCH", body: JSON.stringify({ state: "closed" }) }
        );

        if (!res.ok) {
          const err = await res.text();
          return {
            content: [{ type: "text" as const, text: `Error ${res.status}: ${err}` }],
            isError: true,
          };
        }

        const pr = (await res.json()) as { number: number; title: string; html_url: string };
        return {
          content: [{ type: "text" as const, text: `PR #${pr.number} closed: ${pr.title}\n${pr.html_url}` }],
        };
      }
    );

    // ── add_pr_comment ─────────────────────────────────────────
    this.server.tool(
      "add_pr_comment",
      "Add a comment to a pull request (uses the Issues comments API).",
      {
        pull_number: z.number().int().positive().describe("The pull request number"),
        body: z.string().describe("The comment text (markdown supported)"),
      },
      async ({ pull_number, body }) => {
        const res = await ghFetch(
          `/repos/${OWNER}/${REPO}/issues/${pull_number}/comments`,
          pat,
          { method: "POST", body: JSON.stringify({ body }) }
        );

        if (!res.ok) {
          const err = await res.text();
          return {
            content: [{ type: "text" as const, text: `Error ${res.status}: ${err}` }],
            isError: true,
          };
        }

        const comment = (await res.json()) as { id: number; html_url: string };
        return {
          content: [{ type: "text" as const, text: `Comment added to PR #${pull_number}. Comment ID: ${comment.id}\n${comment.html_url}` }],
        };
      }
    );

    // ── request_pr_review ──────────────────────────────────────
    this.server.tool(
      "request_pr_review",
      "Request a review on a pull request from one or more GitHub users.",
      {
        pull_number: z.number().int().positive().describe("The pull request number"),
        reviewers: z.array(z.string()).min(1).describe("GitHub usernames to request reviews from (without the @ prefix)"),
      },
      async ({ pull_number, reviewers }) => {
        const res = await ghFetch(
          `/repos/${OWNER}/${REPO}/pulls/${pull_number}/requested_reviewers`,
          pat,
          { method: "POST", body: JSON.stringify({ reviewers }) }
        );

        if (!res.ok) {
          const err = await res.text();
          return {
            content: [{ type: "text" as const, text: `Error ${res.status}: ${err}` }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text" as const, text: `Review requested from: ${reviewers.map((r) => "@" + r).join(", ")} on PR #${pull_number}` }],
        };
      }
    );
  }
}

// ── Worker entry point ────────────────────────────────────────────

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          service: "RightCraft GitHub MCP",
          endpoints: ["/mcp", "/sse"],
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // MCP endpoint (streamable HTTP — current standard)
    if (url.pathname === "/mcp") {
      return GitHubMCP.serve("/mcp").fetch(request, env, ctx);
    }

    // SSE endpoint (deprecated but some clients still use it)
    if (url.pathname === "/sse" || url.pathname.startsWith("/sse/")) {
      return GitHubMCP.serve("/sse").fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};
