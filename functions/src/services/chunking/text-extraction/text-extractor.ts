//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {DocumentMetadata} from "./document-metadata";

/** The result of extracting a file's contents. */
export interface ExtractionResult {
  /**
   * Text segments — for example, one per page or a single merged segment
   * depending on the implementation.
   */
  segments: string[];
  /** Document metadata (e.g. a PDF's Info dictionary), if any is available. */
  metadata?: DocumentMetadata;
}

/**
 * Extracts text content and metadata from a file.
 */
export interface TextExtractor {
  extract(filePath: string): Promise<ExtractionResult>;
}
