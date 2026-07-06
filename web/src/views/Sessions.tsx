import { useEffect, useState } from "react";
import { VStack, HStack } from "@astryxdesign/core/Layout";
import { Card } from "@astryxdesign/core/Card";
import { Text, Heading } from "@astryxdesign/core/Text";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { api, type SessionLog } from "../api";

export function Sessions() {
  const [logs, setLogs] = useState<SessionLog[]>([]);

  useEffect(() => {
    api<SessionLog[]>("GET", "/api/sessions?limit=30").then(setLogs).catch(() => {});
  }, []);

  return (
    <VStack gap={4}>
      <Heading level={3}>Oturum Geçmişi</Heading>
      {logs.length === 0 ? (
        <EmptyState title="Oturum kaydı yok" description="Agentlar oturum sonunda session_log ile özet bırakır." />
      ) : (
        logs.map((log) => (
          <Card key={log.id}>
            <VStack gap={2}>
              <HStack gap={3} vAlign="center">
                <Text type="supporting" color="secondary">{log.created_at}</Text>
                {log.project && <Text type="supporting">[{log.project}]</Text>}
                {log.source && <Text type="supporting" color="secondary">{log.source}</Text>}
              </HStack>
              <Text style={{ whiteSpace: "pre-wrap" }}>{log.summary}</Text>
            </VStack>
          </Card>
        ))
      )}
    </VStack>
  );
}
