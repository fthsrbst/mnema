import { useEffect, useState } from "react";
import { VStack, HStack } from "@astryxdesign/core/Layout";
import { Grid } from "@astryxdesign/core/Grid";
import { Card } from "@astryxdesign/core/Card";
import { Button } from "@astryxdesign/core/Button";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Text, Heading } from "@astryxdesign/core/Text";
import { api, type OutputFile } from "../api";

const isImage = (name: string) => /\.(png|jpe?g|webp|gif)$/i.test(name);
const isVideo = (name: string) => /\.(mp4|webm)$/i.test(name);
const isAudio = (name: string) => /\.(mp3|wav|flac|ogg)$/i.test(name);

export function Media() {
  const [workflows, setWorkflows] = useState<string[]>([]);
  const [outputs, setOutputs] = useState<OutputFile[]>([]);
  const [workflow, setWorkflow] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const load = async () => {
    api<string[]>("GET", "/api/workflows").then((w) => {
      setWorkflows(w);
      if (w.length && !workflow) setWorkflow(w[0]);
    }).catch(() => {});
    api<OutputFile[]>("GET", "/api/outputs").then(setOutputs).catch(() => {});
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const generate = async () => {
    setBusy(true);
    setMessage("Üretiliyor... (model ilk yüklemede dakikalar sürebilir)");
    try {
      const res = await api<{ files: string[] }>("POST", "/api/media", {
        workflow,
        inputs: { prompt },
        timeoutSec: 600,
      });
      setMessage(`Tamamlandı: ${res.files.length} dosya`);
      await load();
    } catch (err) {
      setMessage(`Hata: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <VStack gap={4}>
      <Heading level={3}>Medya Üretimi</Heading>
      <Card>
        <VStack gap={3}>
          <HStack gap={2} wrap="wrap">
            {workflows.map((w) => (
              <Button
                key={w}
                label={w}
                size="sm"
                variant={w === workflow ? "primary" : "secondary"}
                onClick={() => setWorkflow(w)}
              />
            ))}
          </HStack>
          <TextArea
            label="Prompt (İngilizce daha iyi sonuç verir)"
            value={prompt}
            onChange={setPrompt}
            rows={3}
            placeholder="a minimal flat illustration of ..."
          />
          <HStack gap={3} vAlign="center">
            <Button label={busy ? "Üretiliyor..." : "Üret"} variant="primary" onClick={generate} isDisabled={busy || !prompt.trim()} />
            {message && <Text type="supporting" color="secondary">{message}</Text>}
          </HStack>
        </VStack>
      </Card>
      <Heading level={4}>Çıktılar</Heading>
      <Grid columns={{ minWidth: 240, repeat: "fit" }} gap={4}>
        {outputs.map((f) => (
          <Card key={f.name} padding={2}>
            <VStack gap={2}>
              {isImage(f.name) ? (
                <a href={f.url} target="_blank" rel="noreferrer">
                  <img src={f.url} alt={f.name} style={{ width: "100%", borderRadius: "var(--radius-md, 8px)" }} />
                </a>
              ) : isVideo(f.name) ? (
                <video src={f.url} controls style={{ width: "100%", borderRadius: "var(--radius-md, 8px)" }} />
              ) : isAudio(f.name) ? (
                <audio src={f.url} controls style={{ width: "100%" }} />
              ) : (
                <a href={f.url}>{f.name}</a>
              )}
              <Text type="supporting" color="secondary">{f.name}</Text>
            </VStack>
          </Card>
        ))}
      </Grid>
    </VStack>
  );
}
