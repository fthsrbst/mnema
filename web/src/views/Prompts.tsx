import { useCallback, useEffect, useState } from "react";
import { VStack, HStack } from "@astryxdesign/core/Layout";
import { Grid } from "@astryxdesign/core/Grid";
import { Card } from "@astryxdesign/core/Card";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Text, Heading } from "@astryxdesign/core/Text";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Banner } from "@astryxdesign/core/Banner";
import { TabList, Tab } from "@astryxdesign/core/TabList";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { useToast } from "@astryxdesign/core/Toast";
import { api, type PromptList } from "../api";
import { useI18n } from "../i18n";

type EditorTab = "edit" | "preview" | "composed";

export function Prompts() {
  const { t } = useI18n();
  const toast = useToast();
  const [list, setList] = useState<PromptList | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [raw, setRaw] = useState("");
  const [draft, setDraft] = useState("");
  const [composed, setComposed] = useState("");
  const [tab, setTab] = useState<EditorTab>("edit");
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setError("");
      setList(await api<PromptList>("GET", "/api/prompts"));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openPrompt = async (name: string) => {
    setSelected(name);
    setTab("edit");
    setLoadingDetail(true);
    try {
      const [rawRes, composedRes] = await Promise.all([
        api<{ name: string; content: string }>("GET", `/api/prompts/${name}?raw=1`),
        api<{ name: string; content: string }>("GET", `/api/prompts/${name}`),
      ]);
      setRaw(rawRes.content);
      setDraft(rawRes.content);
      setComposed(composedRes.content);
    } catch (err) {
      toast({ body: `${t("common.loadFailed")}: ${(err as Error).message}`, type: "error" });
      setSelected(null);
    } finally {
      setLoadingDetail(false);
    }
  };

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await api("PUT", `/api/prompts/${selected}`, { content: draft });
      setRaw(draft);
      const composedRes = await api<{ name: string; content: string }>("GET", `/api/prompts/${selected}`);
      setComposed(composedRes.content);
      toast({ body: t("prompts.savedNote"), type: "info" });
    } catch (err) {
      toast({ body: `${t("prompts.saveFailedNote")}: ${(err as Error).message}`, type: "error" });
    } finally {
      setSaving(false);
    }
  };

  const createRole = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const content = `---\nname: ${newName.trim()}\ndescription: ${newDescription.trim()}\n---\n\n`;
      await api("PUT", `/api/prompts/${newName.trim()}`, { content });
      toast({ body: t("common.createdToast"), type: "info" });
      setShowNew(false);
      setNewName("");
      setNewDescription("");
      await load();
      await openPrompt(newName.trim());
    } catch (err) {
      toast({ body: `${t("common.saveFailed")}: ${(err as Error).message}`, type: "error" });
    } finally {
      setCreating(false);
    }
  };

  const isDirty = draft !== raw;
  const isMaster = selected === "master";

  if (selected) {
    return (
      <VStack gap={4}>
        <HStack hAlign="between" vAlign="center">
          <HStack gap={3} vAlign="center">
            <Button label={t("common.back")} variant="secondary" onClick={() => setSelected(null)} />
            <Heading level={3}>{selected}</Heading>
            {isMaster && <span className="rx-tag rx-tag-navy">{t("prompts.master")}</span>}
          </HStack>
          <Button label={saving ? t("common.saving") : t("common.save")} variant="primary" onClick={save} isDisabled={saving || !isDirty} />
        </HStack>

        {isMaster ? (
          <Banner
            status="info"
            title={t("prompts.masterBannerTitle")}
            description={t("prompts.masterBannerDesc")}
          />
        ) : (
          <Banner
            status="info"
            title={t("prompts.roleBannerTitle")}
            description={t("prompts.roleBannerDesc")}
          />
        )}

        {loadingDetail ? (
          <Text color="secondary">{t("common.loading")}</Text>
        ) : (
          <>
            <TabList value={tab} onChange={(v) => setTab(v as EditorTab)} hasDivider>
              <Tab value="edit" label={t("prompts.tabEdit")} />
              <Tab value="preview" label={t("prompts.tabPreview")} />
              {!isMaster && <Tab value="composed" label={t("prompts.tabComposed")} />}
            </TabList>

            {tab === "edit" && (
              <TextArea
                label={t("common.content")}
                isLabelHidden
                value={draft}
                onChange={setDraft}
                rows={24}
                hasSpellCheck={false}
              />
            )}
            {tab === "preview" && (
              <Card className="glass-card">
                <Markdown headingLevelStart={4}>{draft || "*Boş*"}</Markdown>
              </Card>
            )}
            {tab === "composed" && !isMaster && (
              <Card className="glass-card">
                <Markdown headingLevelStart={4}>{composed || "*Boş*"}</Markdown>
              </Card>
            )}
          </>
        )}
      </VStack>
    );
  }

  return (
    <VStack gap={5}>
      <HStack hAlign="between" vAlign="start">
        <VStack gap={1}>
          <Heading level={3}>{t("prompts.title")}</Heading>
          <Text type="supporting" color="secondary">{t("prompts.subtitle")}</Text>
        </VStack>
        <Button label={t("prompts.newRole")} variant="primary" onClick={() => { setNewName(""); setNewDescription(""); setShowNew(true); }} />
      </HStack>

      <Banner
        status="info"
        title={t("prompts.bannerTitle")}
        description={t("prompts.bannerDesc")}
      />

      {error && <Text color="secondary">{t("common.error")}: {error}</Text>}

      {list === null ? (
        <Text color="secondary">{t("common.loading")}</Text>
      ) : (
        <VStack gap={4}>
          {list.master && (
            <VStack gap={2}>
              <Heading level={4}>{t("prompts.master")}</Heading>
              <Card className="glass-card">
                <HStack hAlign="between" vAlign="center">
                  <VStack gap={1}>
                    <HStack gap={2} vAlign="center">
                      <Text>{list.master.name}</Text>
                      <span className="rx-tag rx-tag-navy">{t("prompts.master")}</span>
                    </HStack>
                    <Text type="supporting" color="secondary">{list.master.description || t("prompts.noDescription")}</Text>
                  </VStack>
                  <Button label={t("common.open")} variant="secondary" size="sm" onClick={() => openPrompt("master")} />
                </HStack>
              </Card>
            </VStack>
          )}

          <VStack gap={2}>
            <Heading level={4}>{t("prompts.roles")}</Heading>
            {list.roles.length === 0 ? (
              <EmptyState title={t("prompts.noRoles")} description={t("prompts.noRolesDesc")} />
            ) : (
              <Grid columns={{ minWidth: 280, repeat: "fit" }} gap={3}>
                {list.roles.map((r) => (
                  <Card key={r.name} className="glass-card">
                    <VStack gap={2}>
                      <Text>{r.name}</Text>
                      <Text type="supporting" color="secondary">{r.description || t("prompts.noDescription")}</Text>
                      <HStack>
                        <Button label={t("common.open")} variant="secondary" size="sm" onClick={() => openPrompt(r.name)} />
                      </HStack>
                    </VStack>
                  </Card>
                ))}
              </Grid>
            )}
          </VStack>
        </VStack>
      )}

      <Dialog isOpen={showNew} onOpenChange={setShowNew} purpose="form" width={480}>
        <DialogHeader title={t("prompts.newDialogTitle")} />
        <VStack gap={3} paddingInline={5} paddingBlock={4}>
          <TextInput label={t("prompts.roleName")} value={newName} onChange={setNewName} isRequired />
          <TextInput label={t("prompts.roleDescription")} value={newDescription} onChange={setNewDescription} isOptional />
          <HStack gap={2}>
            <Button label={creating ? t("common.saving") : t("common.create")} variant="primary" onClick={createRole} isDisabled={creating || !newName.trim()} />
            <Button label={t("common.cancel")} variant="secondary" onClick={() => setShowNew(false)} />
          </HStack>
        </VStack>
      </Dialog>
    </VStack>
  );
}
