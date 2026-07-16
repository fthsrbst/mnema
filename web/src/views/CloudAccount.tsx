import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { cloudApi, cloudConfigured, downloadCloudExport, supabase } from "../cloud";
import { Button } from "../components/ui/Button";
import { Select, TextArea, TextField } from "../components/ui/Field";
import { Panel } from "../components/ui/Panel";
import { Grid, HStack, VStack } from "../components/ui/Stack";
import { Tag } from "../components/ui/Tag";
import { Heading, Text } from "../components/ui/Typography";
import { useI18n } from "../i18n";

interface CloudOrganization {
  organization_id: string;
  role: "owner" | "admin" | "member" | "viewer";
  organizations?: { id: string; name: string; slug: string; deletion_scheduled_for?: string | null } | null;
}

interface CloudSessionPayload {
  user: { id: string; email: string | null; aal: "aal1" | "aal2" };
  organizations: CloudOrganization[];
}

interface CloudProject {
  id: string;
  slug: string;
  map: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface CloudProjectDetail {
  project: CloudProject;
  memories: Array<Record<string, unknown>>;
  documents: Array<Record<string, unknown>>;
  sessions: Array<Record<string, unknown>>;
  relations: Array<Record<string, unknown>>;
}

interface CloudSearchResult {
  resource_type: string;
  resource_id: string;
  project_id: string;
  title: string;
  snippet: string;
  rank: number;
}

interface CloudEntitlement {
  plan: "free" | "starter" | "pro" | "team";
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  billingEnabled: boolean;
  entitlements: { projects: number; members: number; storageMb: number };
}

interface PersonalInvitation {
  invitation_id: string;
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  invitation_role: string;
  expires_at: string;
}

interface OrganizationInvitation {
  invitation_id: string;
  email: string;
  invitation_role: string;
  invitation_status: string;
  expires_at: string;
}

interface OrganizationMember {
  member_user_id: string;
  member_email: string;
  member_role: "owner" | "admin" | "member" | "viewer";
  joined_at: string;
}

const plans = [
  { id: "starter", price: "$9", projects: "10", storage: "1 GB" },
  { id: "pro", price: "$19", projects: "50", storage: "5 GB" },
  { id: "team", price: "$49", projects: "250", storage: "20 GB" },
] as const;

type PaidPlan = (typeof plans)[number]["id"];
type BillingInterval = "monthly" | "annual";

function queryPlan(): PaidPlan | null {
  const value = new URLSearchParams(window.location.search).get("plan");
  return plans.some((plan) => plan.id === value) ? value as PaidPlan : null;
}

function queryInterval(): BillingInterval {
  return new URLSearchParams(window.location.search).get("interval") === "monthly" ? "monthly" : "annual";
}

function friendlyCloudError(error: unknown, tr: boolean): string {
  const code = error instanceof Error ? error.message : "cloud_operation_failed";
  if (code.toLowerCase().includes("email rate limit")) {
    return tr
      ? "Doğrulama e-postası kotası şu anda dolu. Hazır staging test hesabıyla giriş yap veya SMTP kotası yenilendikten sonra tekrar dene."
      : "The verification-email quota is currently exhausted. Use the prepared staging test account or retry after the SMTP quota resets.";
  }
  if (/^email address .* is invalid$/i.test(code)) {
    return tr ? "Geçerli, teslim edilebilir bir e-posta adresi kullan." : "Use a valid, deliverable email address.";
  }
  const messages: Record<string, [string, string]> = {
    billing_not_configured: ["Paddle sandbox henüz açık değil. Ücretsiz Cloud önizlemesini kullanabilirsin; ücretli ödeme testi açıldığında bu buton doğrudan checkout'a gidecek.", "Paddle sandbox is not open yet. You can use the free Cloud preview; this button will open checkout when paid testing is enabled."],
    mfa_required: ["Abonelik ve hassas işlemler için önce TOTP ile iki aşamalı doğrulamayı tamamla.", "Complete TOTP two-factor authentication before billing or sensitive actions."],
    email_not_verified: ["Devam etmek için e-posta adresini doğrula.", "Verify your email address to continue."],
    organization_create_failed: ["Çalışma alanı oluşturulamadı. Slug başka bir hesapta kullanılıyor olabilir.", "The workspace could not be created. Its slug may already be in use."],
    subscription_already_exists: ["Bu çalışma alanının zaten etkin bir aboneliği var; abonelik portalını kullan.", "This workspace already has an active subscription; use the subscription portal."],
    cloud_operation_failed: ["Cloud staging isteği tamamlanamadı. Yerel önizleme sunucusunun ve Supabase bağlantısının açık olduğunu kontrol et.", "The Cloud staging request could not complete. Check that the local preview server and its Supabase connection are available."],
  };
  return messages[code]?.[tr ? 0 : 1] ?? code;
}

export function CloudAccount() {
  const { lang } = useI18n();
  const tr = lang === "tr";
  const cloudClient = supabase;
  const [session, setSession] = useState<Session | null>(null);
  const [account, setAccount] = useState<CloudSessionPayload | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [organizationSlug, setOrganizationSlug] = useState("");
  const [activeOrganization, setActiveOrganization] = useState("");
  const [projects, setProjects] = useState<CloudProject[]>([]);
  const [projectSlug, setProjectSlug] = useState("");
  const [projectSummary, setProjectSummary] = useState("");
  const [selectedProject, setSelectedProject] = useState<CloudProjectDetail | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<CloudSearchResult[]>([]);
  const [entitlement, setEntitlement] = useState<CloudEntitlement | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<PaidPlan | null>(queryPlan);
  const [billingInterval, setBillingInterval] = useState<BillingInterval>(queryInterval);
  const [personalInvitations, setPersonalInvitations] = useState<PersonalInvitation[]>([]);
  const [organizationInvitations, setOrganizationInvitations] = useState<OrganizationInvitation[]>([]);
  const [organizationMembers, setOrganizationMembers] = useState<OrganizationMember[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("viewer");
  const [deletionConfirmation, setDeletionConfirmation] = useState("");
  const [accountDeletionConfirmation, setAccountDeletionConfirmation] = useState("");
  const [mfaFactorId, setMfaFactorId] = useState("");
  const [mfaQr, setMfaQr] = useState("");
  const [mfaSecret, setMfaSecret] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const refreshAccount = async () => {
    const payload = await cloudApi<CloudSessionPayload>("/session");
    setAccount(payload);
    setActiveOrganization((current) =>
      payload.organizations.some((membership) => membership.organization_id === current)
        ? current
        : payload.organizations[0]?.organization_id || ""
    );
  };

  const refreshProjects = async (organizationId: string) => {
    if (!organizationId) {
      setProjects([]);
      return;
    }
    const payload = await cloudApi<{ projects: CloudProject[] }>("/knowledge/projects", {}, organizationId);
    setProjects(payload.projects);
  };

  const refreshPersonalInvitations = async () => {
    const payload = await cloudApi<{ invitations: PersonalInvitation[] }>("/invitations");
    setPersonalInvitations(payload.invitations);
  };

  const refreshOrganizationInvitations = async (organizationId: string) => {
    const payload = await cloudApi<{ invitations: OrganizationInvitation[] }>(
      "/organizations/invitations", {}, organizationId
    );
    setOrganizationInvitations(payload.invitations);
  };

  const refreshOrganizationMembers = async (organizationId: string) => {
    const payload = await cloudApi<{ members: OrganizationMember[] }>("/organizations/members", {}, organizationId);
    setOrganizationMembers(payload.members);
  };

  const openProject = async (project: CloudProject) => {
    const detail = await cloudApi<CloudProjectDetail>(`/knowledge/projects/${project.id}`, {}, activeOrganization);
    setSelectedProject(detail);
  };

  useEffect(() => {
    if (!cloudClient) return;
    void cloudClient.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = cloudClient.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, [cloudClient]);

  useEffect(() => {
    if (!session) {
      setAccount(null);
      setPersonalInvitations([]);
      return;
    }
    void Promise.all([refreshAccount(), refreshPersonalInvitations()]).catch((error) => setMessage((error as Error).message));
  }, [session]);

  useEffect(() => {
    setSelectedProject(null);
    setSearchResults([]);
    if (!session || !activeOrganization) {
      setProjects([]);
      setEntitlement(null);
      setOrganizationInvitations([]);
      setOrganizationMembers([]);
      return;
    }
    const selectedMembership = account?.organizations.find((item) => item.organization_id === activeOrganization);
    const mayManageTeam = account?.user.aal === "aal2" &&
      !selectedMembership?.organizations?.deletion_scheduled_for &&
      ["owner", "admin"].includes(selectedMembership?.role ?? "viewer");
    void Promise.all([
      refreshProjects(activeOrganization),
      cloudApi<CloudEntitlement>("/billing/subscription", {}, activeOrganization).then(setEntitlement),
      mayManageTeam ? refreshOrganizationInvitations(activeOrganization) : Promise.resolve(setOrganizationInvitations([])),
      mayManageTeam ? refreshOrganizationMembers(activeOrganization) : Promise.resolve(setOrganizationMembers([])),
    ]).catch((error) => setMessage((error as Error).message));
  }, [session, activeOrganization, account]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try {
      await operation();
    } catch (error) {
      setMessage(friendlyCloudError(error, tr));
    } finally {
      setBusy(false);
    }
  };

  if (!cloudConfigured || !cloudClient) {
    return (
      <Panel>
        <VStack gap={2}>
          <Heading level={3}>Mnema Cloud</Heading>
          <Text type="supporting" color="secondary">
            {tr
              ? "Bu self-hosted derlemede Cloud yapılandırılmamış. Community sürümü yerel token ve SQLite ile çalışmaya devam eder."
              : "Cloud is not configured in this self-hosted build. Community continues with local tokens and SQLite."}
          </Text>
        </VStack>
      </Panel>
    );
  }

  if (!session) {
    return (
      <VStack gap={4} style={{ maxWidth: 520 }}>
        <VStack gap={1}>
          <Heading level={2}>Mnema Cloud</Heading>
          <Text type="supporting" color="secondary">
            {tr ? "Hesabına gir veya e-posta doğrulamalı yeni bir hesap aç." : "Sign in or create an email-verified account."}
          </Text>
        </VStack>
        {selectedPlan && (
          <Panel raised>
            <Text type="supporting" color="secondary">
              {tr
                ? `${selectedPlan.toUpperCase()} planını seçtin. Hesabını doğrulayıp bir çalışma alanı oluşturduktan sonra aynı seçimle devam edeceksin.`
                : `${selectedPlan.toUpperCase()} is selected. After verifying your account and creating a workspace, you will continue with the same choice.`}
            </Text>
          </Panel>
        )}
        <Panel raised>
          <VStack gap={3}>
            <TextField label="E-mail" type="email" value={email} onChange={setEmail} />
            <TextField label={tr ? "Parola (en az 12 karakter)" : "Password (12+ characters)"} type="password" value={password} onChange={setPassword} />
            <HStack gap={2} wrap="wrap">
              <Button
                label={tr ? "Giriş yap" : "Sign in"}
                variant="primary"
                disabled={busy || !email || password.length < 12}
                onClick={() => run(async () => {
                  const { error } = await cloudClient.auth.signInWithPassword({ email, password });
                  if (error) throw error;
                })}
              />
              <Button
                label={tr ? "Hesap oluştur" : "Create account"}
                disabled={busy || !email || password.length < 12}
                onClick={() => run(async () => {
                  const { error } = await cloudClient.auth.signUp({ email, password });
                  if (error) throw error;
                  setMessage(tr ? "Doğrulama e-postası gönderildi." : "Verification email sent.");
                })}
              />
            </HStack>
          </VStack>
        </Panel>
        {message && <Text type="supporting" color="secondary">{message}</Text>}
      </VStack>
    );
  }

  const active = account?.organizations.find((item) => item.organization_id === activeOrganization);
  return (
    <VStack gap={4}>
      <HStack hAlign="between" vAlign="center" wrap="wrap">
        <VStack gap={1}>
          <Heading level={2}>Mnema Cloud</Heading>
          <Text type="supporting" color="secondary">{account?.user.email ?? session.user.email}</Text>
        </VStack>
        <HStack gap={2}>
          <Tag>{account?.user.aal?.toUpperCase() ?? "AAL1"}</Tag>
          <Button label={tr ? "Çıkış" : "Sign out"} onClick={() => run(async () => {
            const { error } = await cloudClient.auth.signOut();
            if (error) {
              const localResult = await cloudClient.auth.signOut({ scope: "local" });
              if (localResult.error) throw localResult.error;
            }
          })} />
        </HStack>
      </HStack>

      {personalInvitations.length > 0 && (
        <Panel raised>
          <VStack gap={2}>
            <Heading level={3}>{tr ? "Bekleyen davetler" : "Pending invitations"}</Heading>
            {personalInvitations.map((invitation) => (
              <HStack key={invitation.invitation_id} hAlign="between" vAlign="center" wrap="wrap">
                <VStack gap={0}>
                  <strong>{invitation.organization_name}</strong>
                  <Text type="supporting" color="secondary">{invitation.invitation_role} · {new Date(invitation.expires_at).toLocaleDateString()}</Text>
                </VStack>
                <Button
                  label={tr ? "Daveti kabul et" : "Accept invitation"}
                  variant="primary"
                  disabled={busy}
                  onClick={() => run(async () => {
                    await cloudApi(`/invitations/${invitation.invitation_id}/accept`, { method: "POST", body: "{}" });
                    await Promise.all([refreshAccount(), refreshPersonalInvitations()]);
                  })}
                />
              </HStack>
            ))}
          </VStack>
        </Panel>
      )}

      <Grid minWidth={280} gap={3}>
        <Panel>
          <VStack gap={3}>
            <Heading level={3}>{tr ? "Çalışma alanları" : "Workspaces"}</Heading>
            {account?.organizations.map((membership) => (
              <button
                type="button"
                className="btn"
                key={membership.organization_id}
                data-active={activeOrganization === membership.organization_id}
                onClick={() => setActiveOrganization(membership.organization_id)}
                style={{ justifyContent: "space-between" }}
              >
                <span>{membership.organizations?.name ?? membership.organization_id}</span>
                <span>{membership.role}</span>
              </button>
            ))}
            <TextField label={tr ? "Yeni alan adı" : "New workspace name"} value={organizationName} onChange={setOrganizationName} />
            <TextField label="Slug" value={organizationSlug} onChange={(value) => setOrganizationSlug(value.toLowerCase())} />
            <Button
              label={tr ? "Çalışma alanı oluştur" : "Create workspace"}
              disabled={busy || !organizationName.trim() || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(organizationSlug)}
              onClick={() => run(async () => {
                await cloudApi("/organizations", { method: "POST", body: JSON.stringify({ name: organizationName, slug: organizationSlug }) });
                setOrganizationName("");
                setOrganizationSlug("");
                await refreshAccount();
              })}
            />
          </VStack>
        </Panel>

        <Panel>
          <VStack gap={3}>
            <Heading level={3}>{tr ? "İki aşamalı doğrulama" : "Two-factor authentication"}</Heading>
            <Text type="supporting" color="secondary">
              {tr ? "Ödeme ve yıkıcı işlemler için TOTP zorunludur." : "TOTP is required for billing and destructive actions."}
            </Text>
            {!mfaFactorId && (
              <HStack gap={2} wrap="wrap">
                <Button label={tr ? "Yeni TOTP ekle" : "Enroll TOTP"} onClick={() => run(async () => {
                  const { data, error } = await cloudClient.auth.mfa.enroll({ factorType: "totp", friendlyName: "Mnema Cloud" });
                  if (error) throw error;
                  setMfaFactorId(data.id);
                  setMfaQr(data.totp.qr_code);
                  setMfaSecret(data.totp.secret);
                })} />
                <Button label={tr ? "Mevcut TOTP ile doğrula" : "Verify existing TOTP"} onClick={() => run(async () => {
                  const { data, error } = await cloudClient.auth.mfa.listFactors();
                  if (error) throw error;
                  const factor = data.totp.find((item) => item.status === "verified");
                  if (!factor) throw new Error(tr ? "Doğrulanmış TOTP bulunamadı." : "No verified TOTP factor found.");
                  setMfaFactorId(factor.id);
                })} />
              </HStack>
            )}
            {mfaQr && <img src={mfaQr} alt="TOTP QR" style={{ width: 200, background: "white", padding: 8 }} />}
            {mfaSecret && <code style={{ overflowWrap: "anywhere" }}>{mfaSecret}</code>}
            {mfaFactorId && (
              <HStack gap={2} wrap="wrap">
                <TextField label={tr ? "6 haneli kod" : "6-digit code"} value={mfaCode} onChange={(value) => setMfaCode(value.replace(/\D/g, "").slice(0, 6))} />
                <Button label={tr ? "Doğrula" : "Verify"} variant="primary" disabled={busy || mfaCode.length !== 6} onClick={() => run(async () => {
                  const { error } = await cloudClient.auth.mfa.challengeAndVerify({ factorId: mfaFactorId, code: mfaCode });
                  if (error) throw error;
                  setMfaCode("");
                  setMfaQr("");
                  setMfaSecret("");
                  setMfaFactorId("");
                  await refreshAccount();
                })} />
              </HStack>
            )}
          </VStack>
        </Panel>
      </Grid>

      <Panel>
        <VStack gap={3}>
          <HStack hAlign="between" vAlign="center" wrap="wrap">
            <VStack gap={1}>
              <Heading level={3}>{tr ? "Ekip davetleri" : "Team invitations"}</Heading>
              <Text type="supporting" color="secondary">
                {tr ? "Davetler doğrulanmış e-postaya bağlıdır; oluşturma ve iptal için MFA gerekir." : "Invitations are bound to verified email; creation and revocation require MFA."}
              </Text>
            </VStack>
            {active && <Tag>{active.role}</Tag>}
          </HStack>
          {organizationMembers.map((member) => {
            const currentUser = member.member_user_id === account?.user.id;
            const mayRemove = !currentUser && (
              active?.role === "owner" ||
              (active?.role === "admin" && ["member", "viewer"].includes(member.member_role))
            );
            return (
              <HStack key={member.member_user_id} hAlign="between" vAlign="center" wrap="wrap">
                <VStack gap={0}>
                  <strong>{member.member_email}</strong>
                  <Text type="supporting" color="secondary">{currentUser ? (tr ? "Sen" : "You") : new Date(member.joined_at).toLocaleDateString()}</Text>
                </VStack>
                <HStack gap={1} wrap="wrap">
                  <Select
                    label={tr ? "Üye rolü" : "Member role"}
                    hideLabel
                    value={member.member_role}
                    disabled={busy || active?.role !== "owner" || Boolean(active?.organizations?.deletion_scheduled_for)}
                    onChange={(role) => void run(async () => {
                      await cloudApi(`/organizations/members/${member.member_user_id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ role }),
                      }, activeOrganization);
                      await Promise.all([refreshAccount(), refreshOrganizationMembers(activeOrganization)]);
                    })}
                    options={[
                      { value: "owner", label: "Owner" },
                      { value: "admin", label: "Admin" },
                      { value: "member", label: "Member" },
                      { value: "viewer", label: "Viewer" },
                    ]}
                  />
                  {mayRemove && (
                    <Button
                      label={tr ? "Üyeyi çıkar" : "Remove member"}
                      disabled={busy || Boolean(active?.organizations?.deletion_scheduled_for)}
                      onClick={() => run(async () => {
                        await cloudApi(`/organizations/members/${member.member_user_id}`, { method: "DELETE" }, activeOrganization);
                        await refreshOrganizationMembers(activeOrganization);
                      })}
                    />
                  )}
                </HStack>
              </HStack>
            );
          })}
          {organizationInvitations.map((invitation) => (
            <HStack key={invitation.invitation_id} hAlign="between" vAlign="center" wrap="wrap">
              <VStack gap={0}>
                <strong>{invitation.email}</strong>
                <Text type="supporting" color="secondary">{invitation.invitation_role} · {invitation.invitation_status}</Text>
              </VStack>
              {invitation.invitation_status === "pending" && (
                <Button
                  label={tr ? "İptal et" : "Revoke"}
                  disabled={busy || account?.user.aal !== "aal2"}
                  onClick={() => run(async () => {
                    await cloudApi(`/organizations/invitations/${invitation.invitation_id}`, { method: "DELETE" }, activeOrganization);
                    await refreshOrganizationInvitations(activeOrganization);
                  })}
                />
              )}
            </HStack>
          ))}
          <Grid minWidth={220} gap={2}>
            <TextField label={tr ? "Davet e-postası" : "Invite email"} type="email" value={inviteEmail} onChange={setInviteEmail} />
            <Select
              label={tr ? "Rol" : "Role"}
              value={inviteRole}
              onChange={setInviteRole}
              options={[
                { value: "viewer", label: "Viewer" },
                { value: "member", label: "Member" },
                ...(active?.role === "owner" ? [{ value: "admin", label: "Admin" }] : []),
              ]}
            />
          </Grid>
          <Button
            label={tr ? "Davet gönder" : "Send invitation"}
            variant="primary"
            disabled={busy || !activeOrganization || !inviteEmail.includes("@") || account?.user.aal !== "aal2" || !["owner", "admin"].includes(active?.role ?? "viewer")}
            onClick={() => run(async () => {
              const result = await cloudApi<{ delivery: string }>("/organizations/invitations", {
                method: "POST",
                body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
              }, activeOrganization);
              setInviteEmail("");
              setMessage(result.delivery === "sent"
                ? (tr ? "Davet e-postası gönderildi." : "Invitation email sent.")
                : (tr ? "Davet oluşturuldu; mevcut kullanıcı uygulamada görecek." : "Invitation created; an existing user will see it in-app."));
              await refreshOrganizationInvitations(activeOrganization);
            })}
          />
        </VStack>
      </Panel>

      <Panel>
        <VStack gap={3}>
          <HStack hAlign="between" vAlign="center" wrap="wrap">
            <VStack gap={1}>
              <Heading level={3}>{tr ? "Bulut proje haritaları" : "Cloud project maps"}</Heading>
              <Text type="supporting" color="secondary">
                {tr ? "Haritalar, kararlar ve çözümler tenant RLS sınırı içinde saklanır." : "Maps, decisions, and solutions stay inside the tenant RLS boundary."}
              </Text>
            </VStack>
            <Tag>{projects.length} {tr ? "proje" : "projects"}</Tag>
          </HStack>
          <Grid minWidth={280} gap={3}>
            <VStack gap={2}>
              {projects.map((project) => (
                <button
                  type="button"
                  className="btn"
                  key={project.id}
                  data-active={selectedProject?.project.id === project.id}
                  onClick={() => run(() => openProject(project))}
                  style={{ justifyContent: "space-between" }}
                >
                  <span>{project.slug}</span>
                  <span>{Object.keys(project.map ?? {}).length} map keys</span>
                </button>
              ))}
              {projects.length === 0 && (
                <Text type="supporting" color="secondary">{tr ? "Bu çalışma alanında henüz proje yok." : "No projects in this workspace yet."}</Text>
              )}
              <TextField label={tr ? "Yeni proje slug" : "New project slug"} value={projectSlug} onChange={(value) => setProjectSlug(value.toLowerCase())} />
              <TextArea label={tr ? "Amaç ve kapsam" : "Purpose and scope"} value={projectSummary} onChange={setProjectSummary} rows={3} />
              <Button
                label={tr ? "Harita iskeletiyle oluştur" : "Create with map skeleton"}
                variant="primary"
                disabled={busy || !activeOrganization || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(projectSlug) || !projectSummary.trim()}
                onClick={() => run(async () => {
                  await cloudApi("/knowledge/projects", {
                    method: "POST",
                    body: JSON.stringify({
                      slug: projectSlug,
                      map: {
                        summary: projectSummary.trim(),
                        architecture: [],
                        components: [],
                        entry_points: [],
                        commands: [],
                        data_model: [],
                        decisions: [],
                        problem_solutions: [],
                        docs: [],
                      },
                    }),
                  }, activeOrganization);
                  setProjectSlug("");
                  setProjectSummary("");
                  await refreshProjects(activeOrganization);
                })}
              />
            </VStack>
            <VStack gap={2}>
              {selectedProject ? (
                <>
                  <HStack hAlign="between" vAlign="center">
                    <Heading level={4}>{selectedProject.project.slug}</Heading>
                    <HStack gap={1} wrap="wrap">
                      <Tag>{selectedProject.memories.length} memories</Tag>
                      <Tag>{selectedProject.documents.length} docs</Tag>
                      <Tag>{selectedProject.relations.length} relations</Tag>
                    </HStack>
                  </HStack>
                  <pre style={{ margin: 0, padding: 12, overflow: "auto", maxHeight: 320, background: "var(--bg-subtle)", borderRadius: 8, fontSize: 12 }}>
                    {JSON.stringify(selectedProject.project.map, null, 2)}
                  </pre>
                </>
              ) : (
                <Text type="supporting" color="secondary">{tr ? "Detaylı haritasını açmak için bir proje seç." : "Select a project to open its detailed map."}</Text>
              )}
              <HStack gap={2} wrap="wrap">
                <div style={{ flex: 1, minWidth: 180 }}>
                  <TextField label={tr ? "Tenant içi arama" : "Search this tenant"} value={searchQuery} onChange={setSearchQuery} />
                </div>
                <Button
                  label={tr ? "Ara" : "Search"}
                  disabled={busy || !activeOrganization || searchQuery.trim().length < 2}
                  onClick={() => run(async () => {
                    const payload = await cloudApi<{ results: CloudSearchResult[] }>(`/knowledge/search?q=${encodeURIComponent(searchQuery.trim())}`, {}, activeOrganization);
                    setSearchResults(payload.results);
                  })}
                />
              </HStack>
              {searchResults.map((result) => (
                <Panel key={`${result.resource_type}:${result.resource_id}`} raised>
                  <VStack gap={1}>
                    <HStack hAlign="between"><strong>{result.title}</strong><Tag>{result.resource_type}</Tag></HStack>
                    <Text type="supporting" color="secondary">{result.snippet}</Text>
                  </VStack>
                </Panel>
              ))}
            </VStack>
          </Grid>
        </VStack>
      </Panel>

      <Panel>
        <VStack gap={3}>
          <HStack hAlign="between" vAlign="center" wrap="wrap">
            <Heading level={3}>{tr ? "Abonelik" : "Subscription"}</Heading>
            <HStack gap={1} wrap="wrap">
              {entitlement && <Tag>{entitlement.plan.toUpperCase()} · {entitlement.entitlements.projects} projects · {entitlement.entitlements.storageMb} MB</Tag>}
              {active && <Tag>{active.organizations?.name ?? active.organization_id}</Tag>}
            </HStack>
          </HStack>
          <Grid minWidth={220} gap={3}>
            <Panel raised={entitlement?.plan === "free"}>
              <VStack gap={2}>
                <Heading level={4}>FREE</Heading>
                <Heading level={3}>$0<span style={{ fontSize: 12 }}>/mo</span></Heading>
                <Text type="supporting" color="secondary">2 projects · 100 MB</Text>
                <Tag>{tr ? "Çalışma alanıyla otomatik aktif" : "Active automatically with a workspace"}</Tag>
              </VStack>
            </Panel>
            <VStack gap={2}>
              <Select
                label={tr ? "Faturalama aralığı" : "Billing interval"}
                value={billingInterval}
                onChange={(value) => setBillingInterval(value as BillingInterval)}
                options={[
                  { value: "monthly", label: tr ? "Aylık" : "Monthly" },
                  { value: "annual", label: tr ? "Yıllık" : "Annual" },
                ]}
              />
              <Text type="supporting" color="secondary">
                {entitlement?.billingEnabled
                  ? (tr ? "Plan seçimi güvenli Paddle checkout'ını açar." : "Choosing a plan opens secure Paddle checkout.")
                  : (tr ? "Ücretsiz önizleme açık. Ücretli checkout, Paddle sandbox anahtarları eklenene kadar kapalı." : "The free preview is open. Paid checkout stays offline until Paddle sandbox credentials are added.")}
              </Text>
            </VStack>
          </Grid>
          <Grid minWidth={200} gap={3}>
            {plans.map((plan) => (
              <Panel key={plan.id} raised={plan.id === selectedPlan || (!selectedPlan && plan.id === "starter")}>
                <VStack gap={2}>
                  <Heading level={4}>{plan.id.toUpperCase()}</Heading>
                  <Heading level={3}>{plan.price}<span style={{ fontSize: 12 }}>/mo</span></Heading>
                  <Text type="supporting" color="secondary">{plan.projects} projects · {plan.storage}</Text>
                  <Button
                    label={tr
                      ? `${plan.id.toUpperCase()} ${billingInterval === "annual" ? "yıllık" : "aylık"} aboneliğine geç`
                      : `Subscribe to ${plan.id.toUpperCase()} ${billingInterval}`}
                    variant={plan.id === selectedPlan || (!selectedPlan && plan.id === "starter") ? "primary" : "secondary"}
                    disabled={busy || !activeOrganization || !["owner", "admin"].includes(active?.role ?? "viewer")}
                    onClick={() => run(async () => {
                      setSelectedPlan(plan.id);
                      if (!entitlement?.billingEnabled) throw new Error("billing_not_configured");
                      if (account?.user.aal !== "aal2") throw new Error("mfa_required");
                      const result = await cloudApi<{ checkoutUrl: string }>(
                        "/billing/checkout",
                        { method: "POST", body: JSON.stringify({ plan: plan.id, interval: billingInterval }) },
                        activeOrganization
                      );
                      window.location.assign(result.checkoutUrl);
                    })}
                  />
                </VStack>
              </Panel>
            ))}
          </Grid>
          {entitlement && entitlement.plan !== "free" && (
            <Button
              label={tr ? "Abonelik, fatura ve ödeme yöntemini yönet" : "Manage subscription, invoices, and payment method"}
              disabled={busy || !activeOrganization || account?.user.aal !== "aal2" || !["owner", "admin"].includes(active?.role ?? "viewer")}
              onClick={() => run(async () => {
                const portal = await cloudApi<{ portalUrl: string }>("/billing/portal", { method: "POST", body: "{}" }, activeOrganization);
                window.location.assign(portal.portalUrl);
              })}
            />
          )}
        </VStack>
      </Panel>

      <Panel>
        <VStack gap={3}>
          <Heading level={3}>{tr ? "Veri taşınabilirliği ve silme" : "Data portability and deletion"}</Heading>
          <Text type="supporting" color="secondary">
            {tr
              ? "Export, tenant verisini RLS oturumunla NDJSON olarak indirir. Silme en az 7 gün gecikmeli ve aktif abonelik iptal edilmeden çalışmaz."
              : "Export downloads tenant data as NDJSON through your RLS session. Deletion is delayed by at least 7 days and requires billing cancellation first."}
          </Text>
          <HStack gap={2} wrap="wrap">
            <Button
              label={tr ? "Tenant verisini dışa aktar" : "Export tenant data"}
              disabled={busy || !activeOrganization || active?.role !== "owner" || account?.user.aal !== "aal2"}
              onClick={() => run(() => downloadCloudExport(activeOrganization, `mnema-${active?.organizations?.slug ?? "workspace"}-export.ndjson`))}
            />
            {active?.organizations?.deletion_scheduled_for && (
              <Button
                label={tr ? "Planlı silmeyi iptal et" : "Cancel scheduled deletion"}
                disabled={busy || active?.role !== "owner" || account?.user.aal !== "aal2"}
                onClick={() => run(async () => {
                  await cloudApi("/organizations/deletion", { method: "DELETE" }, activeOrganization);
                  await refreshAccount();
                })}
              />
            )}
          </HStack>
          {active?.organizations?.deletion_scheduled_for && (
            <Text type="supporting" color="secondary">
              {tr ? "Silme tarihi" : "Scheduled deletion"}: {new Date(active.organizations.deletion_scheduled_for).toLocaleString()}
            </Text>
          )}
          <TextField
            label={tr ? "Silmek için çalışma alanı slug’ını yaz" : "Type the workspace slug to schedule deletion"}
            value={deletionConfirmation}
            onChange={setDeletionConfirmation}
          />
          <Button
            label={tr ? "Çalışma alanını silmeye planla" : "Schedule workspace deletion"}
            disabled={busy || !activeOrganization || active?.role !== "owner" || account?.user.aal !== "aal2" || deletionConfirmation !== active?.organizations?.slug || Boolean(active?.organizations?.deletion_scheduled_for)}
            onClick={() => run(async () => {
              await cloudApi("/organizations/deletion", {
                method: "POST",
                body: JSON.stringify({ confirmationSlug: deletionConfirmation }),
              }, activeOrganization);
              setDeletionConfirmation("");
              await refreshAccount();
            })}
          />
          <VStack gap={2}>
            <Heading level={4}>{tr ? "Cloud hesabını sil" : "Delete Cloud account"}</Heading>
            <Text type="supporting" color="secondary">
              {account?.organizations.some((membership) => membership.role === "owner")
                ? (tr ? "Önce sahip olduğun çalışma alanlarını devret veya sil." : "Transfer or delete every workspace you own first.")
                : (tr ? "Bu işlem Auth kullanıcını ve kalan üyeliklerini kalıcı siler." : "This permanently deletes your Auth user and remaining memberships.")}
            </Text>
            <TextField
              label={tr ? "Onay için hesap e-postanı yaz" : "Type your account email to confirm"}
              type="email"
              value={accountDeletionConfirmation}
              onChange={setAccountDeletionConfirmation}
            />
            <Button
              label={tr ? "Cloud hesabını kalıcı sil" : "Permanently delete Cloud account"}
              disabled={
                busy || account?.user.aal !== "aal2" ||
                accountDeletionConfirmation.toLowerCase() !== account?.user.email?.toLowerCase() ||
                Boolean(account?.organizations.some((membership) => membership.role === "owner"))
              }
              onClick={() => run(async () => {
                await cloudApi("/account", {
                  method: "DELETE",
                  body: JSON.stringify({ confirmationEmail: accountDeletionConfirmation }),
                });
                await cloudClient.auth.signOut({ scope: "local" });
              })}
            />
          </VStack>
        </VStack>
      </Panel>
      {message && <Text type="supporting" color="secondary">{message}</Text>}
    </VStack>
  );
}
