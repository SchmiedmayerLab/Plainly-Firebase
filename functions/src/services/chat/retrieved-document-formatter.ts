//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {DocumentMetadata} from "../chunking/text-extraction/document-metadata";
import {RetrievedDocument} from "../context/context-store";
import {stripStrayMarkerCharacters} from "./citation-marker";
import {citationSourceId} from "./citation-source";

export interface ChunkTitleField {
  key: string;
  label: string;
}

/**
 * Formats retrieved documents into the text injected as RAG context, and into the reference a
 * reader sees under an answer.
 *
 * Each chunk becomes a `<citable>` block, following OpenAI's citation-formatting guide: the block's
 * id is what the model writes in a marker, and the marker is what becomes an annotation on the way
 * back out.
 *
 * The constructor's `titleFields` controls which metadata is surfaced in the `[...]` header of each
 * chunk. All extracted metadata is stored in Firestore regardless of this list — it only limits
 * what the model sees.
 */
export class RetrievedDocumentFormatter {
  private static readonly DEFAULT_TITLE_FIELDS: ChunkTitleField[] = [
    {key: "title", label: "Title"},
    {key: "author", label: "Author"},
    {key: "publisher", label: "Publisher"},
    {key: "year", label: "Year"},
  ];

  private static readonly MAX_HEADER_VALUE_LENGTH = 200;

  /** The sources list gives a reference one line in summary and two in full, so it cannot run long. */
  private static readonly MAX_CITATION_TITLE_LENGTH = 120;

  constructor(
    private readonly titleFields: ChunkTitleField[] = RetrievedDocumentFormatter.DEFAULT_TITLE_FIELDS,
  ) {}

  format(docs: RetrievedDocument[]): string {
    if (docs.length === 0) return "";
    return docs.map((doc) => {
      const id = citationSourceId(doc.file, doc.chunkId);
      return [
        `<citable id="${id}">`,
        this.formatHeader(doc),
        this.sanitizeBody(doc.text),
        "</citable>",
      ].join("\n");
    }).join("\n\n");
  }

  /**
   * How one document is named where a reader can see it.
   *
   * The metadata is taken as it stands: whoever prepared the corpus wrote these fields, so the
   * author reads the way they wrote it. This only decides the order and the punctuation between
   * the fields, and what to do when one of them is missing.
   */
  citationTitle(doc: RetrievedDocument): string {
    const author = this.metadataText(doc.metadata?.author);
    const title = this.metadataText(doc.metadata?.title);
    const publisher = this.metadataText(doc.metadata?.publisher);
    const year = typeof doc.metadata?.year === "number" ? String(doc.metadata.year) : undefined;
    const fallback = filenameWithoutExtension(doc.file);

    const lead = author ?? title ?? fallback;
    const work = author ? title ?? fallback : undefined;
    const reference = [
      year ? `${lead} (${year})` : lead,
      ...(work ? [` — ${work}`] : []),
      ...(publisher ? [` · ${publisher}`] : []),
    ].join("");
    return truncate(reference, RetrievedDocumentFormatter.MAX_CITATION_TITLE_LENGTH);
  }

  private metadataText(value: DocumentMetadata[string]): string | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    return this.sanitize(String(value)) || undefined;
  }

  private formatHeader(doc: RetrievedDocument): string {
    const parts = [`Document: ${this.sanitize(doc.file)}`];
    for (const {key, label} of this.titleFields) {
      const value = doc.metadata?.[key];
      if (value !== undefined && value !== null && value !== "") {
        parts.push(`${label}: ${this.sanitize(String(value))}`);
      }
    }
    parts.push(`Chunk ${doc.chunkId}`);
    return `[${parts.join(" | ")}]`;
  }

  /** Keeps untrusted filenames/metadata from breaking the single-line `[...]` header format. */
  private sanitize(value: string): string {
    const singleLine = stripStrayMarkerCharacters(value)
      .replace(/[\r\n]+/g, " ")
      .replace(/[[\]|]/g, "")
      .trim();
    return singleLine.length > RetrievedDocumentFormatter.MAX_HEADER_VALUE_LENGTH ?
      `${singleLine.slice(0, RetrievedDocumentFormatter.MAX_HEADER_VALUE_LENGTH)}…` :
      singleLine;
  }

  /**
   * Keeps a chunk's own text from closing its `<citable>` block early or forging a citation.
   *
   * The corpus is uploaded PDFs, so this text is not ours to trust.
   */
  private sanitizeBody(text: string): string {
    return stripStrayMarkerCharacters(text).replace(/<\/\s*citable\s*>/gi, "");
  }
}

/** The last resort, for a document that carries no metadata at all. */
function filenameWithoutExtension(file: string): string {
  const base = file.split("/").pop() ?? file;
  return base.replace(/\.[A-Za-z0-9]{1,5}$/, "");
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value;
}
