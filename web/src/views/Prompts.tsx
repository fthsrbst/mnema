import { useCallback, useEffect, useState } from "react";
import { VStack, HStack, Grid } from "../components/ui/Stack";
import { Panel } from "../components/ui/Panel";
import { Button } from "../components/ui/Button";
import { TextField } from "../components/ui/Field";
import { Heading, Text } from "../components/ui/Typography";
import { EmptyState } from "../components/ui/EmptyState";
import { Tabs } from "../components/ui/Tabs";
import { Dialog } from "../components/ui/Dialog";
import { Tag } from "../components/ui/Tag";
import { useToast } from "../components/ui/useToast";
import { api, type PromptList } from "../api";
import { useI18n } from "../i18n";
import { Markdown } from "../components/Markdown";

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
            {isMaster && <Tag solid>{t("prompts.master")}</Tag>}
          </HStack>
          <Button label={saving ? t("common.saving") : t("common.save")} variant="primary" onClick={save} disabled={saving || !isDirty} />
        </HStack>

        <Panel>
          <Text color="secondary">{isMaster ? t("prompts.masterBannerDesc") : t("prompts.roleBannerDesc")}</Text>
        </Panel>

        {loadingDetail ? (
          <Text color="secondary">{t("common.loading")}</Text>
        ) : (
          <>
            <Tabs
              value={tab}
              onChange={setTab}
              items={[
                { value: "edit", label: t("prompts.tabEdit") },
                { value: "preview", label: t("prompts.tabPreview") },
                ...(isMaster ? [] : [{ value: "composed" as EditorTab, label: t("prompts.tabComposed") }]),
              ]}
            />

            {tab === "edit" && (
              <textarea className="textarea" value={draft} onChange={(e) => setDraft(e.target.value)} rows={24} spellCheck={false} aria-label={t("common.content")} />
            )}
            {tab === "preview" && (
              <Panel>
                <Markdown headingLevelStart={4}>{draft || "*Boş*"}</Markdown>
              </Panel>
            )}
            {tab === "composed" && !isMaster && (
              <Panel>
                <Markdown headingLevelStart={4}>{composed || "*Boş*"}</Markdown>
              </Panel>
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

      <Panel>
        <Text color="secondary">{t("prompts.bannerDesc")}</Text>
      </Panel>

      {error && <Text color="secondary">{t("common.error")}: {error}</Text>}

      {list === null ? (
        <Text color="secondary">{t("common.loading")}</Text>
      ) : (
        <VStack gap={4}>
          {list.master && (
            <VStack gap={2}>
              <Heading level={4}>{t("prompts.master")}</Heading>
              <Panel>
                <HStack hAlign="between" vAlign="center">
                  <VStack gap={1}>
                    <HStack gap={2} vAlign="center">
                      <Text>{list.master.name}</Text>
                      <Tag solid>{t("prompts.master")}</Tag>
                    </HStack>
                    <Text type="supporting" color="secondary">{list.master.description || t("prompts.noDescription")}</Text>
                  </VStack>
                  <Button label={t("common.open")} variant="secondary" size="sm" onClick={() => openPrompt("master")} />
                </HStack>
              </Panel>
            </VStack>
          )}

          <VStack gap={2}>
            <Heading level={4}>{t("prompts.roles")}</Heading>
            {list.roles.length === 0 ? (
              <EmptyState title={t("prompts.noRoles")} description={t("prompts.noRolesDesc")} />
            ) : (
              <Grid minWidth={260} gap={3}>
                {list.roles.map((r) => (
                  <Panel key={r.name}>
                    <VStack gap={2}>
                      <Text>{r.name}</Text>
                      <Text type="supporting" color="secondary">{r.description || t("prompts.noDescription")}</Text>
                      <Button label={t("common.open")} variant="secondary" size="sm" onClick={() => openPrompt(r.name)} />
                    </VStack>
                  </Panel>
                ))}
              </Grid>
            )}
          </VStack>
        </VStack>
      )}

      <Dialog isOpen={showNew} onOpenChange={setShowNew} width={480} title={t("prompts.newDialogTitle")}>
        <TextField label={t("prompts.roleName")} value={newName} onChange={setNewName} />
        <TextField label={t("prompts.roleDescription")} value={newDescription} onChange={setNewDescription} optional />
        <HStack gap={2}>
          <Button label={creating ? t("common.saving") : t("common.create")} variant="primary" onClick={createRole} disabled={creating || !newName.trim()} />
          <Button label={t("common.cancel")} variant="secondary" onClick={() => setShowNew(false)} />
        </HStack>
      </Dialog>
    </VStack>
  );
}
