import { useEffect, useState } from "react";
import { VStack, HStack } from "@astryxdesign/core/Layout";
import { Grid } from "@astryxdesign/core/Grid";
import { Card } from "@astryxdesign/core/Card";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Text, Heading } from "@astryxdesign/core/Text";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { useToast } from "@astryxdesign/core/Toast";
import { api, type MachineStatus } from "../api";
import { useI18n } from "../i18n";

export function Machines() {
  const { t } = useI18n();
  const toast = useToast();
  const [machines, setMachines] = useState<MachineStatus[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<MachineStatus | null>(null);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [lmstudioPort, setLmstudioPort] = useState("");
  const [ollamaPort, setOllamaPort] = useState("");
  const [comfyuiPort, setComfyuiPort] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MachineStatus | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = async () => {
    setMachines(null);
    try {
      setMachines(await api<MachineStatus[]>("GET", "/api/machines/status"));
    } catch {
      setMachines([]);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const openNew = () => {
    setEditing(null);
    setName("");
    setHost("");
    setLmstudioPort("");
    setOllamaPort("");
    setComfyuiPort("");
    setNotes("");
    setShowForm(true);
  };

  const openEdit = (m: MachineStatus) => {
    setEditing(m);
    setName(m.name);
    setHost(m.host);
    setLmstudioPort(m.lmstudio_port ? String(m.lmstudio_port) : "");
    setOllamaPort(m.ollama_port ? String(m.ollama_port) : "");
    setComfyuiPort(m.comfyui_port ? String(m.comfyui_port) : "");
    setNotes(m.notes ?? "");
    setShowForm(true);
  };

  const save = async () => {
    if (!name.trim() || !host.trim()) return;
    setSaving(true);
    try {
      await api("PUT", `/api/machines/${encodeURIComponent(name.trim())}`, {
        host: host.trim(),
        lmstudio_port: lmstudioPort ? Number(lmstudioPort) : null,
        ollama_port: ollamaPort ? Number(ollamaPort) : null,
        comfyui_port: comfyuiPort ? Number(comfyuiPort) : null,
        notes: notes.trim() || null,
      });
      toast({ body: editing ? t("common.savedToast") : t("common.createdToast"), type: "info" });
      setShowForm(false);
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
      await api("DELETE", `/api/machines/${encodeURIComponent(deleteTarget.name)}`);
      toast({ body: t("common.deletedToast"), type: "info" });
      setDeleteTarget(null);
      await load();
    } catch (err) {
      toast({ body: `${t("common.deleteFailed")}: ${(err as Error).message}`, type: "error" });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <VStack gap={4}>
      <HStack hAlign="between" vAlign="center">
        <Heading level={3}>{t("machines.title")}</Heading>
        <HStack gap={2}>
          <Button label={t("common.refresh")} variant="secondary" onClick={load} />
          <Button label={t("machines.newMachine")} variant="primary" onClick={openNew} />
        </HStack>
      </HStack>
      {machines === null ? (
        <Text color="secondary">{t("machines.probing")}</Text>
      ) : machines.length === 0 ? (
        <EmptyState title={t("machines.empty")} description={t("machines.emptyDesc")} />
      ) : (
        <Grid columns={{ minWidth: 300, repeat: "fit" }} gap={4}>
          {machines.map((m) => (
            <Card key={m.name} className="glass-card">
              <VStack gap={3}>
                <HStack hAlign="between" vAlign="center">
                  <Heading level={4}>{m.name}</Heading>
                  <HStack gap={1}>
                    <Button label={t("common.edit")} variant="ghost" size="sm" onClick={() => openEdit(m)} />
                    <Button label={t("common.delete")} variant="ghost" size="sm" onClick={() => setDeleteTarget(m)} />
                  </HStack>
                </HStack>
                <Text type="supporting" color="secondary">{m.host}</Text>

                {m.lmstudio.online ? (
                  <span className="rx-live-pill">
                    <span className="rx-live-dot" />
                    LM Studio — {m.lmstudio.models.length} {t("machines.models")}
                  </span>
                ) : (
                  <HStack gap={2} vAlign="center">
                    <StatusDot variant="neutral" label="LM Studio" />
                    <Text type="supporting">LM Studio: {t("machines.lmstudioOffline")}</Text>
                  </HStack>
                )}
                {m.lmstudio.models.map((model) => (
                  <Text key={model} type="supporting" color="secondary">  {model}</Text>
                ))}

                {m.ollama?.online ? (
                  <span className="rx-live-pill">
                    <span className="rx-live-dot" />
                    Ollama — {m.ollama.models.length} {t("machines.models")}
                  </span>
                ) : (
                  <HStack gap={2} vAlign="center">
                    <StatusDot variant="neutral" label="Ollama" />
                    <Text type="supporting">Ollama: {t("machines.lmstudioOffline")}</Text>
                  </HStack>
                )}
                {(m.ollama?.models ?? []).map((model) => (
                  <Text key={model} type="supporting" color="secondary">  {model}</Text>
                ))}

                {m.comfyui.online ? (
                  <span className="rx-live-pill">
                    <span className="rx-live-dot" />
                    ComfyUI — {t("machines.lmstudioOnline")}
                  </span>
                ) : (
                  <HStack gap={2} vAlign="center">
                    <StatusDot variant="neutral" label="ComfyUI" />
                    <Text type="supporting">ComfyUI: {t("machines.lmstudioOffline")}</Text>
                  </HStack>
                )}
                {m.notes && <Text type="supporting" color="secondary">{m.notes}</Text>}
              </VStack>
            </Card>
          ))}
        </Grid>
      )}

      <Dialog isOpen={showForm} onOpenChange={setShowForm} purpose="form" width={480}>
        <DialogHeader title={editing ? editing.name : t("machines.newDialogTitle")} />
        <VStack gap={3} paddingInline={5} paddingBlock={4}>
          <TextInput label={t("machines.name")} value={name} onChange={setName} isRequired isDisabled={!!editing} />
          <TextInput label={t("machines.host")} value={host} onChange={setHost} isRequired placeholder="192.168.1.10" />
          <HStack gap={3}>
            <TextInput label={t("machines.lmstudioPort")} value={lmstudioPort} onChange={setLmstudioPort} isOptional placeholder="1234" />
            <TextInput label={t("machines.ollamaPort")} value={ollamaPort} onChange={setOllamaPort} isOptional placeholder="11434" />
            <TextInput label={t("machines.comfyuiPort")} value={comfyuiPort} onChange={setComfyuiPort} isOptional placeholder="8188" />
          </HStack>
          <TextArea label={t("machines.notes")} value={notes} onChange={setNotes} rows={3} isOptional />
          <HStack gap={2}>
            <Button label={saving ? t("common.saving") : t("common.save")} variant="primary" onClick={save} isDisabled={saving || !name.trim() || !host.trim()} />
            <Button label={t("common.cancel")} variant="secondary" onClick={() => setShowForm(false)} />
          </HStack>
        </VStack>
      </Dialog>

      <AlertDialog
        isOpen={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t("common.confirmDeleteTitle")}
        description={`"${deleteTarget?.name}" ${t("machines.confirmDeleteDesc")}`}
        actionLabel={t("machines.deleteAction")}
        cancelLabel={t("common.cancel")}
        actionVariant="destructive"
        isActionLoading={deleting}
        onAction={confirmDelete}
      />
    </VStack>
  );
}
