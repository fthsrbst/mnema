import { useCallback, useEffect, useState } from "react";
import { VStack, HStack } from "@astryxdesign/core/Layout";
import { Card } from "@astryxdesign/core/Card";
import { Button } from "@astryxdesign/core/Button";
import { Text, Heading } from "@astryxdesign/core/Text";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Item } from "@astryxdesign/core/Item";
import { Icon } from "@astryxdesign/core/Icon";
import { Badge } from "@astryxdesign/core/Badge";
import { Divider } from "@astryxdesign/core/Divider";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { CircleStackIcon, ClockIcon, DocumentTextIcon } from "@heroicons/react/24/outline";
import { api, type TimelineItem } from "../api";
import { useI18n, type Lang, type TKey } from "../i18n";

const PAGE_SIZE = 50;

type Kind = TimelineItem["kind"];
type Filter = "all" | Kind;

/** Her tür için ikon, ikon rengi ve gidilecek görünüm — türler bir bakışta ayırt edilsin. */
const KIND_CONFIG: Record<
  Kind,
  {
    icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    iconColor: "accent" | "success" | "warning";
    badgeVariant: "blue" | "green" | "orange";
    labelKey: TKey;
    targetView: "memories" | "sessions" | "rag";
  }
> = {
  memory: { icon: CircleStackIcon, iconColor: "accent", badgeVariant: "blue", labelKey: "timeline.kindMemory", targetView: "memories" },
  session: { icon: ClockIcon, iconColor: "success", badgeVariant: "green", labelKey: "timeline.kindSession", targetView: "sessions" },
  document: { icon: DocumentTextIcon, iconColor: "warning", badgeVariant: "orange", labelKey: "timeline.kindDocument", targetView: "rag" },
};

/** SQLite UTC tarihini ("YYYY-MM-DD HH:MM:SS") yerel Date'e çevirir. */
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
  return sample.toLocaleDateString(lang === "tr" ? "tr-TR" : "en-US", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
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
      const batch = await api<TimelineItem[]>(
        "GET",
        `/api/timeline?limit=${PAGE_SIZE}&before=${encodeURIComponent(last.date)}`
      );
      setItems((prev) => [...prev, ...batch]);
      setHasMore(batch.length === PAGE_SIZE);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  const visible = filter === "all" ? items : items.filter((it) => it.kind === filter);

  // Gün bazında grupla — API zaten en yeni önce sıralı döner.
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
        <Button label={t("common.refresh")} variant="secondary" onClick={load} isDisabled={loading} />
      </HStack>

      <SegmentedControl
        label={t("timeline.title")}
        value={filter}
        onChange={(v) => setFilter(v as Filter)}
        size="sm"
      >
        <SegmentedControlItem value="all" label={t("timeline.filterAll")} />
        <SegmentedControlItem value="memory" label={t("timeline.kindMemory")} />
        <SegmentedControlItem value="session" label={t("timeline.kindSession")} />
        <SegmentedControlItem value="document" label={t("timeline.kindDocument")} />
      </SegmentedControl>

      {error && (
        <Card variant="red">
          <Text color="secondary">{t("common.loadFailed")}: {error}</Text>
        </Card>
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
              <VStack gap={1}>
                <Text type="label" color="secondary">{group.label}</Text>
                <Divider />
              </VStack>
              <VStack gap={0}>
                {group.items.map((it) => {
                  const cfg = KIND_CONFIG[it.kind];
                  const d = parseDate(it.date);
                  const time = Number.isNaN(d.getTime())
                    ? it.date.slice(11, 16)
                    : d.toLocaleTimeString(lang === "tr" ? "tr-TR" : "en-US", { hour: "2-digit", minute: "2-digit" });
                  return (
                    <Item
                      key={`${it.kind}-${it.id}`}
                      density="balanced"
                      onClick={() => onNavigate(cfg.targetView)}
                      startContent={<Icon icon={cfg.icon} color={cfg.iconColor} size="md" />}
                      label={it.title}
                      labelLines={1}
                      description={it.subtype ? `${t(cfg.labelKey)} · ${it.subtype}` : t(cfg.labelKey)}
                      endContent={
                        <HStack gap={2} vAlign="center">
                          {it.project && <Badge variant={cfg.badgeVariant} label={it.project} />}
                          <Text type="supporting" color="secondary">{time}</Text>
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
              <Button
                label={loadingMore ? t("common.loading") : t("timeline.loadMore")}
                variant="secondary"
                onClick={loadMore}
                isDisabled={loadingMore}
              />
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
