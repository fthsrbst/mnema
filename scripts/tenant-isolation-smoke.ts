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
  create role service_role nologin;
  create schema auth;
  create table auth.users(id uuid primary key, email text);
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
  insert into auth.users(id, email) values
    ('${userA}', 'owner@example.com'),
    ('${userB}', 'invitee@example.com'),
    ('${userC}', 'admin@example.com');
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

async function asUser(userId: string, aal: "aal1" | "aal2" = "aal2"): Promise<void> {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
  const email = userId === userA ? "owner@example.com" : userId === userB ? "invitee@example.com" : "admin@example.com";
  await db.query("select set_config('request.jwt.claim.email', $1, false)", [email]);
  await db.query("select set_config('request.jwt.claim.aal', $1, false)", [aal]);
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

let directLifecycleMutationDenied = false;
try {
  await db.query("update public.organizations set deletion_scheduled_for = now() where id = $1", [orgA]);
} catch {
  directLifecycleMutationDenied = true;
}
check("authenticated clients cannot bypass the MFA deletion RPC", directLifecycleMutationDenied);

let directChunkMutationDenied = false;
try {
  await db.query("update public.document_chunks set content = repeat('x', 1000000) where organization_id = $1", [orgA]);
} catch {
  directChunkMutationDenied = true;
}
check("authenticated clients cannot bypass document storage quotas through chunk writes", directChunkMutationDenied);

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

await db.exec("reset role");
await db.exec("set role service_role");
const firstWebhookClaim = await db.query<{ claimed: boolean }>(
  "select app.claim_billing_webhook('paddle', 'evt_retry', 'hash-a') as claimed"
);
const concurrentWebhookClaim = await db.query<{ claimed: boolean }>(
  "select app.claim_billing_webhook('paddle', 'evt_retry', 'hash-a') as claimed"
);
await db.exec("reset role");
await db.query("update public.billing_webhook_events set status = 'failed' where provider = 'paddle' and event_id = 'evt_retry'");
await db.exec("set role service_role");
const retryWebhookClaim = await db.query<{ claimed: boolean }>(
  "select app.claim_billing_webhook('paddle', 'evt_retry', 'hash-a') as claimed"
);
check(
  "webhook claim rejects concurrent duplicates but permits failed-event retry",
  firstWebhookClaim.rows[0]?.claimed === true && concurrentWebhookClaim.rows[0]?.claimed === false && retryWebhookClaim.rows[0]?.claimed === true
);
await db.exec("reset role");
await db.query("update public.organizations set deletion_scheduled_for = now() - interval '1 day' where id = $1", [created.rows[0]!.id]);
await db.exec("set role service_role");
const purgeOutcome = await db.query<{ examined: number; purged: number; waiting_for_billing: number }>(
  "select * from app.purge_due_organizations(now(), 100)"
);
await db.exec("reset role");
const purgedOrganization = await db.query<{ count: number }>(
  "select count(*)::integer as count from public.organizations where id = $1",
  [created.rows[0]!.id]
);
check(
  "lifecycle purge atomically deletes a due free tenant and its owner membership",
  purgeOutcome.rows[0]?.examined === 1 && purgeOutcome.rows[0]?.purged === 1 &&
    purgeOutcome.rows[0]?.waiting_for_billing === 0 && purgedOrganization.rows[0]?.count === 0
);
await db.exec("reset role");
await db.exec("set role authenticated");
await asUser(userA);

const searchA = await db.query<{ title: string }>("select title from app.search_knowledge($1, 'tenant', 20)", [orgA]);
check("full-text knowledge search returns only the caller tenant", searchA.rows.length === 1 && searchA.rows[0]?.title === "A only");

await db.exec("reset role");
await db.query(
  `insert into public.subscriptions(
     organization_id, provider, provider_subscription_id, plan, status,
     current_period_end, cancel_at_period_end, last_event_id, last_event_at
   ) values ($1, 'paddle', 'sub_test_org_a', 'pro', 'active', now() + interval '30 days', false, 'evt_test_org_a', now())`,
  [orgA]
);
await db.exec("set role service_role");
const staleSubscription = await db.query<{ applied: boolean }>(
  `select app.apply_subscription_snapshot(
     $1, 'paddle', 'sub_test_org_a', 'starter', 'canceled', null, false,
     'evt_stale', now() - interval '1 day'
   ) as applied`,
  [orgA]
);
const newerSubscription = await db.query<{ applied: boolean }>(
  `select app.apply_subscription_snapshot(
     $1, 'paddle', 'sub_test_org_a', 'pro', 'active', now() + interval '30 days', false,
     'evt_newer', now() + interval '1 second'
   ) as applied`,
  [orgA]
);
check(
  "database subscription reducer rejects stale concurrent state and applies newer state",
  staleSubscription.rows[0]?.applied === false && newerSubscription.rows[0]?.applied === true
);
await db.exec("reset role");
await db.exec("set role authenticated");
await asUser(userA);

const invitation = await db.query<{ id: string }>(
  "select app.create_organization_invitation($1, 'invitee@example.com', 'viewer') as id",
  [orgA]
);
check("MFA owner creates a plan-limited invitation", Boolean(invitation.rows[0]?.id));

let memberQuotaEnforced = false;
try {
  await db.query("select app.create_organization_invitation($1, 'fourth@example.com', 'viewer')", [orgA]);
} catch (error) {
  memberQuotaEnforced = String(error).includes("member quota exceeded");
}
check("pending invitations reserve member quota atomically", memberQuotaEnforced);

await db.exec("reset role");
await db.query("update public.organization_invitations set expires_at = now() - interval '1 day' where id = $1", [invitation.rows[0]!.id]);
await db.exec("set role authenticated");
await asUser(userA);
const replacementInvitation = await db.query<{ id: string }>(
  "select app.create_organization_invitation($1, 'fourth@example.com', 'viewer') as id",
  [orgA]
);
let expiredInvitationReactivationDenied = false;
try {
  await db.query("select app.create_organization_invitation($1, 'invitee@example.com', 'viewer')", [orgA]);
} catch (error) {
  expiredInvitationReactivationDenied = String(error).includes("member quota exceeded");
}
check(
  "reactivating an expired invitation cannot exceed the current member quota",
  Boolean(replacementInvitation.rows[0]?.id) && expiredInvitationReactivationDenied
);
await db.exec("reset role");
await db.query("update public.organization_invitations set status = 'revoked', revoked_at = now() where id = $1", [replacementInvitation.rows[0]!.id]);
await db.exec("set role authenticated");
await asUser(userA);
await db.query("select app.create_organization_invitation($1, 'invitee@example.com', 'viewer')", [orgA]);

await asUser(userB);
const ownInvitations = await db.query<{ invitation_id: string }>("select invitation_id from app.list_my_organization_invitations()");
check("invitee sees only invitations for its verified email", ownInvitations.rows[0]?.invitation_id === invitation.rows[0]?.id);
await db.query("select app.accept_organization_invitation($1)", [invitation.rows[0]!.id]);
const acceptedRole = await db.query<{ role: string }>(
  "select role from public.organization_members where organization_id = $1 and user_id = $2",
  [orgA, userB]
);
check("verified-email acceptance atomically creates membership", acceptedRole.rows[0]?.role === "viewer");

await asUser(userA);
const listedMembers = await db.query<{ member_user_id: string }>(
  "select member_user_id from app.list_organization_members($1)",
  [orgA]
);
const roleChanged = await db.query<{ changed: boolean }>(
  "select app.change_organization_member_role($1, $2, 'member') as changed",
  [orgA, userB]
);
const memberRemoved = await db.query<{ removed: boolean }>(
  "select app.remove_organization_member($1, $2) as removed",
  [orgA, userB]
);
check(
  "MFA owner can list, re-role, and remove members through guarded RPCs",
  listedMembers.rows.some((member) => member.member_user_id === userB) &&
    roleChanged.rows[0]?.changed === true && memberRemoved.rows[0]?.removed === true
);

await asUser(userA, "aal1");
let invitationMfaRequired = false;
try {
  await db.query("select app.create_organization_invitation($1, 'mfa@example.com', 'viewer')", [orgA]);
} catch (error) {
  invitationMfaRequired = String(error).includes("MFA required");
}
check("membership invitations require AAL2", invitationMfaRequired);

await asUser(userA);
let activeSubscriptionBlocksDeletion = false;
try {
  await db.query("select app.request_organization_deletion($1, 'org-a')", [orgA]);
} catch (error) {
  activeSubscriptionBlocksDeletion = String(error).includes("subscription must be canceled first");
}
check("active subscription blocks organization deletion scheduling", activeSubscriptionBlocksDeletion);

await db.exec("reset role");
await db.query("update public.subscriptions set cancel_at_period_end = true where organization_id = $1", [orgA]);
await db.exec("set role authenticated");
await asUser(userA);
const deletion = await db.query<{ scheduled_for: string }>(
  "select app.request_organization_deletion($1, 'org-a') as scheduled_for",
  [orgA]
);
check("canceled subscription schedules delayed organization deletion", Date.parse(deletion.rows[0]!.scheduled_for) > Date.now());
let scheduledOrganizationWriteDenied = false;
try {
  const mutation = await db.query<{ title: string }>(
    "update public.memories set title = 'should-not-write' where organization_id = $1 returning title",
    [orgA]
  );
  scheduledOrganizationWriteDenied = mutation.rows.length === 0;
} catch {
  scheduledOrganizationWriteDenied = true;
}
check("scheduled organization deletion blocks direct tenant writes at RLS", scheduledOrganizationWriteDenied);
const deletionCanceled = await db.query<{ canceled: boolean }>("select app.cancel_organization_deletion($1) as canceled", [orgA]);
check("owner with MFA can cancel scheduled deletion", deletionCanceled.rows[0]?.canceled === true);

let ownedOrganizationBlocksAccountDeletion = false;
try {
  await db.query("select app.assert_account_deletable('owner@example.com')");
} catch (error) {
  ownedOrganizationBlocksAccountDeletion = String(error).includes("owned organizations remain");
}
check("account deletion is blocked until owned tenants are transferred or deleted", ownedOrganizationBlocksAccountDeletion);

await asUser(userC);
const deletableAdmin = await db.query<{ allowed: boolean }>(
  "select app.assert_account_deletable('admin@example.com') as allowed"
);
check("non-owner account passes the server-side deletion precondition", deletableAdmin.rows[0]?.allowed === true);

await asUser(userC, "aal1");
let accountDeletionMfaRequired = false;
try {
  await db.query("select app.assert_account_deletable('admin@example.com')");
} catch (error) {
  accountDeletionMfaRequired = String(error).includes("MFA required");
}
check("account deletion precondition requires AAL2", accountDeletionMfaRequired);

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
  await db.query("select app.change_organization_member_role($1, $2, 'admin')", [orgA, userA]);
} catch (error) {
  lastOwnerGuarded = String(error).includes("retain an owner");
}
check("database trigger prevents removing the last owner", lastOwnerGuarded);

const promotedAdmin = await db.query<{ changed: boolean }>(
  "select app.change_organization_member_role($1, $2, 'owner') as changed",
  [orgA, userC]
);
const demotedOwner = await db.query<{ changed: boolean }>(
  "select app.change_organization_member_role($1, $2, 'admin') as changed",
  [orgA, userA]
);
const transferredOwnerCanDelete = await db.query<{ allowed: boolean }>(
  "select app.assert_account_deletable('owner@example.com') as allowed"
);
await asUser(userC);
await db.query("select app.change_organization_member_role($1, $2, 'owner')", [orgA, userA]);
await db.query("select app.change_organization_member_role($1, $2, 'admin')", [orgA, userC]);
check(
  "ownership transfer unblocks the former owner's account deletion precondition",
  promotedAdmin.rows[0]?.changed === true && demotedOwner.rows[0]?.changed === true &&
    transferredOwnerCanDelete.rows[0]?.allowed === true
);

await asUser(userB);
const visibleB = await db.query<{ title: string }>("select title from public.memories order by title");
check("tenant B reads only tenant B rows", visibleB.rows.length === 1 && visibleB.rows[0]?.title === "B only");

await db.close();
console.log(failed === 0 ? "\nPostgres tenant isolation smoke passed." : `\n${failed} tenant isolation checks failed.`);
process.exit(failed === 0 ? 0 : 1);
