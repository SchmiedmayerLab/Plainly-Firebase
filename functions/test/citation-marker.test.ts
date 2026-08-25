//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  CITATION_DELIMITER,
  CITATION_START,
  CITATION_STOP,
  extractCitations,
  stripStrayMarkerCharacters,
} from "../src/services/chat/citation-marker";

const cite = (sourceId: string, locator?: string) =>
  CITATION_START + "cite" + CITATION_DELIMITER + sourceId +
  (locator ? CITATION_DELIMITER + locator : "") + CITATION_STOP;

describe("extractCitations", () => {
  it("leaves text without a marker exactly as it was", () => {
    const result = extractCitations("Fusion improves function at two years.");
    assert.equal(result.text, "Fusion improves function at two years.");
    assert.deepEqual(result.citations, []);
  });

  it("removes a marker and reports where it stood", () => {
    const result = extractCitations(`Fusion helps.${cite("sabc12345c7")} Rest does too.`);

    assert.equal(result.text, "Fusion helps. Rest does too.");
    assert.deepEqual(result.citations, [{sourceId: "sabc12345c7", index: 13}]);
    // The index points just past the sentence the citation followed.
    assert.equal(result.text.slice(0, result.citations[0].index), "Fusion helps.");
  });

  it("keeps the guide's optional locator segment", () => {
    const result = extractCitations(`Claim.${cite("sabc12345c7", "L8-L13")}`);
    assert.deepEqual(result.citations, [
      {sourceId: "sabc12345c7", locator: "L8-L13", index: 6},
    ]);
  });

  it("reads several markers stacked after one claim", () => {
    const result = extractCitations(`Claim.${cite("one")}${cite("two")} Next.`);

    assert.equal(result.text, "Claim. Next.");
    assert.deepEqual(
      result.citations.map((citation) => [citation.sourceId, citation.index]),
      [["one", 6], ["two", 6]],
    );
  });

  it("keeps offsets right when several markers are spread through the text", () => {
    const result = extractCitations(`One.${cite("a")} Two.${cite("b")} Three.`);

    assert.equal(result.text, "One. Two. Three.");
    assert.equal(result.text.slice(0, result.citations[0].index), "One.");
    assert.equal(result.text.slice(0, result.citations[1].index), "One. Two.");
  });

  it("strips a marker it cannot trust rather than showing it to a reader", () => {
    const malformed = CITATION_START + "cite" + CITATION_DELIMITER + "not a valid id" +
      CITATION_STOP;
    const wrongFamily = CITATION_START + "quote" + CITATION_DELIMITER + "sabc12345c7" +
      CITATION_STOP;

    for (const raw of [malformed, wrongFamily]) {
      const result = extractCitations(`Claim.${raw} Next.`);
      assert.equal(result.text, "Claim. Next.");
      assert.deepEqual(result.citations, []);
    }
  });

  it("removes a control character that is not part of a marker at all", () => {
    const result = extractCitations(`Claim.${CITATION_START} Next.${CITATION_STOP}`);
    assert.equal(result.text, "Claim. Next.");
    assert.deepEqual(result.citations, []);
  });

  it("strips every marker character on request", () => {
    assert.equal(stripStrayMarkerCharacters(`a${cite("one")}b`), "aciteoneb");
  });
});
