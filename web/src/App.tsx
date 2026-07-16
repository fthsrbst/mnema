import { useEffect, useMemo, useState } from "react";
import { IconRail, type RailItem } from "./components/ui/IconRail";
import { Icon } from "./components/icons/Icons";
import { Tabs } from "./components/ui/Tabs";
import { Reveal } from "./components/ui/Reveal";
import { Panel } from "./components/ui/Panel";
import { Button } from "./components/ui/Button";
import { TextField } from "./components/ui/Field";
import { VStack } from "./components/ui/Stack";
import { Heading, Text } from "./components/ui/Typography";
import { ToastProvider } from "./components/ui/Toast";
import { Dashboard } from "./views/Dashboard";
import { RagManagement } from "./views/RagManagement";
import { Prompts } from "./views/Prompts";
import { Memories } from "./views/Memories";
import { Projects } from "./views/Projects";
import { Sessions } from "./views/Sessions";
import { Timeline } from "./views/Timeline";
import { Graph } from "./views/Graph";
import { Learning } from "./views/Learning";
import { Machines } from "./views/Machines";
import { Media } from "./views/Media";
import { Skills } from "./views/Skills";
import { getToken, setToken, setUnauthorizedHandler } from "./api";
import { I18nContext, useI18n, useProvideI18n, type Lang, type TKey } from "./i18n";

type SectionId = "overview" | "memory" | "projects" | "system";

interface TabDef {
  id: string;
  labelKey: TKey;
}

const SECTIONS: { id: SectionId; labelKey: TKey; icon: RailItem["icon"]; tabs: TabDef[] }[] = [
  {
    id: "overview",
    labelKey: "nav.sectionOverview",
    icon: "overview",
    tabs: [
      { id: "dashboard", labelKey: "nav.dashboard" },
      { id: "timeline", labelKey: "nav.timeline" },
      { id: "graph", labelKey: "nav.graph" },
    ],
  },
  {
    id: "memory",
    labelKey: "nav.sectionMemory",
    icon: "memory",
    tabs: [
      { id: "memories", labelKey: "nav.memories" },
      { id: "rag", labelKey: "nav.rag" },
      { id: "learning", labelKey: "nav.learning" },
      { id: "prompts", labelKey: "nav.prompts" },
    ],
  },
  {
    id: "projects",
    labelKey: "nav.sectionProjects",
    icon: "projects",
    tabs: [
      { id: "projects", labelKey: "nav.projects" },
      { id: "sessions", labelKey: "nav.sessions" },
    ],
  },
  {
    id: "system",
    labelKey: "nav.sectionSystem",
    icon: "system",
    tabs: [
      { id: "machines", labelKey: "nav.machines" },
      { id: "media", labelKey: "nav.media" },
      { id: "skills", labelKey: "nav.skills" },
      { id: "settings", labelKey: "nav.settings" },
    ],
  },
];

/** Timeline satırına tıklandığında hangi (bölüm, sekme) çiftine gidileceğini eşler. */
const TIMELINE_TARGETS: Record<"memories" | "sessions" | "rag", { section: SectionId; tab: string }> = {
  memories: { section: "memory", tab: "memories" },
  rag: { section: "memory", tab: "rag" },
  sessions: { section: "projects", tab: "sessions" },
};

function LanguageToggle() {
  const { lang, setLang } = useI18n();
  return (
    <div className="lang-toggle">
      <button type="button" data-active={lang === "tr"} onClick={() => setLang("tr")}>
        TR
      </button>
      <button type="button" data-active={lang === "en"} onClick={() => setLang("en")}>
        EN
      </button>
    </div>
  );
}

function Settings() {
  const { t } = useI18n();
  const [token, setTokenValue] = useState(getToken());
  const [saved, setSaved] = useState(false);
  return (
    <VStack gap={4}>
      <Heading level={3}>{t("settings.title")}</Heading>
      <Panel>
        <VStack gap={3}>
          <TextField
            label={t("settings.tokenLabel")}
            type="password"
            value={token}
            onChange={(v) => {
              setTokenValue(v);
              setSaved(false);
            }}
          />
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Button
              label={t("common.save")}
              variant="primary"
              onClick={() => {
                setToken(token);
                setSaved(true);
              }}
            />
            {saved && <Text type="supporting" color="secondary">{t("settings.saved")}</Text>}
          </div>
        </VStack>
      </Panel>
      <Panel>
        <VStack gap={2}>
          <span className="u-label">{t("settings.language")}</span>
          <LanguageToggle />
        </VStack>
      </Panel>
    </VStack>
  );
}

/** 401 alındığında tam ekran token isteme ekranı — token girilince kaldığı görünüme döner. */
function TokenGate({ onSubmit }: { onSubmit: (token: string) => void }) {
  const { t } = useI18n();
  const [token, setTokenValue] = useState("");
  return (
    <div className="token-gate">
      <div className="token-gate-box">
        <VStack gap={1}>
          <Heading level={2}>{t("tokenGate.title")}</Heading>
          <Text type="supporting" color="secondary">
            {t("tokenGate.description")}
          </Text>
        </VStack>
        <Panel raised>
          <VStack gap={3}>
            <TextField
              label={t("tokenGate.tokenLabel")}
              type="password"
              value={token}
              onChange={setTokenValue}
              placeholder={t("tokenGate.placeholder")}
            />
            <Button label={t("tokenGate.connect")} variant="primary" onClick={() => onSubmit(token)} disabled={!token.trim()} />
          </VStack>
        </Panel>
        <Text type="supporting" color="secondary">
          {t("tokenGate.whereTitle")} — {t("tokenGate.whereDesc")}
        </Text>
      </div>
    </div>
  );
}

function AppInner() {
  const { t } = useI18n();
  const [railExpanded, setRailExpanded] = useState(false);
  const [section, setSection] = useState<SectionId>("overview");
  const [tabBySection, setTabBySection] = useState<Record<SectionId, string>>({
    overview: "dashboard",
    memory: "memories",
    projects: "projects",
    system: "machines",
  });
  const [needsToken, setNeedsToken] = useState(false);

  useEffect(() => {
    setUnauthorizedHandler(() => setNeedsToken(true));
    return () => setUnauthorizedHandler(null);
  }, []);

  const activeSection = useMemo(() => SECTIONS.find((s) => s.id === section)!, [section]);
  const activeTab = tabBySection[section];

  const goTo = (target: SectionId, tab: string) => {
    setSection(target);
    setTabBySection((prev) => ({ ...prev, [target]: tab }));
  };

  if (needsToken) {
    return (
      <TokenGate
        onSubmit={(token) => {
          setToken(token);
          setNeedsToken(false);
        }}
      />
    );
  }

  const railItems: RailItem[] = SECTIONS.map((s) => ({ id: s.id, label: t(s.labelKey), icon: s.icon }));

  const renderTab = () => {
    switch (activeTab) {
      case "dashboard":
        return <Dashboard />;
      case "timeline":
        return <Timeline onNavigate={(target) => { const dest = TIMELINE_TARGETS[target]; goTo(dest.section, dest.tab); }} />;
      case "graph":
        return <Graph />;
      case "memories":
        return <Memories />;
      case "rag":
        return <RagManagement />;
      case "learning":
        return <Learning />;
      case "prompts":
        return <Prompts />;
      case "projects":
        return <Projects />;
      case "sessions":
        return <Sessions />;
      case "machines":
        return <Machines />;
      case "media":
        return <Media />;
      case "skills":
        return <Skills />;
      case "settings":
        return <Settings />;
      default:
        return null;
    }
  };

  return (
    <div className="app-shell">
      <div className="app-rail-col" data-expanded={railExpanded}>
        <div className="app-rail-logo" title="AI Hub">
          <Icon name="hub" size={18} />
          <span className="app-rail-logo-label">Mnema</span>
        </div>
        <IconRail
          items={railItems}
          active={section}
          expanded={railExpanded}
          onSelect={(id) => setSection(id as SectionId)}
        />
        <div className="app-rail-foot">
          <button
            type="button"
            className="app-rail-toggle"
            aria-expanded={railExpanded}
            aria-label={railExpanded ? t("nav.collapseSidebar") : t("nav.expandSidebar")}
            title={railExpanded ? t("nav.collapseSidebar") : t("nav.expandSidebar")}
            onClick={() => setRailExpanded((value) => !value)}
          >
            <Icon name="chevronRight" size={10} className="app-rail-toggle-icon" />
            <span className="app-rail-toggle-label">{t("nav.collapseSidebar")}</span>
          </button>
        </div>
      </div>
      <div className="app-main">
        <header className="app-topbar">
          <span className="app-topbar-title">{t(activeSection.labelKey)}</span>
          <Tabs
            value={activeTab}
            onChange={(tab) => setTabBySection((prev) => ({ ...prev, [section]: tab }))}
            items={activeSection.tabs.map((tb) => ({ value: tb.id, label: t(tb.labelKey) }))}
          />
          <LanguageToggle />
        </header>
        {/* Graf sekmesi viewport'u komple kaplar — padding'li scroll konteynerinin dışında kalır. */}
        <div className={`app-content${activeTab === "graph" ? " app-content--fill" : ""}`}>
          {activeTab === "graph" ? (
            renderTab()
          ) : (
            <div className="app-content-inner">
              <Reveal trigger={`${section}-${activeTab}`}>{renderTab()}</Reveal>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const i18n = useProvideI18n();
  return (
    <I18nContext.Provider value={i18n}>
      <ToastProvider>
        <AppInner />
      </ToastProvider>
    </I18nContext.Provider>
  );
}

export type { Lang };
