// Hub'da saklanan içerik (hafıza gövdesi, oturum özeti, RAG chunk metni, proje özeti/kararları)
// markdown formatında geliyor. Astryx'in Markdown bileşeni kaldırıldığı için burada bağımsız,
// küçük bir markdown->React dönüştürücü var: başlık, liste, kod bloğu/satır içi kod, alıntı,
// bağlantı, kalın/italik. Karmaşık GFM tabloları hedeflenmiyor (içerik basit metin).
import type { ReactNode } from "react";

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let i = 0;
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)]+)\)/;
  while (rest.length > 0) {
    const m = pattern.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    if (m[1] !== undefined) {
      out.push(
        <code key={`${keyPrefix}-${i++}`} style={{ background: "var(--bg-inset)", border: "1px solid var(--border)", padding: "1px 5px", fontSize: "0.92em" }}>
          {m[1]}
        </code>
      );
    } else if (m[2] !== undefined) {
      out.push(<strong key={`${keyPrefix}-${i++}`}>{m[2]}</strong>);
    } else if (m[3] !== undefined) {
      out.push(<em key={`${keyPrefix}-${i++}`}>{m[3]}</em>);
    } else if (m[4] !== undefined) {
      out.push(
        <a key={`${keyPrefix}-${i++}`} href={m[5]} target="_blank" rel="noreferrer">
          {m[4]}
        </a>
      );
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

interface MarkdownProps {
  children: string;
  headingLevelStart?: 1 | 2 | 3 | 4 | 5 | 6;
}

export function Markdown({ children, headingLevelStart = 4 }: MarkdownProps) {
  const lines = (children ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    // kod bloğu
    if (line.trim().startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        code.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(
        <pre key={key++} style={{ background: "var(--bg-inset)", border: "1px solid var(--border)", padding: "10px 12px", overflowX: "auto", fontSize: 12 }}>
          <code>{code.join("\n")}</code>
        </pre>
      );
      continue;
    }

    // başlık
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const depth = Math.min(6, heading[1].length + headingLevelStart - 1) as 1 | 2 | 3 | 4 | 5 | 6;
      const Tag = `h${depth}` as const;
      blocks.push(<Tag key={key++} style={{ fontSize: depth <= 3 ? 15 : 13, marginTop: 4 }}>{renderInline(heading[2], `h${key}`)}</Tag>);
      i++;
      continue;
    }

    // alıntı
    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote key={key++} style={{ borderLeft: "2px solid var(--border-strong)", margin: 0, paddingLeft: 12, color: "var(--fg-dim)" }}>
          {quoteLines.join(" ")}
        </blockquote>
      );
      continue;
    }

    // liste (- veya * veya numaralı)
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const isOrdered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]))) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, "").replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      const ListTag = isOrdered ? "ol" : "ul";
      blocks.push(
        <ListTag key={key++} style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 3 }}>
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it, `li-${key}-${idx}`)}</li>
          ))}
        </ListTag>
      );
      continue;
    }

    // paragraf: boş satıra kadar birleştir
    const paraLines: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,6})\s+/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) && !lines[i].trim().startsWith("```")) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push(<p key={key++}>{renderInline(paraLines.join(" "), `p-${key}`)}</p>);
  }

  return <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13, lineHeight: 1.6 }}>{blocks}</div>;
}
