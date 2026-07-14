import { useEffect, useState } from "react";
import { VStack, HStack } from "../components/ui/Stack";
import { Panel } from "../components/ui/Panel";
import { Button } from "../components/ui/Button";
import { TextField, TextArea } from "../components/ui/Field";
import { Heading, Text } from "../components/ui/Typography";
import { EmptyState } from "../components/ui/EmptyState";
import { ListRow } from "../components/ui/ListRow";
import { AlertDialog, Dialog } from "../components/ui/Dialog";
import { useToast } from "../components/ui/useToast";
import { api, type Skill } from "../api";
import { useI18n } from "../i18n";

const SKILL_MD_SYSTEM_PROMPT = `You write SKILL.md files for AI agent skills. Output ONLY the markdown content, no commentary.
Format:
---
name: <kebab-case-name>
description: <one sentence, when to use this skill>
---

# <Title>

<Body: clear instructions for an AI agent describing what to do, step by step, when this skill is invoked. Use Markdown headings and bullet lists. Keep it concise and actionable.>`;

export function Skills() {
  const { t } = useI18n();
  const toast = useToast();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selected, setSelected] = useState<Skill | null>(null);
  const [content, setContent] = useState("");
  const [message, setMessage] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Skill | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newContent, setNewContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [showAiDraft, setShowAiDraft] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);

  const load = async () => {
    try {
      setSkills(await api<Skill[]>("GET", "/api/skills"));
    } catch {
      setSkills([]);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const res = await api<{ note: string }>("PUT", `/api/skills/${selected.name}`, { content });
      setMessage(res.note);
      toast({ body: t("common.savedToast"), type: "info" });
      await load();
    } catch (err) {
      toast({ body: `${t("common.saveFailed")}: ${(err as Error).message}`, type: "error" });
    } finally {
      setSaving(false);
    }
  };

  const createSkill = async () => {
    if (!newName.trim() || !newContent.trim()) return;
    setSaving(true);
    try {
      await api("PUT", `/api/skills/${newName.trim()}`, { content: newContent });
      toast({ body: t("common.createdToast"), type: "info" });
      setShowNew(false);
      setNewName("");
      setNewContent("");
      await load();
    } catch (err) {
      toast({ body: `${t("common.saveFailed")}: ${(err as Error).message}`, type: "error" });
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api("DELETE", `/api/skills/${deleteTarget.name}`);
      toast({ body: t("common.deletedToast"), type: "info" });
      if (selected?.name === deleteTarget.name) setSelected(null);
      setDeleteTarget(null);
      await load();
    } catch (err) {
      toast({ body: `${t("common.deleteFailed")}: ${(err as Error).message}`, type: "error" });
    } finally {
      setDeleting(false);
    }
  };

  const generateDraft = async () => {
    if (!aiPrompt.trim()) return;
    setAiBusy(true);
    try {
      const res = await api<{ content: string }>("POST", "/api/llm", { prompt: aiPrompt, system: SKILL_MD_SYSTEM_PROMPT });
      setNewContent(res.content);
      setShowAiDraft(false);
      setAiPrompt("");
      toast({ body: t("skills.aiDraftDone"), type: "info" });
    } catch (err) {
      toast({ body: `${t("skills.aiDraftFailed")}: ${(err as Error).message}`, type: "error" });
    } finally {
      setAiBusy(false);
    }
  };

  if (selected) {
    return (
      <VStack gap={4}>
        <HStack gap={3} vAlign="center" hAlign="between">
          <HStack gap={3} vAlign="center">
            <Button label={t("common.back")} variant="secondary" onClick={() => { setSelected(null); setMessage(""); }} />
            <Heading level={3}>{selected.name}</Heading>
          </HStack>
          <HStack gap={2}>
            <Button label={t("common.delete")} variant="destructive" onClick={() => setDeleteTarget(selected)} />
            <Button label={saving ? t("common.saving") : t("common.save")} variant="primary" onClick={save} disabled={saving} />
          </HStack>
        </HStack>
        {message && <Text type="supporting" color="secondary">{message}</Text>}
        <textarea className="textarea" value={content} onChange={(e) => setContent(e.target.value)} rows={28} spellCheck={false} aria-label="SKILL.md" />

        <AlertDialog
          isOpen={deleteTarget !== null}
          onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
          title={t("common.confirmDeleteTitle")}
          description={`"${deleteTarget?.name}" ${t("skills.confirmDeleteDesc")}`}
          actionLabel={t("skills.deleteAction")}
          cancelLabel={t("common.cancel")}
          loading={deleting}
          onAction={confirmDelete}
        />
      </VStack>
    );
  }

  return (
    <VStack gap={4}>
      <HStack hAlign="between" vAlign="center">
        <Heading level={3}>{t("skills.title")}</Heading>
        <Button label={t("skills.newSkill")} variant="primary" onClick={() => { setNewName(""); setNewContent(""); setShowNew(true); }} />
      </HStack>
      <Text type="supporting" color="secondary">{t("skills.sourceNote")}</Text>
      {skills.length === 0 ? (
        <EmptyState title={t("skills.empty")} description={t("skills.emptyDesc")} />
      ) : (
        <Panel padded={false}>
          <VStack gap={0}>
            {skills.map((s, i) => (
              <ListRow
                key={s.name}
                bordered={i > 0}
                title={s.name}
                description={s.description}
                end={
                  <HStack gap={1}>
                    <Button label={t("common.edit")} variant="secondary" size="sm" onClick={() => { setSelected(s); setContent(s.content); setMessage(""); }} />
                    <Button label={t("common.delete")} variant="ghost" size="sm" onClick={() => setDeleteTarget(s)} />
                  </HStack>
                }
              />
            ))}
          </VStack>
        </Panel>
      )}

      <Dialog isOpen={showNew} onOpenChange={setShowNew} width={640} title={t("skills.newDialogTitle")}>
        <TextField label={t("skills.name")} value={newName} onChange={setNewName} />
        <HStack hAlign="between" vAlign="center">
          <Text type="supporting" color="secondary">SKILL.md</Text>
          <Button label={t("skills.aiDraft")} variant="secondary" size="sm" onClick={() => setShowAiDraft(true)} />
        </HStack>
        <textarea className="textarea" value={newContent} onChange={(e) => setNewContent(e.target.value)} rows={16} spellCheck={false} aria-label="SKILL.md" />
        <HStack gap={2}>
          <Button label={saving ? t("common.saving") : t("common.create")} variant="primary" onClick={createSkill} disabled={saving || !newName.trim() || !newContent.trim()} />
          <Button label={t("common.cancel")} variant="secondary" onClick={() => setShowNew(false)} />
        </HStack>
      </Dialog>

      <Dialog isOpen={showAiDraft} onOpenChange={setShowAiDraft} width={480} title={t("skills.aiDraftDialogTitle")}>
        <TextArea label={t("skills.aiDraftPrompt")} value={aiPrompt} onChange={setAiPrompt} rows={4} />
        <HStack gap={2}>
          <Button label={aiBusy ? t("skills.aiDraftGenerating") : t("skills.aiDraftGenerate")} variant="primary" onClick={generateDraft} disabled={aiBusy || !aiPrompt.trim()} />
          <Button label={t("common.cancel")} variant="secondary" onClick={() => setShowAiDraft(false)} disabled={aiBusy} />
        </HStack>
      </Dialog>

      <AlertDialog
        isOpen={deleteTarget !== null && !selected}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t("common.confirmDeleteTitle")}
        description={`"${deleteTarget?.name}" ${t("skills.confirmDeleteDesc")}`}
        actionLabel={t("skills.deleteAction")}
        cancelLabel={t("common.cancel")}
        loading={deleting}
        onAction={confirmDelete}
      />
    </VStack>
  );
}
