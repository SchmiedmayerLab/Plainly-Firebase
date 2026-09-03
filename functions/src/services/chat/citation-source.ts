//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {createHash} from "node:crypto";

/** One retrieved document, as the model cites it and as the client displays it. */
export interface CitationSource {
  /** The identifier the model writes in a marker. */
  id: string;
  /** The stored filename, which becomes a file citation's `file_id`. */
  file: string;
  /** The human-readable reference, which names the source in either kind of annotation. */
  title: string;
  /** Where the document can be read. A source that has one is announced as a `url_citation`. */
  url?: string;
}

/**
 * A stable, charset-legal identifier for one chunk of one document.
 *
 * Derived from the document and chunk rather than from a position in this request's result list.
 * The interceptor re-runs on every tool round trip, and `store: true` keeps the model's earlier
 * markers in its own view of the conversation, so an ordinal would silently re-point at whatever
 * happened to rank third the second time. A content-derived identifier either names a document
 * that is still retrieved, or names nothing at all.
 */
export function citationSourceId(file: string, chunkId: number): string {
  const digest = createHash("sha256").update(file).digest("hex").slice(0, 8);
  return `s${digest}c${chunkId < 0 ? "x" : chunkId}`;
}
