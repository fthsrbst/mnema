import { useCallback, useEffect, useState } from "react";
import { VStack, HStack } from "@astryxdesign/core/Layout";
import { Card } from "@astryxdesign/core/Card";
import { Button } from "@astryxdesign/core/Button";
import { Text, Heading } from "@astryxdesign/core/Text";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { useToast } from "@astryxdesign/core/Toast";
import { api, type SessionLog } from "../api";
import { useI18n } from "../i18n";
import { Markdown } from "../components/Markdown";

export function Sessions() {
  const { t } = useI18n();
  const toast = useToast();
  const [logs, setLogs] = useState<SessionLog[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<SessionLog | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    api<SessionLog[]>("GET", "/api/sessions?limit=30").then(setLogs).catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api("DELETE", `/api/sessions/${deleteTarget.id}`);
      toast({ body: t("common.deletedToast"), type: "info" });
      setDeleteTarget(null);
      load();
    } catch (err) {
      toast({ body: `${t("common.deleteFailed")}: ${(err as Error).message}`, type: "error" });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <VStack gap={4}>
      <Heading level={3}>{t("sessions.title")}</Heading>
      {logs.length === 0 ? (
        <EmptyState title={t("sessions.empty")} description={t("sessions.emptyDesc")} />
      ) : (
        <Card className="glass-card">
          <VStack gap={0}>
            {logs.map((log, i) => {
              const caption = [log.project, log.source].filter(Boolean).join(" · ");
              return (
                <VStack
                  key={log.id}
                  gap={2}
                  paddingBlock={i > 0 ? 3 : undefined}
                  style={i > 0 ? { borderTop: "1px solid var(--color-border)" } : undefined}
                >
                  <HStack hAlign="between" vAlign="center">
                    <HStack gap={2} vAlign="center">
                      <Text type="supporting" color="secondary">{log.created_at}</Text>
                      {caption && <Text type="supporting" color="secondary">· {caption}</Text>}
                    </HStack>
                    <Button label={t("common.delete")} variant="ghost" size="sm" onClick={() => setDeleteTarget(log)} />
                  </HStack>
                  <Markdown>{log.summary}</Markdown>
                </VStack>
              );
            })}
          </VStack>
        </Card>
      )}

      <AlertDialog
        isOpen={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t("common.confirmDeleteTitle")}
        description={t("sessions.confirmDeleteDesc")}
        actionLabel={t("sessions.deleteAction")}
        cancelLabel={t("common.cancel")}
        actionVariant="destructive"
        isActionLoading={deleting}
        onAction={confirmDelete}
      />
    </VStack>
  );
}
