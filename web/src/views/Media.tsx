import { useEffect, useState } from "react";
import { VStack, HStack, Grid } from "../components/ui/Stack";
import { Panel } from "../components/ui/Panel";
import { Button } from "../components/ui/Button";
import { TextArea } from "../components/ui/Field";
import { Heading, Text } from "../components/ui/Typography";
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
      const res = await api<{ files: string[] }>("POST", "/api/media", { workflow, inputs: { prompt }, timeoutSec: 600 });
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
      <Panel>
        <VStack gap={3}>
          <HStack gap={2} wrap="wrap">
            {workflows.map((w) => (
              <Button key={w} label={w} size="sm" variant={w === workflow ? "primary" : "secondary"} onClick={() => setWorkflow(w)} />
            ))}
          </HStack>
          <TextArea label={t("media.promptLabel")} value={prompt} onChange={setPrompt} rows={3} placeholder={t("media.placeholder")} />
          <HStack gap={3} vAlign="center">
            <Button label={busy ? t("media.generating") : t("media.generate")} variant="primary" onClick={generate} disabled={busy || !prompt.trim()} />
            {message && <Text type="supporting" color="secondary">{message}</Text>}
          </HStack>
        </VStack>
      </Panel>
      <Heading level={4}>{t("media.outputs")}</Heading>
      <Grid minWidth={220} gap={4}>
        {outputs.map((f) => (
          <Panel key={f.name} padded={false} style={{ padding: 8 }}>
            <VStack gap={2}>
              {isImage(f.name) ? (
                <a href={assetUrl(f.url)} target="_blank" rel="noreferrer">
                  <img src={assetUrl(f.url)} alt={f.name} style={{ width: "100%", display: "block" }} />
                </a>
              ) : isVideo(f.name) ? (
                <video src={assetUrl(f.url)} controls style={{ width: "100%" }} />
              ) : isAudio(f.name) ? (
                <audio src={assetUrl(f.url)} controls style={{ width: "100%" }} />
              ) : (
                <a href={assetUrl(f.url)}>{f.name}</a>
              )}
              <Text type="supporting" color="secondary">{f.name}</Text>
            </VStack>
          </Panel>
        ))}
      </Grid>
    </VStack>
  );
}
