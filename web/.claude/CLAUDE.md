# CLAUDE.md — web/

Frontend agentları için proje-özel rehber. Backend (`../src/`) burada anlatılmaz — o dosyaya dokunma.

## Tasarım kimliği: 1-bit / bitmap

Bu arayüz bilinçli olarak **near-black, tek accent renkli, köşesiz** bir kimliğe kilitlenmiştir.
Astryx design system ve RevenueX krem-amber teması tamamen kaldırıldı — geri getirme.

- **Palet**: `src/design/tokens.css` — `--bg` (#0a0a0a), `--fg` (kırık beyaz), tek "canlı" accent
  `--accent` (fosfor yeşili, sadece online/success/live durumları için), `--danger` (sadece
  yıkıcı işlem/hata sinyali). Yeni renk EKLEME — mevcut token'lardan seç.
- **Köşe**: `--radius: 0px`. Yuvarlak köşe, blur/glassmorphism, yumuşak gölge YASAK. Gölgeler
  sert offset (`--shadow-hard*`) — "basılı buton" hissi.
- **Fontlar**: self-host, CDN yok (`@fontsource/*` — Tailscale arkasında offline çalışır).
  Başlık/dot-matrix: `--font-display` (Silkscreen). Gövde/veri: `--font-mono` (IBM Plex Mono).
  Büyük sayısal ticker: `--font-numeric` (VT323). Sistem fontu/Inter EKLEME.
- **Motion**: GSAP (`gsap` paketi) — `components/ui/Reveal.tsx` (stagger giriş),
  `components/ui/Ticker.tsx` (sayaç). `prefers-reduced-motion` her zaman kontrol edilir.
- **Dithering**: `components/ui/Dither.tsx` — Bayer 8x8 canvas dokusu, hero/arka plan için.
  Yeni dekoratif doku eklemen gerekirse buradaki matris yaklaşımını genişlet.
- **`<html lang>` senkron kalmalı**: `i18n.ts`'teki `useProvideI18n` bunu otomatik yapar. CSS
  `text-transform: uppercase` Türkçe'de i→İ kuralını `lang="tr"` iken uygular; bu senkron
  bozulursa İngilizce arayüzde "MACHİNES" gibi hatalı büyütmeler geri gelir — bu koruma etrafında
  iş yaparken dikkatli ol.

## Bileşen kütüphanesi

`src/components/ui/` — küçük, tek-sorumluluklu dosyalar. Yeni UI ihtiyacı doğarsa önce burada
karşılığı var mı bak, yoksa aynı disiplinde (köşesiz, mono, token tabanlı) yeni dosya ekle:

Panel, Button/IconButton, Field (TextField/TextArea/Select/Switch), Tag/StatusDot/LivePill,
Divider/SectionRule, Tabs/SegmentedControl, EmptyState, Dialog/AlertDialog, Toast/useToast,
DataTable, PixelMeter, Collapsible, ListRow, IconRail, Reveal, Ticker, Dither, Ascii.

İkonlar: `src/components/icons/Icons.tsx` — özel 7x7 pixel-bitmap seti, dış ikon kütüphanesi
(heroicons vb.) EKLEME. Yeni ikon gerekirse aynı bitmap yaklaşımıyla `ICONS` map'ine ekle.

`Stack.tsx` (VStack/HStack/Grid) ve `Typography.tsx` (Heading/Text) düzen/tipografi
primitifleridir — ham `<div style>` yazmak yerine bunları kullan.

## Bilgi mimarisi

`App.tsx` içinde 4 üst bölüm (icon rail) + her bölümde sekmeler:

1. **Genel Bakış** (`overview`) — Dashboard, Timeline
2. **Bellek** (`memory`) — Memories, RagManagement, Learning, Prompts
3. **Projeler** (`projects`) — Projects, Sessions
4. **Sistem** (`system`) — Machines, Media, Skills, Settings

Yeni bir view eklenecekse önce hangi bölüme ait olduğuna karar ver — düz menüye eklemek YASAK
(kullanıcının orijinal şikayeti: "menüler çok karışık"). `SECTIONS` dizisine tab olarak ekle,
`AppInner.renderTab()`'a case ekle, `i18n.ts`'e `nav.<view>` key'i ekle.

## Kod sözleşmeleri (değişmez)

- `src/api.ts` REST istemcisi ve tüm endpoint route'ları AYNEN korunur (token localStorage, 401
  → TokenGate akışı). Yeni alan eklemek serbest (bkz. `ProjectMap.architecture/modules/...`).
- `src/i18n.ts` — tüm kullanıcı metinleri buradan (`t("...")`). Sabit Türkçe/İngilizce string
  component içine YAZMA. **EN varsayılan** (kullanıcı kararı, 2026-07-13 — Türkçe karakterler
  sorun çıkarıyordu); `<html lang>` senkronu i→İ text-transform koruması için ayrıca korunur
  (yukarıdaki madde) — TR seçildiğinde de doğru büyük harfe dönüşüm garanti edilir.
- `vite.config.ts`'teki proxy ayarını değiştirmeden önce oku — backend'in nasıl serve edildiğini
  etkiler.
- `npm run build` (`tsc -b && vite build`) ve `npm run lint` (oxlint) her değişiklikten sonra
  hatasız geçmeli.
