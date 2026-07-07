import { useCallback, useEffect, useState } from "react";
import { VStack, HStack } from "@astryxdesign/core/Layout";
import { Grid } from "@astryxdesign/core/Grid";
import { Card } from "@astryxdesign/core/Card";
import { Button } from "@astryxdesign/core/Button";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Text, Heading } from "@astryxdesign/core/Text";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Banner } from "@astryxdesign/core/Banner";
import { TabList, Tab } from "@astryxdesign/core/TabList";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Badge } from "@astryxdesign/core/Badge";
import { useToast } from "@astryxdesign/core/Toast";
import { api, type PromptList } from "../api";

type EditorTab = "edit" | "preview" | "composed";

export function Prompts() {
  const toast = useToast();
  const [list, setList] = useState<PromptList | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [raw, setRaw] = useState("");
  const [draft, setDraft] = useState("");
  const [composed, setComposed] = useState("");
  const [tab, setTab] = useState<EditorTab>("edit");
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setError("");
      setList(await api<PromptList>("GET", "/api/prompts"));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openPrompt = async (name: string) => {
    setSelected(name);
    setTab("edit");
    setLoadingDetail(true);
    try {
      const [rawRes, composedRes] = await Promise.all([
        api<{ name: string; content: string }>("GET", `/api/prompts/${name}?raw=1`),
        api<{ name: string; content: string }>("GET", `/api/prompts/${name}`),
      ]);
      setRaw(rawRes.content);
      setDraft(rawRes.content);
      setComposed(composedRes.content);
    } catch (err) {
      toast({ body: `Prompt yüklenemedi: ${(err as Error).message}`, type: "error" });
      setSelected(null);
    } finally {
      setLoadingDetail(false);
    }
  };

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await api("PUT", `/api/prompts/${selected}`, { content: draft });
      setRaw(draft);
      const composedRes = await api<{ name: string; content: string }>("GET", `/api/prompts/${selected}`);
      setComposed(composedRes.content);
      toast({ body: "Prompt kaydedildi. Kalıcı olması için git commit + push gerekir.", type: "info" });
    } catch (err) {
      toast({ body: `Kaydetme başarısız: ${(err as Error).message}`, type: "error" });
    } finally {
      setSaving(false);
    }
  };

  const isDirty = draft !== raw;
  const isMaster = selected === "master";

  if (selected) {
    return (
      <VStack gap={4}>
        <HStack hAlign="between" vAlign="center">
          <HStack gap={3} vAlign="center">
            <Button label="← Geri" variant="secondary" onClick={() => setSelected(null)} />
            <Heading level={3}>{selected}</Heading>
            {isMaster && <Badge variant="purple" label="Master" />}
          </HStack>
          <Button label={saving ? "Kaydediliyor..." : "Kaydet"} variant="primary" onClick={save} isDisabled={saving || !isDirty} />
        </HStack>

        {isMaster ? (
          <Banner
            status="info"
            title="Master prompt tüm rollere otomatik eklenir"
            description="Her rol prompt'unun başına bu içerik dahil edilir. Buradaki bir değişiklik tüm rolleri etkiler."
          />
        ) : (
          <Banner
            status="info"
            title="Bu rol prompt'u master ile otomatik birleştirilir"
            description={'"Birleşik önizleme" sekmesi agent\'ın gerçekte göreceği hali gösterir.'}
          />
        )}

        {loadingDetail ? (
          <Text color="secondary">Yükleniyor...</Text>
        ) : (
          <>
            <TabList value={tab} onChange={(v) => setTab(v as EditorTab)} hasDivider>
              <Tab value="edit" label="Düzenle" />
              <Tab value="preview" label="Önizleme" />
              {!isMaster && <Tab value="composed" label="Birleşik önizleme" />}
            </TabList>

            {tab === "edit" && (
              <TextArea
                label="İçerik (Markdown)"
                isLabelHidden
                value={draft}
                onChange={setDraft}
                rows={24}
                hasSpellCheck={false}
              />
            )}
            {tab === "preview" && (
              <Card>
                <Markdown headingLevelStart={4}>{draft || "*Boş*"}</Markdown>
              </Card>
            )}
            {tab === "composed" && !isMaster && (
              <Card>
                <Markdown headingLevelStart={4}>{composed || "*Boş*"}</Markdown>
              </Card>
            )}
          </>
        )}
      </VStack>
    );
  }

  return (
    <VStack gap={5}>
      <VStack gap={1}>
        <Heading level={3}>Prompt Kütüphanesi</Heading>
        <Text type="supporting" color="secondary">Master zihniyet çekirdeği + rol bazlı prompt'lar. Agentlar MCP üzerinden çeker.</Text>
      </VStack>

      <Banner
        status="info"
        title="Master prompt her rol prompt'una otomatik eklenir"
        description="Böylece tüm alt modeller aynı temel disiplinle çalışır. Kaydetme kalıcı olması için sunucuda git commit + push, diğer cihazlarda git pull gerektirir."
      />

      {error && <Text color="secondary">Hata: {error}</Text>}

      {list === null ? (
        <Text color="secondary">Yükleniyor...</Text>
      ) : (
        <VStack gap={4}>
          {list.master && (
            <VStack gap={2}>
              <Heading level={4}>Master</Heading>
              <Card>
                <HStack hAlign="between" vAlign="center">
                  <VStack gap={1}>
                    <HStack gap={2} vAlign="center">
                      <Text>{list.master.name}</Text>
                      <Badge variant="purple" label="Master" />
                    </HStack>
                    <Text type="supporting" color="secondary">{list.master.description || "Açıklama yok"}</Text>
                  </VStack>
                  <Button label="Aç" variant="secondary" size="sm" onClick={() => openPrompt("master")} />
                </HStack>
              </Card>
            </VStack>
          )}

          <VStack gap={2}>
            <Heading level={4}>Roller</Heading>
            {list.roles.length === 0 ? (
              <EmptyState title="Rol prompt'u yok" description="prompts/roles/ klasörüne .md dosyası ekleyerek yeni rol tanımlayabilirsin." />
            ) : (
              <Grid columns={{ minWidth: 280, repeat: "fit" }} gap={3}>
                {list.roles.map((r) => (
                  <Card key={r.name}>
                    <VStack gap={2}>
                      <Text>{r.name}</Text>
                      <Text type="supporting" color="secondary">{r.description || "Açıklama yok"}</Text>
                      <HStack>
                        <Button label="Aç" variant="secondary" size="sm" onClick={() => openPrompt(r.name)} />
                      </HStack>
                    </VStack>
                  </Card>
                ))}
              </Grid>
            )}
          </VStack>
        </VStack>
      )}
    </VStack>
  );
}
