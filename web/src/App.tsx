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
import {
  Squares2X2Icon,
  ServerStackIcon,
  CircleStackIcon,
  BookOpenIcon,
  FolderIcon,
  ClockIcon,
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
import { Machines } from "./views/Machines";
import { Media } from "./views/Media";
import { Skills } from "./views/Skills";
import { getToken, setToken, setUnauthorizedHandler } from "./api";

type View =
  | "dashboard"
  | "rag"
  | "prompts"
  | "memories"
  | "projects"
  | "sessions"
  | "machines"
  | "media"
  | "skills"
  | "settings";

const NAV: { id: View; label: string; icon: React.ComponentType }[] = [
  { id: "dashboard", label: "Panel", icon: Squares2X2Icon },
  { id: "rag", label: "RAG Yönetimi", icon: ServerStackIcon },
  { id: "prompts", label: "Prompt'lar", icon: BookOpenIcon },
  { id: "memories", label: "Hafıza", icon: CircleStackIcon },
  { id: "projects", label: "Projeler", icon: FolderIcon },
  { id: "sessions", label: "Oturumlar", icon: ClockIcon },
  { id: "machines", label: "Makineler", icon: ComputerDesktopIcon },
  { id: "media", label: "Medya", icon: PhotoIcon },
  { id: "skills", label: "Skiller", icon: SparklesIcon },
  { id: "settings", label: "Ayarlar", icon: Cog6ToothIcon },
];

function Settings() {
  const [token, setTokenValue] = useState(getToken());
  const [saved, setSaved] = useState(false);
  return (
    <VStack gap={4}>
      <Heading level={3}>Ayarlar</Heading>
      <Card>
        <VStack gap={3}>
          <TextInput
            label="API Token (sunucuda HUB_TOKEN doluysa gerekli)"
            type="password"
            value={token}
            onChange={(v: string) => { setTokenValue(v); setSaved(false); }}
          />
          <HStack gap={2} vAlign="center">
            <Button label="Kaydet" variant="primary" onClick={() => { setToken(token); setSaved(true); }} />
            {saved && <Text type="supporting" color="secondary">Kaydedildi (tarayıcıda saklanır)</Text>}
          </HStack>
        </VStack>
      </Card>
    </VStack>
  );
}

/** 401 alındığında tam ekran token isteme ekranı — token girilince kaldığı görünüme döner. */
function TokenGate({ onSubmit }: { onSubmit: (token: string) => void }) {
  const [token, setTokenValue] = useState("");
  return (
    <Center axis="horizontal">
      <VStack gap={5} maxWidth={420} paddingBlock={10}>
        <VStack gap={1}>
          <Heading level={3}>Oturum gerekli</Heading>
          <Text type="supporting" color="secondary">
            Sunucu bir API token'ı bekliyor (HUB_TOKEN). Devam etmek için token'ı gir.
          </Text>
        </VStack>
        <Card>
          <VStack gap={3}>
            <TextInput
              label="API Token"
              type="password"
              value={token}
              onChange={setTokenValue}
              isRequired
              placeholder="hub token'ınız"
            />
            <Button
              label="Bağlan"
              variant="primary"
              onClick={() => onSubmit(token)}
              isDisabled={!token.trim()}
            />
          </VStack>
        </Card>
        <EmptyState
          title="Token'ı nereden bulurum?"
          description="Pi üzerindeki sunucu ortam değişkeni HUB_TOKEN ile aynı değeri kullan."
        />
      </VStack>
    </Center>
  );
}

export default function App() {
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
        <SideNav>
          {NAV.map((item) => (
            <SideNavItem
              key={item.id}
              label={item.label}
              icon={item.icon}
              isSelected={view === item.id}
              onClick={() => setView(item.id)}
            />
          ))}
        </SideNav>
      }
    >
      {view === "dashboard" && <Dashboard />}
      {view === "rag" && <RagManagement />}
      {view === "prompts" && <Prompts />}
      {view === "memories" && <Memories />}
      {view === "projects" && <Projects />}
      {view === "sessions" && <Sessions />}
      {view === "machines" && <Machines />}
      {view === "media" && <Media />}
      {view === "skills" && <Skills />}
      {view === "settings" && <Settings />}
    </AppShell>
  );
}
