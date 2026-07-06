import { useCallback, useEffect, useState } from "react";
import { VStack, HStack } from "@astryxdesign/core/Layout";
import { Card } from "@astryxdesign/core/Card";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text, Heading } from "@astryxdesign/core/Text";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { api, type Memory } from "../api";

interface Row extends Record<string, unknown> {
  id: string;
  mem: Memory;
}

export function Memories() {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Memory[]>([]);
  const [selected, setSelected] = useState<Memory | null>(null);
  const [draft, setDraft] = useState({ title: "", body: "", type: "fact", project: "" });
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      const route = query.trim()
        ? `/api/memory/search?q=${encodeURIComponent(query)}&limit=25`
        : "/api/memory?limit=50";
      setItems(await api<Memory[]>("GET", route));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [query]);

  useEffect(() => {
    load();
  }, [load]);

  const openRow = (mem: Memory) => {
    setSelected(mem);
    setShowNew(false);
    setDraft({ title: mem.title, body: mem.body, type: mem.type, project: mem.project ?? "" });
  };

  const columns: TableColumn<Row>[] = [
    { key: "type", header: "Tür", width: pixel(100), renderCell: (r: Row) => r.mem.type },
    { key: "title", header: "Başlık", width: proportional(1), renderCell: (r: Row) => r.mem.title },
    { key: "project", header: "Proje", width: pixel(120), renderCell: (r: Row) => r.mem.project ?? "—" },
    { key: "updated", header: "Güncelleme", width: pixel(150), renderCell: (r: Row) => r.mem.updated_at },
    {
      key: "actions",
      header: "",
      width: pixel(90),
      renderCell: (r: Row) => (
        <Button label="Aç" variant="ghost" size="sm" onClick={() => openRow(r.mem)} />
      ),
    },
  ];

  const save = async () => {
    try {
      if (selected) {
        await api("PATCH", `/api/memory/${selected.id}`, {
          title: draft.title,
          body: draft.body,
          type: draft.type,
          project: draft.project || undefined,
        });
      } else {
        await api("POST", "/api/memory", {
          title: draft.title,
          body: draft.body,
          type: draft.type,
          project: draft.project || undefined,
          source: "web-ui",
        });
      }
      setSelected(null);
      setShowNew(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async () => {
    if (!selected) return;
    await api("DELETE", `/api/memory/${selected.id}`);
    setSelected(null);
    await load();
  };

  const editing = selected !== null || showNew;

  return (
    <VStack gap={4}>
      <HStack hAlign="between" vAlign="center">
        <Heading level={3}>Hafıza</Heading>
        <Button
          label="Yeni kayıt"
          variant="primary"
          onClick={() => {
            setSelected(null);
            setDraft({ title: "", body: "", type: "fact", project: "" });
            setShowNew(true);
          }}
        />
      </HStack>
      <HStack gap={2} vAlign="end">
        <TextInput
          label="Ara"
          isLabelHidden
          placeholder="Hibrit arama (anahtar kelime + anlamsal)..."
          value={query}
          onChange={(v: string) => setQuery(v)}
          hasClear
        />
        <Button label="Ara" variant="secondary" onClick={load} />
      </HStack>
      {error && <Text color="secondary">Hata: {error}</Text>}
      {editing && (
        <Card>
          <VStack gap={3}>
            <Heading level={4}>{selected ? `#${selected.id} düzenle` : "Yeni hafıza kaydı"}</Heading>
            <TextInput label="Başlık" value={draft.title} onChange={(v: string) => setDraft({ ...draft, title: v })} isRequired />
            <HStack gap={3}>
              <TextInput label="Tür (fact/preference/decision/howto/context)" value={draft.type} onChange={(v: string) => setDraft({ ...draft, type: v })} />
              <TextInput label="Proje" value={draft.project} onChange={(v: string) => setDraft({ ...draft, project: v })} isOptional />
            </HStack>
            <TextArea label="İçerik" value={draft.body} onChange={(v: string) => setDraft({ ...draft, body: v })} rows={6} isRequired />
            <HStack gap={2}>
              <Button label="Kaydet" variant="primary" onClick={save} />
              <Button label="Vazgeç" variant="secondary" onClick={() => { setSelected(null); setShowNew(false); }} />
              {selected && <Button label="Sil" variant="destructive" onClick={remove} />}
            </HStack>
          </VStack>
        </Card>
      )}
      {items.length === 0 && !editing ? (
        <EmptyState
          title={query ? "Eşleşen kayıt yok" : "Henüz hafıza kaydı yok"}
          description={query ? "Farklı kelimelerle dene — anlamsal arama eş anlamlıları da bulur." : "Agentlar çalıştıkça burası dolacak; elle de ekleyebilirsin."}
        />
      ) : (
        <Table<Row>
          data={items.map((m) => ({ id: String(m.id), mem: m }))}
          columns={columns}
          idKey="id"
          density="compact"
          dividers="rows"
          hasHover
        />
      )}
    </VStack>
  );
}
