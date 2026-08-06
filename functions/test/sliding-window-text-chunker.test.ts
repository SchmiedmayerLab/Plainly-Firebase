//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {SlidingWindowTextChunker} from "../src/services/chunking/text-chunking/sliding-window-text-chunker";

describe("SlidingWindowTextChunker", () => {
  it("returns no chunks for empty input", () => {
    assert.deepEqual(new SlidingWindowTextChunker().chunk(""), []);
  });

  it("trims a short input into one chunk", () => {
    assert.deepEqual(
      new SlidingWindowTextChunker().chunk("  Plainly context  "),
      ["Plainly context"],
    );
  });

  it("preserves the configured overlap between windows", () => {
    const chunks = new SlidingWindowTextChunker(5, 2).chunk("abcdefgh");

    assert.deepEqual(chunks, ["abcde", "defgh", "gh"]);
    assert.equal(chunks[0].slice(-2), chunks[1].slice(0, 2));
    assert.equal(chunks[1].slice(-2), chunks[2]);
  });

  it("rejects invalid window configurations", () => {
    assert.throws(
      () => new SlidingWindowTextChunker(0, 0),
      /maxLength must be greater than 0/,
    );
    assert.throws(
      () => new SlidingWindowTextChunker(10, -1),
      /overlap must be non-negative/,
    );
    assert.throws(
      () => new SlidingWindowTextChunker(10, 10),
      /maxLength must be greater than overlap/,
    );
  });
});
