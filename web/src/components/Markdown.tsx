// Hub'da saklanan içerik (hafıza gövdesi, oturum özeti, RAG chunk metni, proje özeti/kararları)
// markdown formatında. Astryx'in kendi Markdown bileşenini sarmalıyoruz: raw HTML basmıyor
// (kendi parser'ı ile React elemanı üretiyor), başlıklar/liste/tablo/kod bloğu/blockquote/link
// zaten tasarım tokenlarıyla stilleniyor. Bu dosya, detay görünümleri için tek ortak giriş noktası.
import { Markdown as AstryxMarkdown } from "@astryxdesign/core/Markdown";

interface MarkdownProps {
  children: string;
  /** Kart/dialog içine gömülü olduğu için başlıklar sayfa başlığı gibi görünmesin diye varsayılan 3. */
  headingLevelStart?: 1 | 2 | 3 | 4 | 5 | 6;
  density?: "default" | "compact";
}

export function Markdown({ children, headingLevelStart = 3, density = "compact" }: MarkdownProps) {
  return (
    <AstryxMarkdown headingLevelStart={headingLevelStart} density={density}>
      {children}
    </AstryxMarkdown>
  );
}
