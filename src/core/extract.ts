import path from "node:path";

/** Upload ile kabul edilen uzantılar. */
export const EXTRACTABLE = new Set([".pdf", ".docx", ".md", ".txt", ".mdx", ".rst", ".adoc"]);

/**
 * Dosya içeriğinden düz metin/markdown çıkarır (RAG indeksi için).
 * PDF: unpdf (pdf.js) — taranmış/görüntü PDF'te metin boş dönebilir, o durumda hata verilir
 * ki istemci OCR yoluna yönlensin. DOCX: mammoth markdown dönüşümü. Diğerleri UTF-8 okunur.
 */
export async function extractFileText(buf: Buffer, filename: string): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  if (!EXTRACTABLE.has(ext)) {
    throw new Error(`desteklenmeyen uzantı: ${ext || "(yok)"} — kabul edilenler: ${[...EXTRACTABLE].join(" ")}`);
  }

  let text: string;
  if (ext === ".pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const doc = await getDocumentProxy(new Uint8Array(buf));
    const res = await extractText(doc, { mergePages: true });
    text = res.text;
  } else if (ext === ".docx") {
    const mammoth = await import("mammoth");
    // convertToMarkdown runtime'da var ama tip tanımında yok (mammoth 1.11 .d.ts eksiği)
    const res = await (mammoth as unknown as {
      convertToMarkdown(input: { buffer: Buffer }): Promise<{ value: string }>;
    }).convertToMarkdown({ buffer: buf });
    text = res.value;
  } else {
    text = buf.toString("utf8");
  }

  text = text.trim();
  if (!text) {
    throw new Error(
      "dosyadan metin çıkarılamadı (taranmış/görüntü PDF olabilir) — bir agent'a OCR/vision ile okutup rag_add çağırt"
    );
  }
  return text;
}
