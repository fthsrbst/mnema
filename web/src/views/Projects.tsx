import { useEffect, useState } from "react";
import { VStack, HStack } from "@astryxdesign/core/Layout";
import { Grid } from "@astryxdesign/core/Grid";
import { Card } from "@astryxdesign/core/Card";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Selector } from "@astryxdesign/core/Selector";
import { Text, Heading } from "@astryxdesign/core/Text";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { useToast } from "@astryxdesign/core/Toast";
import { api, type ProjectMap } from "../api";
import { useI18n } from "../i18n";
import { Markdown } from "../components/Markdown";

const STATUS_OPTIONS = ["active", "paused", "done", "idea"];

function statusVariant(s: string | undefined) {
  return s === "active" ? "success" : s === "paused" ? "warning" : s === "done" ? "neutral" : "accent";
}

export function Projects() {
  const { t } = useI18n();
  const toast = useToast();
  const [projects, setProjects] = useState<ProjectMap[]>([]);
  const [selected, setSelected] = useState<ProjectMap | null>(null);
  const [summary, setSummary] = useState("");
  const [status, setStatus] = useState("active");
  const [stack, setStack] = useState("");
  const [focus, setFocus] = useState("");
  const [nextSteps, setNextSteps] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProjectMap | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");

  const load = async () => {
    try {
      setProjects(await api<ProjectMap[]>("GET", "/api/projects"));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const open = (p: ProjectMap) => {
    setSelected(p);
    setSummary(p.summary ?? "");
    setStatus(p.status ?? "active");
    setStack((p.stack ?? []).join(", "));
    setFocus(p.current_focus ?? "");
    setNextSteps((p.next_steps ?? []).join("\n"));
    setNotes(p.notes ?? "");
  };

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await api("PUT", `/api/projects/${encodeURIComponent(selected.name)}`, {
        summary,
        status,
        stack: stack.split(",").map((s) => s.trim()).filter(Boolean),
        current_focus: focus,
        next_steps: nextSteps.split("\n").map((s) => s.trim()).filter(Boolean),
        notes,
      });
      toast({ body: t("common.savedToast"), type: "info" });
      setSelected(null);
      await load();
    } catch (err) {
      toast({ body: `${t("common.saveFailed")}: ${(err as Error).message}`, type: "error" });
    } finally {
      setSaving(false);
    }
  };

  const createProject = async () => {
    if (!newName.trim()) return;
    setSaving(true);
    try {
      await api("PUT", `/api/projects/${encodeURIComponent(newName.trim())}`, {
        summary,
        status,
        stack: stack.split(",").map((s) => s.trim()).filter(Boolean),
        current_focus: focus,
        next_steps: nextSteps.split("\n").map((s) => s.trim()).filter(Boolean),
        notes,
      });
      toast({ body: t("common.createdToast"), type: "info" });
      setShowNew(false);
      setNewName("");
      setSummary("");
      setStatus("active");
      setStack("");
      setFocus("");
      setNextSteps("");
      setNotes("");
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
      await api("DELETE", `/api/projects/${encodeURIComponent(deleteTarget.name)}`);
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

  if (selected) {
    return (
      <VStack gap={4}>
        <HStack gap={3} vAlign="center" hAlign="between">
          <HStack gap={3} vAlign="center">
            <Button label={t("common.back")} variant="secondary" onClick={() => setSelected(null)} />
            <Heading level={3}>{selected.name}</Heading>
            <StatusDot variant={statusVariant(selected.status)} label={selected.status ?? t("projects.unknownStatus")} />
          </HStack>
          <Button label={t("common.delete")} variant="destructive" onClick={() => setDeleteTarget(selected)} />
        </HStack>
        <Card className="glass-card">
          <VStack gap={3}>
            <TextArea label={t("projects.summary")} value={summary} onChange={setSummary} rows={2} />
            <HStack gap={3}>
              <Selector label={t("projects.status")} value={status} onChange={setStatus} options={STATUS_OPTIONS} />
              <TextInput label={t("projects.stack")} value={stack} onChange={setStack} isOptional />
            </HStack>
            {selected.repo && <Text color="secondary">Repo: {selected.repo}</Text>}
            <TextInput label={t("projects.currentFocus")} value={focus} onChange={setFocus} />
            <TextArea label={t("projects.nextSteps")} value={nextSteps} onChange={setNextSteps} rows={5} />
            <TextArea label={t("projects.notes")} value={notes} onChange={setNotes} rows={3} isOptional />
            <HStack gap={2}>
              <Button label={saving ? t("common.saving") : t("common.save")} variant="primary" onClick={save} isDisabled={saving} />
            </HStack>
          </VStack>
        </Card>
        {(selected.decisions?.length ?? 0) > 0 && (
          <Card className="glass-card">
            <VStack gap={2}>
              <Heading level={4}>{t("projects.decisions")}</Heading>
              {selected.decisions!.map((d, i) => (
                <HStack
                  key={i}
                  gap={2}
                  vAlign="start"
                  style={i > 0 ? { borderTop: "1px solid var(--color-border)" } : undefined}
                  paddingBlock={i > 0 ? 2 : undefined}
                >
                  <Text type="supporting" color="secondary">•</Text>
                  <Markdown headingLevelStart={6}>{d}</Markdown>
                </HStack>
              ))}
            </VStack>
          </Card>
        )}

        <AlertDialog
          isOpen={deleteTarget !== null}
          onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
          title={t("common.confirmDeleteTitle")}
          description={`"${deleteTarget?.name}" ${t("projects.confirmDeleteDesc")}`}
          actionLabel={t("projects.deleteAction")}
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
        <Heading level={3}>{t("projects.title")}</Heading>
        <Button
          label={t("projects.newProject")}
          variant="primary"
          onClick={() => {
            setNewName("");
            setSummary("");
            setStatus("active");
            setStack("");
            setFocus("");
            setNextSteps("");
            setNotes("");
            setShowNew(true);
          }}
        />
      </HStack>
      {error && <Text color="secondary">{t("common.error")}: {error}</Text>}
      {projects.length === 0 ? (
        <EmptyState title={t("projects.empty")} description={t("projects.emptyDesc")} />
      ) : (
        <Grid columns={{ minWidth: 300, repeat: "fit" }} gap={4}>
          {projects.map((p) => (
            <Card key={p.name} className="glass-card">
              <VStack gap={2}>
                <HStack gap={2} vAlign="center" hAlign="between">
                  <Heading level={4}>{p.name}</Heading>
                  <StatusDot variant={statusVariant(p.status)} label={p.status ?? t("projects.unknownStatus")} />
                </HStack>
                <Text type="supporting" color="secondary">{p.summary ?? ""}</Text>
                {p.current_focus && <Text type="supporting">Odak: {p.current_focus}</Text>}
                <HStack gap={2}>
                  <Button label={t("common.open")} variant="secondary" size="sm" onClick={() => open(p)} />
                  <Button label={t("common.delete")} variant="ghost" size="sm" onClick={() => setDeleteTarget(p)} />
                </HStack>
              </VStack>
            </Card>
          ))}
        </Grid>
      )}

      <Dialog isOpen={showNew} onOpenChange={setShowNew} purpose="form" width={520}>
        <DialogHeader title={t("projects.newDialogTitle")} />
        <VStack gap={3} paddingInline={5} paddingBlock={4}>
          <TextInput label={t("projects.name")} value={newName} onChange={setNewName} isRequired />
          <TextArea label={t("projects.summary")} value={summary} onChange={setSummary} rows={2} isOptional />
          <HStack gap={3}>
            <Selector label={t("projects.status")} value={status} onChange={setStatus} options={STATUS_OPTIONS} />
            <TextInput label={t("projects.stack")} value={stack} onChange={setStack} isOptional />
          </HStack>
          <TextInput label={t("projects.currentFocus")} value={focus} onChange={setFocus} isOptional />
          <TextArea label={t("projects.nextSteps")} value={nextSteps} onChange={setNextSteps} rows={3} isOptional />
          <HStack gap={2}>
            <Button label={saving ? t("common.saving") : t("common.create")} variant="primary" onClick={createProject} isDisabled={saving || !newName.trim()} />
            <Button label={t("common.cancel")} variant="secondary" onClick={() => setShowNew(false)} />
          </HStack>
        </VStack>
      </Dialog>

      <AlertDialog
        isOpen={deleteTarget !== null && !selected}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t("common.confirmDeleteTitle")}
        description={`"${deleteTarget?.name}" ${t("projects.confirmDeleteDesc")}`}
        actionLabel={t("projects.deleteAction")}
        cancelLabel={t("common.cancel")}
        actionVariant="destructive"
        isActionLoading={deleting}
        onAction={confirmDelete}
      />
    </VStack>
  );
}
