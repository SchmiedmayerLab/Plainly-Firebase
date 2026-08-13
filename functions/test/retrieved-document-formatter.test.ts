//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {RetrievedDocumentFormatter} from "../src/services/chat/retrieved-document-formatter";
import {RetrievedDocument} from "../src/services/context/context-store";

describe("RetrievedDocumentFormatter", () => {
  it("returns an empty string for no documents", () => {
    assert.equal(new RetrievedDocumentFormatter().format([]), "");
  });

  it("falls back to the plain header when a document has no metadata", () => {
    const docs: RetrievedDocument[] = [
      {text: "Some evidence", file: "notes.txt", distance: 0.2, chunkId: 0},
    ];

    assert.equal(
      new RetrievedDocumentFormatter().format(docs),
      "[Document: notes.txt | Chunk 0]\nSome evidence",
    );
  });

  it("includes only the configured metadata fields, in order", () => {
    const docs: RetrievedDocument[] = [
      {
        text: "Fusion improves outcomes.",
        file: "guideline.pdf",
        distance: 0.1,
        chunkId: 4,
        metadata: {
          title: "Lumbar Fusion Outcomes",
          author: "J. Smith",
          publisher: "Spine Journal",
          year: 2021,
          subject: "Orthopedics",
        },
      },
    ];

    assert.equal(
      new RetrievedDocumentFormatter().format(docs),
      "[Document: guideline.pdf | Title: Lumbar Fusion Outcomes | Author: J. Smith | " +
        "Publisher: Spine Journal | Year: 2021 | Chunk 4]\nFusion improves outcomes.",
    );
  });

  it("omits absent fields and joins multiple documents with a separator", () => {
    const docs: RetrievedDocument[] = [
      {text: "First", file: "a.pdf", distance: 0.1, chunkId: 0, metadata: {title: "A"}},
      {text: "Second", file: "b.pdf", distance: 0.2, chunkId: 1},
    ];

    assert.equal(
      new RetrievedDocumentFormatter().format(docs),
      "[Document: a.pdf | Title: A | Chunk 0]\nFirst\n\n---\n\n[Document: b.pdf | Chunk 1]\nSecond",
    );
  });

  it("surfaces a caller-supplied subset of metadata fields instead of the default", () => {
    const docs: RetrievedDocument[] = [
      {
        text: "Fusion improves outcomes.",
        file: "guideline.pdf",
        distance: 0.1,
        chunkId: 4,
        metadata: {title: "Lumbar Fusion Outcomes", subject: "Orthopedics"},
      },
    ];
    const formatter = new RetrievedDocumentFormatter([{key: "subject", label: "Subject"}]);

    assert.equal(
      formatter.format(docs),
      "[Document: guideline.pdf | Subject: Orthopedics | Chunk 4]\nFusion improves outcomes.",
    );
  });
});
