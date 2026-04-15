interface Env {
  MCP_OBJECT: DurableObjectNamespace<import("./src/index").GitHubMCP>;
  GITHUB_PAT: string;
  OAUTH_KV: KVNamespace;
  AUTH_PIN: string;
}
