import { useCallback, useEffect, useState } from "react";
import { VStack, HStack } from "../components/ui/Stack";
import { Panel } from "../components/ui/Panel";
import { Button } from "../components/ui/Button";
import { Heading, Text } from "../components/ui/Typography";
import { EmptyState } from "../components/ui/EmptyState";
import { ListRow } from "../components/ui/ListRow";
import { Icon, type IconName } from "../components/icons/Icons";
import { SectionRule } from "../components/ui/Divider";
import { SegmentedControl } from "../components/ui/Tabs";
import { Tag } from "../components/ui/Tag";
import { api, type TimelineItem } from "../api";
import { useI18n, type Lang, type TKey } from "../i18n";

const PAGE_SIZE = 50;

type Kind = TimelineItem["kind"];
type Filter = "all" | Kind;

const KIND_CONFIG: Record<Kind, { icon: IconName; labelKey: TKey; targetView: "memories" | "sessions" | "rag" }> = {
  memory: { icon: "memory", labelKey: "timeline.kindMemory", targetView: "memories" },
  session: { icon: "sessions", labelKey: "timeline.kindSession", targetView: "sessions" },
  document: { icon: "docs", labelKey: "timeline.kindDocument", targetView: "rag" },
};

function parseDate(iso: string): Date {
  return new Date(iso.replace(" ", "T") + (iso.endsWith("Z") ? "" : "Z"));
}

function localDayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayLabel(dayKey: string, sample: Date, lang: Lang, t: (k: TKey) => string): string {
  const now = new Date();
  const today = localDayKey(now);
  const yesterday = localDayKey(new Date(now.getTime() - 86400000));
  if (dayKey === today) return t("timeline.today");
  if (dayKey === yesterday) return t("timeline.yesterday");
  return sample.toLocaleDateString(lang === "tr" ? "tr-TR" : "en-US", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

interface DayGroup {
  key: string;
  label: string;
  items: TimelineItem[];
}

export function Timeline({ onNavigate }: { onNavigate: (view: "memories" | "sessions" | "rag") => void }) {
  const { t, lang } = useI18n();
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const batch = await api<TimelineItem[]>("GET", `/api/timeline?limit=${PAGE_SIZE}`);
      setItems(batch);
      setHasMore(batch.length === PAGE_SIZE);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const loadMore = async () => {
    const last = items[items.length - 1];
    if (!last) return;
    setLoadingMore(true);
    setError("");
    try {
      const batch = await api<TimelineItem[]>("GET", `/api/timeline?limit=${PAGE_SIZE}&before=${encodeURIComponent(last.date)}`);
      setItems((prev) => [...prev, ...batch]);
      setHasMore(batch.length === PAGE_SIZE);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  const visible = filter === "all" ? items : items.filter((it) => it.kind === filter);

  const groups: DayGroup[] = [];
  for (const it of visible) {
    const d = parseDate(it.date);
    const key = Number.isNaN(d.getTime()) ? it.date.slice(0, 10) : localDayKey(d);
    const current = groups[groups.length - 1];
    if (current && current.key === key) {
      current.items.push(it);
    } else {
      groups.push({ key, label: dayLabel(key, d, lang, t), items: [it] });
    }
  }

  return (
    <VStack gap={4}>
      <HStack hAlign="between" vAlign="center" wrap="wrap" gap={2}>
        <VStack gap={1}>
          <Heading level={3}>{t("timeline.title")}</Heading>
          <Text type="supporting" color="secondary">{t("timeline.subtitle")}</Text>
        </VStack>
        <Button label={t("common.refresh")} variant="secondary" onClick={load} disabled={loading} />
      </HStack>

      <SegmentedControl
        value={filter}
        onChange={setFilter}
        items={[
          { value: "all", label: t("timeline.filterAll") },
          { value: "memory", label: t("timeline.kindMemory") },
          { value: "session", label: t("timeline.kindSession") },
          { value: "document", label: t("timeline.kindDocument") },
        ]}
      />

      {error && (
        <Panel variant="danger">
          <Text color="secondary">{t("common.loadFailed")}: {error}</Text>
        </Panel>
      )}

      {loading && items.length === 0 ? (
        <Text color="secondary">{t("common.loading")}</Text>
      ) : visible.length === 0 ? (
        <EmptyState
          title={filter === "all" ? t("timeline.empty") : t("timeline.emptyFiltered")}
          description={filter === "all" ? t("timeline.emptyDesc") : t("timeline.emptyFilteredDesc")}
        />
      ) : (
        <VStack gap={5}>
          {groups.map((group) => (
            <VStack key={group.key} gap={2}>
              <SectionRule label={group.label} />
              <VStack gap={0}>
                {group.items.map((it, idx) => {
                  const cfg = KIND_CONFIG[it.kind];
                  const d = parseDate(it.date);
                  const time = Number.isNaN(d.getTime())
                    ? it.date.slice(11, 16)
                    : d.toLocaleTimeString(lang === "tr" ? "tr-TR" : "en-US", { hour: "2-digit", minute: "2-digit" });
                  return (
                    <ListRow
                      key={`${it.kind}-${it.id}`}
                      bordered={idx > 0}
                      onClick={() => onNavigate(cfg.targetView)}
                      start={<Icon name={cfg.icon} size={16} className="u-mono-dim" />}
                      title={it.title}
                      description={it.subtype ? `${t(cfg.labelKey)} · ${it.subtype}` : t(cfg.labelKey)}
                      end={
                        <HStack gap={2} vAlign="center">
                          {it.project && <Tag>{it.project}</Tag>}
                          <Text type="supporting" color="disabled">{time}</Text>
                        </HStack>
                      }
                    />
                  );
                })}
              </VStack>
            </VStack>
          ))}

          {hasMore ? (
            <HStack hAlign="center">
              <Button label={loadingMore ? t("common.loading") : t("timeline.loadMore")} variant="secondary" onClick={loadMore} disabled={loadingMore} />
            </HStack>
          ) : (
            <HStack hAlign="center">
              <Text type="supporting" color="secondary">{t("timeline.end")}</Text>
            </HStack>
          )}
        </VStack>
      )}
    </VStack>
  );
}
