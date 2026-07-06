import { useEffect, useState } from "react";
import { VStack, HStack } from "@astryxdesign/core/Layout";
import { Card } from "@astryxdesign/core/Card";
import { Button } from "@astryxdesign/core/Button";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Text, Heading } from "@astryxdesign/core/Text";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { api, type Skill } from "../api";

export function Skills() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selected, setSelected] = useState<Skill | null>(null);
  const [content, setContent] = useState("");
  const [message, setMessage] = useState("");

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
    const res = await api<{ note: string }>("PUT", `/api/skills/${selected.name}`, { content });
    setMessage(res.note);
    await load();
  };

  if (selected) {
    return (
      <VStack gap={4}>
        <HStack gap={3} vAlign="center" hAlign="between">
          <HStack gap={3} vAlign="center">
            <Button label="← Geri" variant="secondary" onClick={() => { setSelected(null); setMessage(""); }} />
            <Heading level={3}>{selected.name}</Heading>
          </HStack>
          <Button label="Kaydet" variant="primary" onClick={save} />
        </HStack>
        {message && <Text type="supporting" color="secondary">{message}</Text>}
        <TextArea label="SKILL.md" isLabelHidden value={content} onChange={setContent} rows={28} hasSpellCheck={false} />
      </VStack>
    );
  }

  return (
    <VStack gap={4}>
      <Heading level={3}>Skiller</Heading>
      <Text type="supporting" color="secondary">
        Kaynak: repo/skills — düzenledikten sonra kalıcılık için git commit + push ve her cihazda `hub sync` gerekir.
      </Text>
      {skills.length === 0 ? (
        <EmptyState title="Skill bulunamadı" description="Sunucu repo kökünden çalışmıyor olabilir (skills/ klasörü görünmüyor)." />
      ) : (
        skills.map((s) => (
          <Card key={s.name}>
            <HStack hAlign="between" vAlign="center">
              <VStack gap={1}>
                <Heading level={4}>{s.name}</Heading>
                <Text type="supporting" color="secondary">{s.description}</Text>
              </VStack>
              <Button label="Düzenle" variant="secondary" size="sm" onClick={() => { setSelected(s); setContent(s.content); setMessage(""); }} />
            </HStack>
          </Card>
        ))
      )}
    </VStack>
  );
}
