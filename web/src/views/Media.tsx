import { useEffect, useState } from "react";
import { VStack, HStack } from "@astryxdesign/core/Layout";
import { Grid } from "@astryxdesign/core/Grid";
import { Card } from "@astryxdesign/core/Card";
import { Button } from "@astryxdesign/core/Button";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Text, Heading } from "@astryxdesign/core/Text";
import { api, assetUrl, type OutputFile } from "../api";
import { useI18n } from "../i18n";

const isImage = (name: string) => /\.(png|jpe?g|webp|gif)$/i.test(name);
const isVideo = (name: string) => /\.(mp4|webm)$/i.test(name);
const isAudio = (name: string) => /\.(mp3|wav|flac|ogg)$/i.test(name);

export function Media() {
  const { t } = useI18n();
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
    setMessage(t("media.generatingNote"));
    try {
      const res = await api<{ files: string[] }>("POST", "/api/media", {
        workflow,
        inputs: { prompt },
        timeoutSec: 600,
      });
      setMessage(`${t("media.done")}: ${res.files.length}`);
      await load();
    } catch (err) {
      setMessage(`${t("media.error")}: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <VStack gap={4}>
      <Heading level={3}>{t("media.title")}</Heading>
      <Card className="glass-card">
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
            label={t("media.promptLabel")}
            value={prompt}
            onChange={setPrompt}
            rows={3}
            placeholder={t("media.placeholder")}
          />
          <HStack gap={3} vAlign="center">
            <Button label={busy ? t("media.generating") : t("media.generate")} variant="primary" onClick={generate} isDisabled={busy || !prompt.trim()} />
            {message && <Text type="supporting" color="secondary">{message}</Text>}
          </HStack>
        </VStack>
      </Card>
      <Heading level={4}>{t("media.outputs")}</Heading>
      <Grid columns={{ minWidth: 240, repeat: "fit" }} gap={4}>
        {outputs.map((f) => (
          <Card key={f.name} padding={2} className="glass-card">
            <VStack gap={2}>
              {isImage(f.name) ? (
                <a href={assetUrl(f.url)} target="_blank" rel="noreferrer">
                  <img src={assetUrl(f.url)} alt={f.name} style={{ width: "100%", borderRadius: "var(--radius-inner)" }} />
                </a>
              ) : isVideo(f.name) ? (
                <video src={assetUrl(f.url)} controls style={{ width: "100%", borderRadius: "var(--radius-inner)" }} />
              ) : isAudio(f.name) ? (
                <audio src={assetUrl(f.url)} controls style={{ width: "100%" }} />
              ) : (
                <a href={assetUrl(f.url)}>{f.name}</a>
              )}
              <Text type="supporting" color="secondary">{f.name}</Text>
            </VStack>
          </Card>
        ))}
      </Grid>
    </VStack>
  );
}
