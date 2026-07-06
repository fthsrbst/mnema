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
import { api, type ProjectMap } from "../api";

const statusVariant = (s?: string) =>
  s === "active" ? "success" : s === "paused" ? "warning" : s === "done" ? "neutral" : "accent";

export function Projects() {
  const [projects, setProjects] = useState<ProjectMap[]>([]);
  const [selected, setSelected] = useState<ProjectMap | null>(null);
  const [focus, setFocus] = useState("");
  const [nextSteps, setNextSteps] = useState("");
  const [error, setError] = useState("");

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
    setFocus(p.current_focus ?? "");
    setNextSteps((p.next_steps ?? []).join("\n"));
  };

  const save = async () => {
    if (!selected) return;
    await api("PUT", `/api/projects/${encodeURIComponent(selected.name)}`, {
      current_focus: focus,
      next_steps: nextSteps.split("\n").map((s) => s.trim()).filter(Boolean),
    });
    setSelected(null);
    await load();
  };

  if (selected) {
    return (
      <VStack gap={4}>
        <HStack gap={3} vAlign="center">
          <Button label="← Geri" variant="secondary" onClick={() => setSelected(null)} />
          <Heading level={3}>{selected.name}</Heading>
          <StatusDot variant={statusVariant(selected.status)} label={selected.status ?? "bilinmiyor"} />
          <Text color="secondary">{selected.status}</Text>
        </HStack>
        <Card>
          <VStack gap={3}>
            <Text>{selected.summary ?? "Özet yok"}</Text>
            {selected.stack && <Text color="secondary">Stack: {selected.stack.join(", ")}</Text>}
            {selected.repo && <Text color="secondary">Repo: {selected.repo}</Text>}
            <TextInput label="Mevcut odak" value={focus} onChange={setFocus} />
            <TextArea label="Sıradaki adımlar (satır başına bir)" value={nextSteps} onChange={setNextSteps} rows={5} />
            <HStack gap={2}>
              <Button label="Kaydet" variant="primary" onClick={save} />
            </HStack>
          </VStack>
        </Card>
        {(selected.decisions?.length ?? 0) > 0 && (
          <Card>
            <VStack gap={2}>
              <Heading level={4}>Karar geçmişi</Heading>
              {selected.decisions!.map((d, i) => (
                <Text key={i} type="supporting">• {d}</Text>
              ))}
            </VStack>
          </Card>
        )}
      </VStack>
    );
  }

  return (
    <VStack gap={4}>
      <Heading level={3}>Projeler</Heading>
      {error && <Text color="secondary">Hata: {error}</Text>}
      {projects.length === 0 ? (
        <EmptyState title="Kayıtlı proje yok" description="Agentlar project_update ile ekler; new-project skill'i otomatik oluşturur." />
      ) : (
        <Grid columns={{ minWidth: 300, repeat: "fit" }} gap={4}>
          {projects.map((p) => (
            <Card key={p.name}>
              <VStack gap={2}>
                <HStack gap={2} vAlign="center" hAlign="between">
                  <Heading level={4}>{p.name}</Heading>
                  <StatusDot variant={statusVariant(p.status)} label={p.status ?? "bilinmiyor"} />
                </HStack>
                <Text type="supporting" color="secondary">{p.summary ?? ""}</Text>
                {p.current_focus && <Text type="supporting">Odak: {p.current_focus}</Text>}
                <HStack>
                  <Button label="Aç" variant="secondary" size="sm" onClick={() => open(p)} />
                </HStack>
              </VStack>
            </Card>
          ))}
        </Grid>
      )}
    </VStack>
  );
}
