import { useEffect, useState } from "react";
import { VStack, HStack, Grid } from "../components/ui/Stack";
import { Panel } from "../components/ui/Panel";
import { Button } from "../components/ui/Button";
import { TextField, TextArea, Select, Switch } from "../components/ui/Field";
import { Heading, Text } from "../components/ui/Typography";
import { Tag, StatusDot } from "../components/ui/Tag";
import { EmptyState } from "../components/ui/EmptyState";
import { AlertDialog, Dialog } from "../components/ui/Dialog";
import { useToast } from "../components/ui/useToast";
import { deleteMcpServer, fetchMcpServers, saveMcpServer, type McpServer, type McpTransport } from "../api";
import { useI18n } from "../i18n";

/** "KEY=VALUE" satırlarını objeye çevirir; bozuk satırları döner. */
function parseKeyValueLines(text: string): { map: Record<string, string>; bad: string[] } {
  const map: Record<string, string> = {};
  const bad: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      bad.push(line);
      continue;
    }
    map[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return { map, bad };
}

function keyValueToText(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

export function McpServers() {
  const { t } = useI18n();
  const toast = useToast();
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<McpServer | null>(null);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<McpTransport>("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [scope, setScope] = useState("");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<McpServer | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = async () => {
    setServers(null);
    try {
      setServers(await fetchMcpServers());
    } catch {
      setServers([]);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const openNew = () => {
    setEditing(null);
    setName("");
    setTransport("http");
    setUrl("");
    setCommand("");
    setArgsText("");
    setEnvText("");
    setHeadersText("");
    setScope("");
    setDescription("");
    setEnabled(true);
    setShowForm(true);
  };

  const openEdit = (s: McpServer) => {
    setEditing(s);
    setName(s.name);
    setTransport(s.transport);
    setUrl(s.url ?? "");
    setCommand(s.command ?? "");
    setArgsText(s.args.join("\n"));
    setEnvText(keyValueToText(s.env));
    setHeadersText(keyValueToText(s.headers));
    setScope(s.scope ?? "");
    setDescription(s.description ?? "");
    setEnabled(s.enabled);
    setShowForm(true);
  };

  const save = async () => {
    if (!name.trim()) return;
    const envParsed = parseKeyValueLines(envText);
    const headersParsed = parseKeyValueLines(headersText);
    if (envParsed.bad.length > 0 || headersParsed.bad.length > 0) {
      toast({ body: `${t("mcpServers.badLine")} ${[...envParsed.bad, ...headersParsed.bad].join(", ")}`, type: "error" });
      return;
    }
    setSaving(true);
    try {
      await saveMcpServer(name.trim(), {
        transport,
        url: transport === "http" ? url.trim() || null : null,
        command: transport === "stdio" ? command.trim() || null : null,
        args: transport === "stdio" ? argsText.split("\n").map((a) => a.trim()).filter(Boolean) : [],
        env: envParsed.map,
        headers: headersParsed.map,
        scope: scope.trim() || null,
        description: description.trim() || null,
        enabled,
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

  const toggleEnabled = async (s: McpServer, next: boolean) => {
    try {
      await saveMcpServer(s.name, { enabled: next });
      await load();
    } catch (err) {
      toast({ body: `${t("common.saveFailed")}: ${(err as Error).message}`, type: "error" });
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteMcpServer(deleteTarget.name);
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
        <Heading level={3}>{t("mcpServers.title")}</Heading>
        <HStack gap={2}>
          <Button label={t("common.refresh")} variant="secondary" onClick={load} />
          <Button label={t("mcpServers.newServer")} variant="primary" onClick={openNew} />
        </HStack>
      </HStack>
      <Text type="supporting" color="secondary">
        {t("mcpServers.syncNote")} — {t("mcpServers.secretWarn")}
      </Text>
      {servers === null ? (
        <Text color="secondary">{t("common.loading")}</Text>
      ) : servers.length === 0 ? (
        <EmptyState title={t("mcpServers.empty")} description={t("mcpServers.emptyDesc")} />
      ) : (
        <Grid minWidth={300} gap={4}>
          {servers.map((s) => (
            <Panel key={s.name}>
              <VStack gap={3}>
                <HStack hAlign="between" vAlign="center">
                  <Heading level={4}>{s.name}</Heading>
                  <HStack gap={1}>
                    <Button label={t("common.edit")} variant="ghost" size="sm" onClick={() => openEdit(s)} />
                    <Button label={t("common.delete")} variant="ghost" size="sm" onClick={() => setDeleteTarget(s)} />
                  </HStack>
                </HStack>
                <HStack gap={2} vAlign="center">
                  <Tag variant={s.transport === "http" ? "accent" : "default"}>{s.transport}</Tag>
                  {s.scope && <Tag>{s.scope}</Tag>}
                  <StatusDot
                    variant={s.enabled ? "success" : "neutral"}
                    label={s.enabled ? t("mcpServers.enabled") : "—"}
                  />
                </HStack>
                <Text type="supporting">
                  {s.transport === "http" ? s.url : [s.command, ...(s.args ?? [])].filter(Boolean).join(" ")}
                </Text>
                {s.description && <Text type="supporting" color="secondary">{s.description}</Text>}
                {(Object.keys(s.env ?? {}).length > 0 || Object.keys(s.headers ?? {}).length > 0) && (
                  <Text type="supporting" color="secondary">
                    {Object.keys(s.env ?? {}).length > 0 && `env: ${Object.keys(s.env).join(", ")} `}
                    {Object.keys(s.headers ?? {}).length > 0 && `headers: ${Object.keys(s.headers).join(", ")}`}
                  </Text>
                )}
                <Switch checked={s.enabled} onChange={(next) => toggleEnabled(s, next)} label={t("mcpServers.enabled")} />
              </VStack>
            </Panel>
          ))}
        </Grid>
      )}

      <Dialog isOpen={showForm} onOpenChange={setShowForm} width={520} title={editing ? editing.name : t("mcpServers.newDialogTitle")}>
        <TextField label={t("mcpServers.name")} value={name} onChange={setName} disabled={!!editing} placeholder="context7" />
        <Select
          label={t("mcpServers.transport")}
          value={transport}
          onChange={(v) => setTransport(v as McpTransport)}
          options={[
            { value: "http", label: t("mcpServers.transportHttp") },
            { value: "stdio", label: t("mcpServers.transportStdio") },
          ]}
        />
        {transport === "http" ? (
          <TextField label={t("mcpServers.url")} value={url} onChange={setUrl} placeholder="https://mcp.example.com/mcp" />
        ) : (
          <>
            <TextField label={t("mcpServers.command")} value={command} onChange={setCommand} placeholder="npx -y @some/mcp-server" />
            <TextArea label={t("mcpServers.args")} value={argsText} onChange={setArgsText} rows={3} optional />
          </>
        )}
        <TextArea label={t("mcpServers.env")} value={envText} onChange={setEnvText} rows={3} optional placeholder={"CONTEXT7_API_KEY=${CONTEXT7_API_KEY}"} />
        <TextArea label={t("mcpServers.headers")} value={headersText} onChange={setHeadersText} rows={3} optional />
        <HStack gap={3}>
          <TextField label={t("mcpServers.scope")} value={scope} onChange={setScope} optional placeholder="mnema" />
          <TextField label={t("mcpServers.description")} value={description} onChange={setDescription} optional />
        </HStack>
        <Switch checked={enabled} onChange={setEnabled} label={t("mcpServers.enabled")} />
        <HStack gap={2}>
          <Button
            label={saving ? t("common.saving") : t("common.save")}
            variant="primary"
            onClick={save}
            disabled={saving || !name.trim() || (transport === "http" ? !url.trim() : !command.trim())}
          />
          <Button label={t("common.cancel")} variant="secondary" onClick={() => setShowForm(false)} />
        </HStack>
      </Dialog>

      <AlertDialog
        isOpen={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t("common.confirmDeleteTitle")}
        description={`"${deleteTarget?.name}" ${t("mcpServers.confirmDeleteDesc")}`}
        actionLabel={t("mcpServers.deleteAction")}
        cancelLabel={t("common.cancel")}
        loading={deleting}
        onAction={confirmDelete}
      />
    </VStack>
  );
}
