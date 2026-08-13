//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {DocumentMetadata} from "../chunking/text-extraction/document-metadata";

/** A document retrieved from the context store. */
export interface RetrievedDocument {
  text: string;
  file: string;
  distance: number | null;
  chunkId: number;
  metadata?: DocumentMetadata;
}

export interface ChunkEmbedding {
  text: string;
  embedding: number[] | null;
  metadata?: DocumentMetadata;
}

export interface ContextStore {
  retrieve(query: string, limit: number): Promise<RetrievedDocument[]>;
  store(filename: string, chunks: ChunkEmbedding[]): Promise<void>;
  delete(filename: string): Promise<void>;
}
