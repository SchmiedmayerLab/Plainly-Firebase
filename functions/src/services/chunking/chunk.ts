//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {DocumentMetadata} from "./text-extraction/document-metadata";

/** A text chunk extracted from a document. */
export interface Chunk {
  text: string;
  metadata?: DocumentMetadata;
}
