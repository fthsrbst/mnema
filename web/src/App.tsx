import { useState } from "react";
import { AppShell } from "@astryxdesign/core/AppShell";
import { SideNav, SideNavItem } from "@astryxdesign/core/SideNav";
import { VStack, HStack } from "@astryxdesign/core/Layout";
import { Card } from "@astryxdesign/core/Card";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Text, Heading } from "@astryxdesign/core/Text";
import {
  CircleStackIcon,
  FolderIcon,
  ClockIcon,
  ComputerDesktopIcon,
  PhotoIcon,
  SparklesIcon,
  Cog6ToothIcon,
} from "@heroicons/react/24/outline";
import { Memories } from "./views/Memories";
import { Projects } from "./views/Projects";
import { Sessions } from "./views/Sessions";
import { Machines } from "./views/Machines";
import { Media } from "./views/Media";
import { Skills } from "./views/Skills";
import { getToken, setToken } from "./api";

type View = "memories" | "projects" | "sessions" | "machines" | "media" | "skills" | "settings";

const NAV: { id: View; label: string; icon: React.ComponentType }[] = [
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

export default function App() {
  const [view, setView] = useState<View>("memories");

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
