import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";

let failed = 0;
function check(name: string, condition: boolean): void {
  console.log(`${condition ? "OK  " : "FAIL"} ${name}`);
  if (!condition) failed++;
}

const db = await PGlite.create("memory://");
await db.exec(`
  create role authenticated nologin;
  create schema auth;
  create table auth.users(id uuid primary key);
`);
const migration = fs.readFileSync(new URL("../cloud/migrations/0001_tenancy.sql", import.meta.url), "utf8");
await db.exec(migration);

const userA = "10000000-0000-4000-8000-000000000001";
const userB = "10000000-0000-4000-8000-000000000002";
const userC = "10000000-0000-4000-8000-000000000003";
const orgA = "20000000-0000-4000-8000-000000000001";
const orgB = "20000000-0000-4000-8000-000000000002";
const projectA = "30000000-0000-4000-8000-000000000001";
const projectB = "30000000-0000-4000-8000-000000000002";

await db.exec(`
  insert into auth.users(id) values ('${userA}'), ('${userB}'), ('${userC}');
  insert into public.organizations(id, slug, name, created_by) values
    ('${orgA}', 'org-a', 'Organization A', '${userA}'),
    ('${orgB}', 'org-b', 'Organization B', '${userB}');
  insert into public.organization_members(organization_id, user_id, role) values
    ('${orgA}', '${userA}', 'owner'),
    ('${orgA}', '${userC}', 'admin'),
    ('${orgB}', '${userB}', 'owner');
  insert into public.projects(organization_id, id, slug, map) values
    ('${orgA}', '${projectA}', 'alpha', '{"secret":"alpha"}'),
    ('${orgB}', '${projectB}', 'beta', '{"secret":"beta"}');
  insert into public.memories(organization_id, project_id, title, body) values
    ('${orgA}', '${projectA}', 'A only', 'tenant A secret'),
    ('${orgB}', '${projectB}', 'B only', 'tenant B secret');
  set role authenticated;
`);

async function asUser(userId: string): Promise<void> {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
}

await asUser(userA);
const visibleA = await db.query<{ title: string }>("select title from public.memories order by title");
check("tenant A reads only tenant A rows", visibleA.rows.length === 1 && visibleA.rows[0]?.title === "A only");

const created = await db.query<{ id: string }>("select app.create_organization('org-a-second', 'Organization A Second') as id");
const createdMembership = await db.query<{ role: string }>(
  "select role from public.organization_members where organization_id = $1",
  [created.rows[0]!.id]
);
check("authenticated account can atomically create an owned organization", createdMembership.rows[0]?.role === "owner");

const secondProject = await db.query<{ id: string }>(
  "select app.create_project($1, 'alpha-two', '{\"decisions\":[\"RLS\"]}'::jsonb) as id",
  [orgA]
);
check("project quota RPC creates the remaining free-plan project", Boolean(secondProject.rows[0]?.id));

let projectQuotaEnforced = false;
try {
  await db.query("select app.create_project($1, 'alpha-three', '{}'::jsonb)", [orgA]);
} catch (error) {
  projectQuotaEnforced = String(error).includes("project quota exceeded");
}
check("project quota is enforced inside the serialized database transaction", projectQuotaEnforced);

let directProjectInsertDenied = false;
try {
  await db.query("insert into public.projects(organization_id, slug) values ($1, 'bypass')", [orgA]);
} catch {
  directProjectInsertDenied = true;
}
check("authenticated clients cannot bypass project quota with direct inserts", directProjectInsertDenied);

let crossTenantInsertDenied = false;
try {
  await db.query("insert into public.memories(organization_id, project_id, title, body) values ($1, $2, 'attack', 'cross tenant')", [orgB, projectB]);
} catch {
  crossTenantInsertDenied = true;
}
check("tenant A cannot insert into tenant B", crossTenantInsertDenied);

let crossTenantRpcDenied = false;
try {
  await db.query("select app.add_memory($1, $2, 'fact', 'attack', 'cross tenant', '{}'::text[], 1)", [orgB, projectB]);
} catch {
  crossTenantRpcDenied = true;
}
check("tenant A cannot use privileged RPCs against tenant B", crossTenantRpcDenied);

let tenantMoveDenied = false;
try {
  await db.query("update public.memories set organization_id = $1 where title = 'A only'", [orgB]);
} catch {
  tenantMoveDenied = true;
}
check("WITH CHECK prevents moving a row across tenants", tenantMoveDenied);

let billingReadDenied = false;
try {
  await db.query("select * from public.subscriptions");
} catch {
  billingReadDenied = true;
}
check("client role cannot read server-owned billing tables", billingReadDenied);

const searchA = await db.query<{ title: string }>("select title from app.search_knowledge($1, 'tenant', 20)", [orgA]);
check("full-text knowledge search returns only the caller tenant", searchA.rows.length === 1 && searchA.rows[0]?.title === "A only");

await asUser(userC);
let adminOwnerEscalationDenied = false;
try {
  await db.query("update public.organization_members set role = 'owner' where organization_id = $1 and user_id = $2", [orgA, userC]);
} catch {
  adminOwnerEscalationDenied = true;
}
check("an admin cannot promote itself to owner", adminOwnerEscalationDenied);

let adminOwnerMutationDenied = false;
try {
  const mutation = await db.query<{ role: string }>(
    "update public.organization_members set role = 'admin' where organization_id = $1 and user_id = $2 returning role",
    [orgA, userA]
  );
  adminOwnerMutationDenied = mutation.rows.length === 0;
} catch {
  adminOwnerMutationDenied = true;
}
check("an admin cannot mutate an owner's membership", adminOwnerMutationDenied);

await asUser(userA);
let lastOwnerGuarded = false;
try {
  await db.query("update public.organization_members set role = 'admin' where organization_id = $1 and user_id = $2", [orgA, userA]);
} catch (error) {
  lastOwnerGuarded = String(error).includes("retain an owner");
}
check("database trigger prevents removing the last owner", lastOwnerGuarded);

await asUser(userB);
const visibleB = await db.query<{ title: string }>("select title from public.memories order by title");
check("tenant B reads only tenant B rows", visibleB.rows.length === 1 && visibleB.rows[0]?.title === "B only");

await db.close();
console.log(failed === 0 ? "\nPostgres tenant isolation smoke passed." : `\n${failed} tenant isolation checks failed.`);
process.exit(failed === 0 ? 0 : 1);
