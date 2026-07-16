import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { cloudApi, cloudConfigured, supabase } from "../cloud";
import { Button } from "../components/ui/Button";
import { TextField } from "../components/ui/Field";
import { Panel } from "../components/ui/Panel";
import { Grid, HStack, VStack } from "../components/ui/Stack";
import { Tag } from "../components/ui/Tag";
import { Heading, Text } from "../components/ui/Typography";
import { useI18n } from "../i18n";

interface CloudOrganization {
  organization_id: string;
  role: "owner" | "admin" | "member" | "viewer";
  organizations?: { id: string; name: string; slug: string } | null;
}

interface CloudSessionPayload {
  user: { id: string; email: string | null; aal: "aal1" | "aal2" };
  organizations: CloudOrganization[];
}

const plans = [
  { id: "starter", price: "$9", projects: "10", storage: "1 GB" },
  { id: "pro", price: "$19", projects: "50", storage: "5 GB" },
  { id: "team", price: "$49", projects: "250", storage: "20 GB" },
] as const;

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
  const [mfaFactorId, setMfaFactorId] = useState("");
  const [mfaQr, setMfaQr] = useState("");
  const [mfaSecret, setMfaSecret] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const refreshAccount = async () => {
    const payload = await cloudApi<CloudSessionPayload>("/session");
    setAccount(payload);
    setActiveOrganization((current) => current || payload.organizations[0]?.organization_id || "");
  };

  useEffect(() => {
    if (!cloudClient) return;
    void cloudClient.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = cloudClient.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setAccount(null);
      return;
    }
    void refreshAccount().catch((error) => setMessage((error as Error).message));
  }, [session?.access_token]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try {
      await operation();
    } catch (error) {
      setMessage((error as Error).message);
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
          <Button label={tr ? "Çıkış" : "Sign out"} onClick={() => run(async () => { await cloudClient.auth.signOut(); })} />
        </HStack>
      </HStack>

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
            <Heading level={3}>{tr ? "Abonelik" : "Subscription"}</Heading>
            {active && <Tag>{active.organizations?.name ?? active.organization_id}</Tag>}
          </HStack>
          <Grid minWidth={200} gap={3}>
            {plans.map((plan) => (
              <Panel key={plan.id} raised={plan.id === "starter"}>
                <VStack gap={2}>
                  <Heading level={4}>{plan.id.toUpperCase()}</Heading>
                  <Heading level={3}>{plan.price}<span style={{ fontSize: 12 }}>/mo</span></Heading>
                  <Text type="supporting" color="secondary">{plan.projects} projects · {plan.storage}</Text>
                  <Button
                    label={tr ? "Yıllık planı seç" : "Choose annual"}
                    variant={plan.id === "starter" ? "primary" : "secondary"}
                    disabled={busy || !activeOrganization || account?.user.aal !== "aal2" || !["owner", "admin"].includes(active?.role ?? "viewer")}
                    onClick={() => run(async () => {
                      const result = await cloudApi<{ checkoutUrl: string }>(
                        "/billing/checkout",
                        { method: "POST", body: JSON.stringify({ plan: plan.id, interval: "annual" }) },
                        activeOrganization
                      );
                      window.location.assign(result.checkoutUrl);
                    })}
                  />
                </VStack>
              </Panel>
            ))}
          </Grid>
        </VStack>
      </Panel>
      {message && <Text type="supporting" color="secondary">{message}</Text>}
    </VStack>
  );
}
