import { defineTheme } from "@astryxdesign/core/theme";

/**
 * RevenueX teması — "sıcak cam panel" (warm glassmorphism) tasarım dili.
 * Krem-amber palet, serif+sans karışımı, cam efektli editoryal görünüm.
 * Token çiftleri [light, dark] formatında; dark karşılıklar tasarım
 * rehberindeki eşlemeden gelir (amber gradyan iki modda da aynı).
 */
export const revenueXTheme = defineTheme({
  name: "revenuex",
  typography: {
    body: { family: "Inter", fallbacks: "-apple-system, 'Segoe UI', sans-serif" },
    heading: { family: "Inter", fallbacks: "-apple-system, 'Segoe UI', sans-serif" },
  },
  tokens: {
    // Zemin / yüzeyler
    "--color-background-body": ["#F6F2EC", "#1C1917"],
    "--color-background-surface": ["#FBF8F3", "#26211D"],
    "--color-background-card": ["rgba(255, 255, 255, 0.65)", "rgba(38, 33, 29, 0.65)"],
    "--color-background-muted": ["rgba(246, 242, 236, 0.6)", "rgba(30, 26, 22, 0.6)"],
    "--color-background-popover": ["#FBF8F3", "#26211D"],

    // Metin — sıcak tonlu, neredeyse siyah
    "--color-text-primary": ["#1A1815", "#FBF8F3"],
    "--color-text-secondary": ["#6B6560", "#A89F94"],
    "--color-text-disabled": ["#9C958C", "#6B6560"],
    "--color-icon-primary": ["#1A1815", "#FBF8F3"],
    "--color-icon-secondary": ["#6B6560", "#A89F94"],

    // Vurgu: amber-altın; tek "canlı" renk: sage-green (durum/onay)
    "--color-accent": ["#E89A3C", "#E89A3C"],
    "--color-accent-muted": ["#F3D9A8", "#6B4A16"],
    "--color-on-accent": ["#FFFFFF", "#1A1815"],
    "--color-success": ["#7FAF52", "#7FAF52"],
    "--color-success-muted": ["#E4EEDA", "#3A5A28"],

    // Kenarlık / gölge — yumuşak, sıcak
    "--color-border": ["rgba(26, 24, 21, 0.08)", "rgba(251, 248, 243, 0.1)"],
    "--color-border-emphasized": ["rgba(26, 24, 21, 0.16)", "rgba(251, 248, 243, 0.2)"],
    "--shadow-low": [
      "0 8px 24px -12px rgba(60, 40, 10, 0.15)",
      "0 8px 24px -12px rgba(0, 0, 0, 0.5)",
    ],
    "--shadow-med": [
      "0 16px 40px -16px rgba(60, 40, 10, 0.2)",
      "0 16px 40px -16px rgba(0, 0, 0, 0.55)",
    ],
    "--shadow-high": [
      "0 24px 60px -20px rgba(60, 40, 10, 0.25)",
      "0 24px 60px -20px rgba(0, 0, 0, 0.6)",
    ],

    // Köşe yarıçapı hiyerarşisi: panel 28 > kart 20 > kontrol 12
    "--radius-inner": "8px",
    "--radius-element": "12px",
    "--radius-container": "20px",
    "--radius-page": "28px",

    // Sayfa başlığı: büyük, normal ağırlıklı serif (editoryal his)
    "--text-heading-3-size": "32px",
    "--text-heading-3-weight": "400",
    "--text-heading-3-leading": "1.15",
  },
  components: {
    card: {
      base: {
        borderRadius: "20px",
        borderColor: "rgba(255, 255, 255, 0.4)",
        boxShadow: "var(--shadow-low)",
      },
    },
    button: {
      base: { borderRadius: "12px" },
    },
  },
});
