/** Scoped-auth and authorization policy smoke test. */
process.env.HUB_TOKEN = "";
process.env.HUB_DEPLOYMENT_PROFILE = "team";
// Keep this smoke hermetic even when the developer's personal .env enables
// compatibility switches that a team deployment must reject.
process.env.HUB_ALLOW_LEGACY_ADMIN = "false";
process.env.HUB_ALLOW_QUERY_TOKEN = "false";
process.env.HUB_STRICT_PROJECTS = "true";
process.env.HUB_ACCEPT_LEGACY_VECTORS = "false";
process.env.HUB_PRIMARY_URL = "";
process.env.HUB_AUTH_TOKENS = JSON.stringify([
  {
    id: "reader",
    token: "reader-token-00000000000000000000",
    scopes: ["context:read", "knowledge:read", "project:read"],
    projects: ["ai-hub"],
  },
  {
    id: "writer",
    token: "writer-token-00000000000000000000",
    scopes: ["knowledge:write"],
    projects: ["ai-hub"],
  },
]);
process.env.HUB_RATE_LIMIT_PER_MINUTE = "2";

const { authenticate, authorizeMcp, consumeRateLimit, hasProjectAccess, hasScope, restScope } = await import(
  "../src/server/auth.js"
);
const { assertDeploymentSafety, config } = await import("../src/core/index.js");

let failed = 0;
function check(name: string, condition: boolean): void {
  console.log(`${condition ? "OK  " : "FAIL"} ${name}`);
  if (!condition) failed++;
}

const reader = authenticate("reader-token-00000000000000000000");
const writer = authenticate("writer-token-00000000000000000000");
check("known scoped token authenticates", reader?.id === "reader" && reader.auth_mode === "scoped_token");
let safeProfile = true;
try {
  assertDeploymentSafety();
} catch {
  safeProfile = false;
}
check(
  "team profile enforces fail-closed policy",
  safeProfile && config.strictProjects && !config.allowQueryToken && !config.acceptLegacyVectors && !config.allowLegacyAdmin
);
check("unknown token rejected", authenticate("wrong-token-000000000000000000000") === null);
check("read scope does not imply write", Boolean(reader && hasScope(reader, "knowledge:read") && !hasScope(reader, "knowledge:write")));
check("write scope implies same-domain read", Boolean(writer && hasScope(writer, "knowledge:read")));
check("project allowlist", Boolean(reader && hasProjectAccess(reader, "ai-hub") && !hasProjectAccess(reader, "other")));

const mcp = (name: string, args: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name, arguments: args },
});
check(
  "MCP allowed scope+project",
  Boolean(reader && authorizeMcp(reader, mcp("context_get", { query: "status", project: "ai-hub" })).ok)
);
check(
  "MCP cross-project denied",
  Boolean(reader && !authorizeMcp(reader, mcp("context_get", { query: "status", project: "other" })).ok)
);
check(
  "MCP restricted principal must provide project",
  Boolean(reader && !authorizeMcp(reader, mcp("context_get", { query: "status" })).ok)
);
check(
  "MCP missing write scope denied",
  Boolean(reader && !authorizeMcp(reader, mcp("memory_save", { title: "x", body: "y", project: "ai-hub" })).ok)
);
check("REST policy recall feedback write", restScope("POST", "/recall/feedback") === "knowledge:write");
check("REST policy reindex admin", restScope("POST", "/rag/reindex") === "admin:write");
check("REST profile read uses knowledge scope", restScope("GET", "/profile") === "knowledge:read");
check("REST profile update uses knowledge write", restScope("PUT", "/profile") === "knowledge:write");
check(
  "REST pseudo-project detach is admin-only",
  restScope("POST", "/projects/professional-profile/detach-references") === "admin:write"
);
check("REST vector projection status is admin read", restScope("GET", "/vector-projection") === "admin:read");
check("REST vector projection rebuild is admin write", restScope("POST", "/vector-projection/rebuild") === "admin:write");
check(
  "MCP vector projection administration denied to context reader",
  Boolean(reader && !authorizeMcp(reader, mcp("vector_projection_rebuild", {})).ok)
);
check("MCP profile read allowed to knowledge reader", Boolean(reader && authorizeMcp(reader, mcp("profile_get", {})).ok));
check("MCP profile update denied to read-only principal", Boolean(reader && !authorizeMcp(reader, mcp("profile_update", { markdown: "x" })).ok));
check(
  "MCP pseudo-project detach denied to non-admin",
  Boolean(reader && !authorizeMcp(reader, mcp("project_detach_references", { name: "professional-profile" })).ok)
);

const first = consumeRateLimit("reader", 1_000);
const second = consumeRateLimit("reader", 1_001);
const third = consumeRateLimit("reader", 1_002);
check("per-principal rate limit", first.allowed && second.allowed && !third.allowed);

console.log(failed === 0 ? "\nSecurity smoke passed." : `\n${failed} security checks failed.`);
process.exit(failed === 0 ? 0 : 1);
