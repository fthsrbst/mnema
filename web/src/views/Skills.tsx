import { useEffect, useState } from "react";
import { VStack, HStack } from "@astryxdesign/core/Layout";
import { Card } from "@astryxdesign/core/Card";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Text, Heading } from "@astryxdesign/core/Text";
import { Item } from "@astryxdesign/core/Item";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { useToast } from "@astryxdesign/core/Toast";
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
      const res = await api<{ content: string }>("POST", "/api/llm", {
        prompt: aiPrompt,
        system: SKILL_MD_SYSTEM_PROMPT,
      });
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
            <Button label={saving ? t("common.saving") : t("common.save")} variant="primary" onClick={save} isDisabled={saving} />
          </HStack>
        </HStack>
        {message && <Text type="supporting" color="secondary">{message}</Text>}
        <TextArea label="SKILL.md" isLabelHidden value={content} onChange={setContent} rows={28} hasSpellCheck={false} />

        <AlertDialog
          isOpen={deleteTarget !== null}
          onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
          title={t("common.confirmDeleteTitle")}
          description={`"${deleteTarget?.name}" ${t("skills.confirmDeleteDesc")}`}
          actionLabel={t("skills.deleteAction")}
          cancelLabel={t("common.cancel")}
          actionVariant="destructive"
          isActionLoading={deleting}
          onAction={confirmDelete}
        />
      </VStack>
    );
  }

  return (
    <VStack gap={4}>
      <HStack hAlign="between" vAlign="center">
        <Heading level={3}>{t("skills.title")}</Heading>
        <Button
          label={t("skills.newSkill")}
          variant="primary"
          onClick={() => { setNewName(""); setNewContent(""); setShowNew(true); }}
        />
      </HStack>
      <Text type="supporting" color="secondary">{t("skills.sourceNote")}</Text>
      {skills.length === 0 ? (
        <EmptyState title={t("skills.empty")} description={t("skills.emptyDesc")} />
      ) : (
        <Card className="glass-card" padding={0}>
          <VStack gap={0}>
            {skills.map((s, i) => (
              <div key={s.name} style={i > 0 ? { borderTop: "1px solid var(--color-border)" } : undefined}>
                <Item
                  label={s.name}
                  description={s.description}
                  endContent={
                    <HStack gap={1}>
                      <Button label={t("common.edit")} variant="secondary" size="sm" onClick={() => { setSelected(s); setContent(s.content); setMessage(""); }} />
                      <Button label={t("common.delete")} variant="ghost" size="sm" onClick={() => setDeleteTarget(s)} />
                    </HStack>
                  }
                />
              </div>
            ))}
          </VStack>
        </Card>
      )}

      <Dialog isOpen={showNew} onOpenChange={setShowNew} purpose="form" width={640}>
        <DialogHeader title={t("skills.newDialogTitle")} />
        <VStack gap={3} paddingInline={5} paddingBlock={4}>
          <TextInput label={t("skills.name")} value={newName} onChange={setNewName} isRequired />
          <HStack hAlign="between" vAlign="center">
            <Text type="supporting" color="secondary">SKILL.md</Text>
            <Button label={t("skills.aiDraft")} variant="secondary" size="sm" onClick={() => setShowAiDraft(true)} />
          </HStack>
          <TextArea label="SKILL.md" isLabelHidden value={newContent} onChange={setNewContent} rows={16} hasSpellCheck={false} />
          <HStack gap={2}>
            <Button label={saving ? t("common.saving") : t("common.create")} variant="primary" onClick={createSkill} isDisabled={saving || !newName.trim() || !newContent.trim()} />
            <Button label={t("common.cancel")} variant="secondary" onClick={() => setShowNew(false)} />
          </HStack>
        </VStack>
      </Dialog>

      <Dialog isOpen={showAiDraft} onOpenChange={setShowAiDraft} purpose="form" width={480}>
        <DialogHeader title={t("skills.aiDraftDialogTitle")} />
        <VStack gap={3} paddingInline={5} paddingBlock={4}>
          <TextArea label={t("skills.aiDraftPrompt")} value={aiPrompt} onChange={setAiPrompt} rows={4} isRequired />
          <HStack gap={2}>
            <Button label={aiBusy ? t("skills.aiDraftGenerating") : t("skills.aiDraftGenerate")} variant="primary" onClick={generateDraft} isDisabled={aiBusy || !aiPrompt.trim()} />
            <Button label={t("common.cancel")} variant="secondary" onClick={() => setShowAiDraft(false)} isDisabled={aiBusy} />
          </HStack>
        </VStack>
      </Dialog>

      <AlertDialog
        isOpen={deleteTarget !== null && !selected}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t("common.confirmDeleteTitle")}
        description={`"${deleteTarget?.name}" ${t("skills.confirmDeleteDesc")}`}
        actionLabel={t("skills.deleteAction")}
        cancelLabel={t("common.cancel")}
        actionVariant="destructive"
        isActionLoading={deleting}
        onAction={confirmDelete}
      />
    </VStack>
  );
}
