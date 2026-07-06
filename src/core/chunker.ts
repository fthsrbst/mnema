export interface Chunk {
  heading: string | null;
  text: string;
}

const TARGET = 1800; // ~450 token
const MAX = 2400;
const OVERLAP = 200;

/**
 * Markdown-aware chunking: başlıklara göre bölümler, uzun bölümleri
 * paragraf sınırlarından TARGET boyutuna böler; başlık hiyerarşisini korur.
 */
export function chunkMarkdown(text: string): Chunk[] {
  const lines = text.split(/\r?\n/);
  const sections: { heading: string | null; body: string[] }[] = [{ heading: null, body: [] }];
  const headingStack: string[] = [];

  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      const level = m[1].length;
      headingStack.length = level - 1;
      headingStack[level - 1] = m[2].trim();
      sections.push({ heading: headingStack.filter(Boolean).join(" > "), body: [] });
    } else {
      sections[sections.length - 1].body.push(line);
    }
  }

  const chunks: Chunk[] = [];
  for (const sec of sections) {
    const body = sec.body.join("\n").trim();
    if (!body) continue;
    if (body.length <= MAX) {
      chunks.push({ heading: sec.heading, text: body });
      continue;
    }
    // Paragraf sınırlarından böl
    const paras = body.split(/\n\s*\n/);
    let current = "";
    for (const p of paras) {
      if (current && current.length + p.length + 2 > TARGET) {
        chunks.push({ heading: sec.heading, text: current.trim() });
        current = current.slice(-OVERLAP) + "\n\n" + p;
      } else {
        current = current ? current + "\n\n" + p : p;
      }
      // Tek paragraf bile MAX'ı aşıyorsa sert böl
      while (current.length > MAX) {
        chunks.push({ heading: sec.heading, text: current.slice(0, TARGET).trim() });
        current = current.slice(TARGET - OVERLAP);
      }
    }
    if (current.trim()) chunks.push({ heading: sec.heading, text: current.trim() });
  }
  return chunks.filter((c) => c.text.length > 20);
}
