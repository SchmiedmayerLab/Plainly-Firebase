//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {RetrievedDocument} from "../context/context-store";

/**
 * The subset of a document's metadata surfaced in the `[...]` header of each
 * chunk injected into the conversation. All extracted metadata is stored in
 * Firestore regardless of this list — edit this list to change only what the
 * model sees.
 */
export const CHUNK_TITLE_METADATA_FIELDS: {key: string; label: string}[] = [
  {key: "title", label: "Title"},
  {key: "author", label: "Author"},
  {key: "publisher", label: "Publisher"},
  {key: "year", label: "Year"},
];

export function formatRetrievedDocuments(docs: RetrievedDocument[]): string {
  if (docs.length === 0) return "";
  return docs.map((doc) => `${formatHeader(doc)}\n${doc.text}`).join("\n\n---\n\n");
}

function formatHeader(doc: RetrievedDocument): string {
  const parts = [`Document: ${doc.file}`];
  for (const {key, label} of CHUNK_TITLE_METADATA_FIELDS) {
    const value = doc.metadata?.[key];
    if (value !== undefined && value !== null && value !== "") {
      parts.push(`${label}: ${value}`);
    }
  }
  parts.push(`Chunk ${doc.chunkId}`);
  return `[${parts.join(" | ")}]`;
}
