import { useEffect, useState } from "react";
import { VStack, HStack } from "@astryxdesign/core/Layout";
import { Grid } from "@astryxdesign/core/Grid";
import { Card } from "@astryxdesign/core/Card";
import { Button } from "@astryxdesign/core/Button";
import { Text, Heading } from "@astryxdesign/core/Text";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { api, type MachineStatus } from "../api";

export function Machines() {
  const [machines, setMachines] = useState<MachineStatus[] | null>(null);

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

  return (
    <VStack gap={4}>
      <HStack hAlign="between" vAlign="center">
        <Heading level={3}>Makineler</Heading>
        <Button label="Yenile" variant="secondary" onClick={load} />
      </HStack>
      {machines === null ? (
        <Text color="secondary">Servisler yoklanıyor...</Text>
      ) : machines.length === 0 ? (
        <EmptyState title="Kayıtlı makine yok" description="Agentlar machine_register ile ekler." />
      ) : (
        <Grid columns={{ minWidth: 300, repeat: "fit" }} gap={4}>
          {machines.map((m) => (
            <Card key={m.name}>
              <VStack gap={3}>
                <Heading level={4}>{m.name}</Heading>
                <Text type="supporting" color="secondary">{m.host}</Text>
                <HStack gap={2} vAlign="center">
                  <StatusDot variant={m.lmstudio.online ? "success" : "neutral"} label="LM Studio" />
                  <Text type="supporting">
                    LM Studio: {m.lmstudio.online ? `açık — ${m.lmstudio.models.length} model` : "kapalı"}
                  </Text>
                </HStack>
                {m.lmstudio.models.map((model) => (
                  <Text key={model} type="supporting" color="secondary">  {model}</Text>
                ))}
                <HStack gap={2} vAlign="center">
                  <StatusDot variant={m.comfyui.online ? "success" : "neutral"} label="ComfyUI" />
                  <Text type="supporting">ComfyUI: {m.comfyui.online ? "açık" : "kapalı"}</Text>
                </HStack>
              </VStack>
            </Card>
          ))}
        </Grid>
      )}
    </VStack>
  );
}
