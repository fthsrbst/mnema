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
const orgA = "20000000-0000-4000-8000-000000000001";
const orgB = "20000000-0000-4000-8000-000000000002";
const projectA = "30000000-0000-4000-8000-000000000001";
const projectB = "30000000-0000-4000-8000-000000000002";

await db.exec(`
  insert into auth.users(id) values ('${userA}'), ('${userB}');
  insert into public.organizations(id, slug, name, created_by) values
    ('${orgA}', 'org-a', 'Organization A', '${userA}'),
    ('${orgB}', 'org-b', 'Organization B', '${userB}');
  insert into public.organization_members(organization_id, user_id, role) values
    ('${orgA}', '${userA}', 'owner'),
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

let crossTenantInsertDenied = false;
try {
  await db.query("insert into public.memories(organization_id, project_id, title, body) values ($1, $2, 'attack', 'cross tenant')", [orgB, projectB]);
} catch {
  crossTenantInsertDenied = true;
}
check("tenant A cannot insert into tenant B", crossTenantInsertDenied);

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

await asUser(userB);
const visibleB = await db.query<{ title: string }>("select title from public.memories order by title");
check("tenant B reads only tenant B rows", visibleB.rows.length === 1 && visibleB.rows[0]?.title === "B only");

await db.close();
console.log(failed === 0 ? "\nPostgres tenant isolation smoke passed." : `\n${failed} tenant isolation checks failed.`);
process.exit(failed === 0 ? 0 : 1);
