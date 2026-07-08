import { useEffect, useState } from "react";
import { AppShell } from "@astryxdesign/core/AppShell";
import { SideNav, SideNavItem } from "@astryxdesign/core/SideNav";
import { VStack, HStack } from "@astryxdesign/core/Layout";
import { Center } from "@astryxdesign/core/Center";
import { Card } from "@astryxdesign/core/Card";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Text, Heading } from "@astryxdesign/core/Text";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { LayerProvider } from "@astryxdesign/core/Layer";
import {
  Squares2X2Icon,
  ServerStackIcon,
  CircleStackIcon,
  BookOpenIcon,
  AcademicCapIcon,
  FolderIcon,
  ClockIcon,
  QueueListIcon,
  ComputerDesktopIcon,
  PhotoIcon,
  SparklesIcon,
  Cog6ToothIcon,
} from "@heroicons/react/24/outline";
import { Dashboard } from "./views/Dashboard";
import { RagManagement } from "./views/RagManagement";
import { Prompts } from "./views/Prompts";
import { Memories } from "./views/Memories";
import { Projects } from "./views/Projects";
import { Sessions } from "./views/Sessions";
import { Timeline } from "./views/Timeline";
import { Learning } from "./views/Learning";
import { Machines } from "./views/Machines";
import { Media } from "./views/Media";
import { Skills } from "./views/Skills";
import { getToken, setToken, setUnauthorizedHandler } from "./api";
import { I18nContext, useI18n, useProvideI18n, type Lang } from "./i18n";

type View =
  | "dashboard"
  | "timeline"
  | "rag"
  | "prompts"
  | "memories"
  | "learning"
  | "projects"
  | "sessions"
  | "machines"
  | "media"
  | "skills"
  | "settings";

const NAV: { id: View; labelKey: Parameters<ReturnType<typeof useI18n>["t"]>[0]; icon: React.ComponentType }[] = [
  { id: "dashboard", labelKey: "nav.dashboard", icon: Squares2X2Icon },
  { id: "timeline", labelKey: "nav.timeline", icon: QueueListIcon },
  { id: "rag", labelKey: "nav.rag", icon: ServerStackIcon },
  { id: "prompts", labelKey: "nav.prompts", icon: BookOpenIcon },
  { id: "memories", labelKey: "nav.memories", icon: CircleStackIcon },
  { id: "learning", labelKey: "nav.learning", icon: AcademicCapIcon },
  { id: "projects", labelKey: "nav.projects", icon: FolderIcon },
  { id: "sessions", labelKey: "nav.sessions", icon: ClockIcon },
  { id: "machines", labelKey: "nav.machines", icon: ComputerDesktopIcon },
  { id: "media", labelKey: "nav.media", icon: PhotoIcon },
  { id: "skills", labelKey: "nav.skills", icon: SparklesIcon },
  { id: "settings", labelKey: "nav.settings", icon: Cog6ToothIcon },
];

function LanguageToggle() {
  const { lang, setLang, t } = useI18n();
  return (
    <VStack gap={1} paddingInline={3} paddingBlock={2}>
      <Text type="supporting" color="secondary">{t("settings.language")}</Text>
      <SegmentedControl label={t("settings.language")} value={lang} onChange={(v) => setLang(v as Lang)} layout="fill" size="sm">
        <SegmentedControlItem value="tr" label="TR" />
        <SegmentedControlItem value="en" label="EN" />
      </SegmentedControl>
    </VStack>
  );
}

function Settings() {
  const { t } = useI18n();
  const [token, setTokenValue] = useState(getToken());
  const [saved, setSaved] = useState(false);
  return (
    <VStack gap={4}>
      <Heading level={3}>{t("settings.title")}</Heading>
      <Card>
        <VStack gap={3}>
          <TextInput
            label={t("settings.tokenLabel")}
            type="password"
            value={token}
            onChange={(v: string) => { setTokenValue(v); setSaved(false); }}
          />
          <HStack gap={2} vAlign="center">
            <Button label={t("common.save")} variant="primary" onClick={() => { setToken(token); setSaved(true); }} />
            {saved && <Text type="supporting" color="secondary">{t("settings.saved")}</Text>}
          </HStack>
        </VStack>
      </Card>
    </VStack>
  );
}

/** 401 alındığında tam ekran token isteme ekranı — token girilince kaldığı görünüme döner. */
function TokenGate({ onSubmit }: { onSubmit: (token: string) => void }) {
  const { t } = useI18n();
  const [token, setTokenValue] = useState("");
  return (
    <Center axis="horizontal">
      <VStack gap={5} maxWidth={420} paddingBlock={10}>
        <VStack gap={1}>
          <Heading level={3}>{t("tokenGate.title")}</Heading>
          <Text type="supporting" color="secondary">
            {t("tokenGate.description")}
          </Text>
        </VStack>
        <Card>
          <VStack gap={3}>
            <TextInput
              label={t("tokenGate.tokenLabel")}
              type="password"
              value={token}
              onChange={setTokenValue}
              isRequired
              placeholder={t("tokenGate.placeholder")}
            />
            <Button
              label={t("tokenGate.connect")}
              variant="primary"
              onClick={() => onSubmit(token)}
              isDisabled={!token.trim()}
            />
          </VStack>
        </Card>
        <EmptyState
          title={t("tokenGate.whereTitle")}
          description={t("tokenGate.whereDesc")}
        />
      </VStack>
    </Center>
  );
}

function AppInner() {
  const { t } = useI18n();
  const [view, setView] = useState<View>("dashboard");
  const [needsToken, setNeedsToken] = useState(false);

  useEffect(() => {
    setUnauthorizedHandler(() => setNeedsToken(true));
    return () => setUnauthorizedHandler(null);
  }, []);

  if (needsToken) {
    return (
      <AppShell height="fill" contentPadding={6}>
        <TokenGate
          onSubmit={(token) => {
            setToken(token);
            setNeedsToken(false);
          }}
        />
      </AppShell>
    );
  }

  return (
    <AppShell
      height="fill"
      contentPadding={6}
      sideNav={
        <SideNav footer={<LanguageToggle />}>
          {NAV.map((item) => (
            <SideNavItem
              key={item.id}
              label={t(item.labelKey)}
              icon={item.icon}
              isSelected={view === item.id}
              onClick={() => setView(item.id)}
            />
          ))}
        </SideNav>
      }
    >
      {view === "dashboard" && <Dashboard />}
      {view === "timeline" && <Timeline onNavigate={(target) => setView(target)} />}
      {view === "rag" && <RagManagement />}
      {view === "prompts" && <Prompts />}
      {view === "memories" && <Memories />}
      {view === "learning" && <Learning />}
      {view === "projects" && <Projects />}
      {view === "sessions" && <Sessions />}
      {view === "machines" && <Machines />}
      {view === "media" && <Media />}
      {view === "skills" && <Skills />}
      {view === "settings" && <Settings />}
    </AppShell>
  );
}

export default function App() {
  const i18n = useProvideI18n();
  return (
    <I18nContext.Provider value={i18n}>
      <LayerProvider>
        <AppInner />
      </LayerProvider>
    </I18nContext.Provider>
  );
}
