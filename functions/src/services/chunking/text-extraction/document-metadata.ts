//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

/**
 * Document metadata extracted from a source file, e.g. a PDF's Info
 * dictionary. Standard fields are named explicitly; any additional
 * (non-standard) fields the source document carries are preserved under
 * their own key.
 */
export interface DocumentMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  /** ISO 8601 */
  creationDate?: string;
  /** ISO 8601 */
  modDate?: string;
  /** Where the document can be read, e.g. a publisher's landing page. */
  url?: string;
  /** Explicit custom "year"/"Year" field wins; otherwise derived from creationDate. */
  year?: number;
  [customKey: string]: unknown;
}
