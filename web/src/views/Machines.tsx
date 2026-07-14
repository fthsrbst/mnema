import { useEffect, useState } from "react";
import { VStack, HStack, Grid } from "../components/ui/Stack";
import { Panel } from "../components/ui/Panel";
import { Button } from "../components/ui/Button";
import { TextField, TextArea } from "../components/ui/Field";
import { Heading, Text } from "../components/ui/Typography";
import { StatusDot, LivePill } from "../components/ui/Tag";
import { EmptyState } from "../components/ui/EmptyState";
import { AlertDialog, Dialog } from "../components/ui/Dialog";
import { useToast } from "../components/ui/useToast";
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
        <Grid minWidth={280} gap={4}>
          {machines.map((m) => (
            <Panel key={m.name}>
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
                  <LivePill>LM Studio — {m.lmstudio.models.length} {t("machines.models")}</LivePill>
                ) : (
                  <StatusDot variant="neutral" label={`LM Studio: ${t("machines.lmstudioOffline")}`} />
                )}
                {m.lmstudio.models.map((model) => (
                  <Text key={model} type="supporting" color="secondary">{"  " + model}</Text>
                ))}

                {m.ollama?.online ? (
                  <LivePill>Ollama — {m.ollama.models.length} {t("machines.models")}</LivePill>
                ) : (
                  <StatusDot variant="neutral" label={`Ollama: ${t("machines.lmstudioOffline")}`} />
                )}
                {(m.ollama?.models ?? []).map((model) => (
                  <Text key={model} type="supporting" color="secondary">{"  " + model}</Text>
                ))}

                {m.comfyui.online ? (
                  <LivePill>ComfyUI — {t("machines.lmstudioOnline")}</LivePill>
                ) : (
                  <StatusDot variant="neutral" label={`ComfyUI: ${t("machines.lmstudioOffline")}`} />
                )}
                {m.notes && <Text type="supporting" color="secondary">{m.notes}</Text>}
              </VStack>
            </Panel>
          ))}
        </Grid>
      )}

      <Dialog isOpen={showForm} onOpenChange={setShowForm} width={480} title={editing ? editing.name : t("machines.newDialogTitle")}>
        <TextField label={t("machines.name")} value={name} onChange={setName} disabled={!!editing} />
        <TextField label={t("machines.host")} value={host} onChange={setHost} placeholder="192.168.1.10" />
        <HStack gap={3}>
          <TextField label={t("machines.lmstudioPort")} value={lmstudioPort} onChange={setLmstudioPort} optional placeholder="1234" />
          <TextField label={t("machines.ollamaPort")} value={ollamaPort} onChange={setOllamaPort} optional placeholder="11434" />
          <TextField label={t("machines.comfyuiPort")} value={comfyuiPort} onChange={setComfyuiPort} optional placeholder="8188" />
        </HStack>
        <TextArea label={t("machines.notes")} value={notes} onChange={setNotes} rows={3} optional />
        <HStack gap={2}>
          <Button label={saving ? t("common.saving") : t("common.save")} variant="primary" onClick={save} disabled={saving || !name.trim() || !host.trim()} />
          <Button label={t("common.cancel")} variant="secondary" onClick={() => setShowForm(false)} />
        </HStack>
      </Dialog>

      <AlertDialog
        isOpen={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t("common.confirmDeleteTitle")}
        description={`"${deleteTarget?.name}" ${t("machines.confirmDeleteDesc")}`}
        actionLabel={t("machines.deleteAction")}
        cancelLabel={t("common.cancel")}
        loading={deleting}
        onAction={confirmDelete}
      />
    </VStack>
  );
}
