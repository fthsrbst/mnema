import { useEffect, useState } from "react";
import { api, type ProfessionalProfileBundle } from "../api";
import { Markdown } from "../components/Markdown";
import { Button } from "../components/ui/Button";
import { TextArea } from "../components/ui/Field";
import { Panel } from "../components/ui/Panel";
import { HStack, VStack } from "../components/ui/Stack";
import { Tag } from "../components/ui/Tag";
import { Heading, Text } from "../components/ui/Typography";
import { useI18n } from "../i18n";
import { useToast } from "../components/ui/useToast";

export function ProfessionalProfile() {
  const { t } = useI18n();
  const toast = useToast();
  const [bundle, setBundle] = useState<ProfessionalProfileBundle | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    setError("");
    try {
      const profile = await api<ProfessionalProfileBundle>("GET", "/api/profile");
      setBundle(profile);
      setMarkdown(profile.canonical?.markdown ?? "");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    if (markdown.trim().length < 100) return;
    setSaving(true);
    try {
      const profile = await api<ProfessionalProfileBundle>("PUT", "/api/profile", {
        markdown,
        title: "Canonical Professional Profile",
        source: "professional-profile-ui",
        language: "en",
      });
      setBundle(profile);
      setMarkdown(profile.canonical?.markdown ?? markdown);
      setEditing(false);
      toast({ body: t("common.savedToast"), type: "info" });
    } catch (err) {
      toast({ body: `${t("common.saveFailed")}: ${(err as Error).message}`, type: "error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <VStack gap={4}>
      <HStack hAlign="between" vAlign="center">
        <VStack gap={1}>
          <Heading level={3}>{t("profile.title")}</Heading>
          <Text type="supporting" color="secondary">{t("profile.description")}</Text>
        </VStack>
        {!editing && bundle?.canonical && (
          <Button label={t("common.edit")} variant="primary" onClick={() => setEditing(true)} />
        )}
      </HStack>

      {error && <Text color="secondary">{t("common.error")}: {error}</Text>}

      <Panel>
        <VStack gap={3}>
          <HStack gap={2} vAlign="center">
            <Tag variant="accent">MANISA</Tag>
            <Tag variant="accent">GPA 3.25</Tag>
            <Tag variant="accent">VITRIOL · 2026-06-16</Tag>
          </HStack>
          {editing || !bundle?.canonical ? (
            <>
              <TextArea
                label={t("profile.canonicalMarkdown")}
                value={markdown}
                onChange={setMarkdown}
                rows={28}
                spellCheck={false}
              />
              <HStack gap={2}>
                <Button
                  label={saving ? t("common.saving") : t("common.save")}
                  variant="primary"
                  onClick={save}
                  disabled={saving || markdown.trim().length < 100}
                />
                {bundle?.canonical && (
                  <Button
                    label={t("common.cancel")}
                    variant="secondary"
                    onClick={() => {
                      setMarkdown(bundle.canonical?.markdown ?? "");
                      setEditing(false);
                    }}
                  />
                )}
              </HStack>
            </>
          ) : (
            <Markdown headingLevelStart={3}>{bundle.canonical.markdown}</Markdown>
          )}
        </VStack>
      </Panel>

      <Panel>
        <VStack gap={3}>
          <Heading level={4}>{t("profile.sources")}</Heading>
          {bundle?.sources.length ? (
            bundle.sources.map((source) => (
              <HStack key={source.uid} hAlign="between" vAlign="center">
                <VStack gap={1}>
                  <Text>{source.title}</Text>
                  <Text type="supporting" color="secondary">{source.uri}</Text>
                </VStack>
                <Text type="supporting" color="secondary">{source.language ?? "—"}</Text>
              </HStack>
            ))
          ) : (
            <Text type="supporting" color="secondary">{t("profile.noSources")}</Text>
          )}
        </VStack>
      </Panel>
    </VStack>
  );
}
