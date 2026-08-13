//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {RetrievedDocument} from "../context/context-store";

export interface ChunkTitleField {
  key: string;
  label: string;
}

/**
 * Formats retrieved documents into the text injected as RAG context.
 *
 * The constructor's `titleFields` controls which metadata is surfaced in the
 * `[...]` header of each chunk. All extracted metadata is stored in Firestore
 * regardless of this list — it only limits what the model sees.
 */
export class RetrievedDocumentFormatter {
  private static readonly DEFAULT_TITLE_FIELDS: ChunkTitleField[] = [
    {key: "title", label: "Title"},
    {key: "author", label: "Author"},
    {key: "publisher", label: "Publisher"},
    {key: "year", label: "Year"},
  ];

  constructor(
    private readonly titleFields: ChunkTitleField[] = RetrievedDocumentFormatter.DEFAULT_TITLE_FIELDS,
  ) {}

  format(docs: RetrievedDocument[]): string {
    if (docs.length === 0) return "";
    return docs.map((doc) => `${this.formatHeader(doc)}\n${doc.text}`).join("\n\n---\n\n");
  }

  private formatHeader(doc: RetrievedDocument): string {
    const parts = [`Document: ${doc.file}`];
    for (const {key, label} of this.titleFields) {
      const value = doc.metadata?.[key];
      if (value !== undefined && value !== null && value !== "") {
        parts.push(`${label}: ${value}`);
      }
    }
    parts.push(`Chunk ${doc.chunkId}`);
    return `[${parts.join(" | ")}]`;
  }
}
