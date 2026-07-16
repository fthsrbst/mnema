import { z } from "zod";
import { addDocument, getDocument, listDocuments, updateDocumentMeta, type DocumentListItem } from "./documents.js";

export const PROFESSIONAL_PROFILE_URI = "profiles/fatih-serbest/canonical";
export const LEGACY_PROFESSIONAL_PROFILE_URI = "professional-profile/canonical/profile";

export const professionalProfileInputSchema = z
  .object({
    markdown: z.string().trim().min(100).max(100_000),
    title: z.string().trim().min(1).max(300).optional(),
    source: z.string().trim().min(1).max(200).optional(),
    language: z.string().trim().min(2).max(35).optional(),
  })
  .strict();

export interface ProfessionalProfileDocument {
  id: number;
  uid: string;
  title: string;
  uri: string;
  source: string | null;
  language: string | null;
  updated_at: string;
  markdown: string;
}

export interface ProfessionalProfileBundle {
  canonical: ProfessionalProfileDocument | null;
  sources: Pick<DocumentListItem, "id" | "uid" | "title" | "uri" | "language" | "updated_at">[];
}

function reconstructMarkdown(
  chunks: { heading: string | null; text: string }[]
): string {
  return chunks
    .map((chunk) => {
      if (!chunk.heading) return chunk.text;
      const heading = chunk.heading.split(" > ").at(-1) ?? chunk.heading;
      return `## ${heading}\n\n${chunk.text}`;
    })
    .join("\n\n");
}

function documentToProfile(id: number): ProfessionalProfileDocument | null {
  const document = getDocument(id);
  if (!document?.uri) return null;
  return {
    id: document.id,
    uid: document.uid,
    title: document.title,
    uri: document.uri,
    source: document.source,
    language: document.language,
    updated_at: document.updated_at,
    markdown: reconstructMarkdown(document.chunks),
  };
}

/**
 * Professional identity is a global profile, not a project map. It remains in
 * the document authority so source CVs, provenance, lifecycle, search, and sync
 * continue to use Mnema's existing knowledge path.
 */
export function getProfessionalProfile(): ProfessionalProfileBundle {
  const documents = listDocuments(undefined, 500);
  const canonicalMeta =
    documents.find((document) => document.uri === PROFESSIONAL_PROFILE_URI) ??
    documents.find((document) => document.uri === LEGACY_PROFESSIONAL_PROFILE_URI);
  const sources = documents
    .filter((document) =>
      Boolean(
        document.uri &&
          (document.uri.startsWith("profiles/fatih-serbest/source/") ||
            document.uri.startsWith("professional-profile/source/"))
      )
    )
    .map(({ id, uid, title, uri, language, updated_at }) => ({ id, uid, title, uri, language, updated_at }));
  return {
    canonical: canonicalMeta ? documentToProfile(canonicalMeta.id) : null,
    sources,
  };
}

export async function upsertProfessionalProfile(input: {
  markdown: string;
  title?: string;
  source?: string;
  language?: string;
}): Promise<ProfessionalProfileBundle> {
  const value = professionalProfileInputSchema.parse(input);
  const result = await addDocument({
    title: value.title ?? "Fatih Serbest - Canonical Professional Profile",
    text: value.markdown,
    source: value.source ?? "professional-profile",
    uri: PROFESSIONAL_PROFILE_URI,
    kind: "reference",
    language: value.language ?? "en",
    is_current: true,
  });
  // Defend against a future URI migration accidentally inheriting a project.
  updateDocumentMeta(result.document_id, { project: null });
  return getProfessionalProfile();
}
