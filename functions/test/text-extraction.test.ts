//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import assert from "node:assert/strict";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {after, before, describe, it} from "node:test";
import {DispatchingTextExtractor} from "../src/services/chunking/text-extraction/dispatching-text-extractor";
import {PDFTextExtractor} from "../src/services/chunking/text-extraction/pdf-text-extractor";
import {PlainTextExtractor} from "../src/services/chunking/text-extraction/plain-text-extractor";
import {TextExtractor} from "../src/services/chunking/text-extraction/text-extractor";

const fixturePath = (name: string) => join(__dirname, "fixtures", name);

let testDirectory: string;

before(async () => {
  testDirectory = await mkdtemp(join(tmpdir(), "plainly-text-extraction-"));
});

after(async () => {
  await rm(testDirectory, {recursive: true});
});

describe("text extraction", () => {
  it("normalizes plain text before it is indexed", async () => {
    const filePath = join(testDirectory, "context.txt");
    await writeFile(filePath, "  Full-width: Ａ\u0000  value   here\n\n\nNext  ");

    const result = await new PlainTextExtractor().extract(filePath);

    assert.deepEqual(result, {segments: ["Full-width: A value here\n\nNext"]});
  });

  it("dispatches case-insensitive file extensions to the configured extractor", async () => {
    let receivedPath: string | undefined;
    const extractor: TextExtractor = {
      extract: async (filePath) => {
        receivedPath = filePath;
        return {segments: ["content"]};
      },
    };
    const dispatcher = new DispatchingTextExtractor({".txt": extractor});

    assert.deepEqual(await dispatcher.extract("Study.TXT"), {segments: ["content"]});
    assert.equal(receivedPath, "Study.TXT");
  });

  it("rejects files whose format cannot be extracted", async () => {
    const dispatcher = new DispatchingTextExtractor({});

    await assert.rejects(
      dispatcher.extract("archive.zip"),
      /No extractor registered for file extension "\.zip"/,
    );
  });
});

describe("PDFTextExtractor", () => {
  it("extracts text and standard + custom Info dictionary metadata", async () => {
    const result = await new PDFTextExtractor().extract(fixturePath("with-metadata.pdf"));

    assert.equal(result.segments.length, 1);
    assert.match(result.segments[0], /Hello PDF/);
    assert.deepEqual(result.metadata, {
      title: "Lumbar Fusion Outcomes",
      author: "J. Smith",
      subject: "Orthopedics",
      keywords: "fusion lumbar",
      creator: "pdf-lib (https://github.com/Hopding/pdf-lib)",
      producer: "pdf-lib (https://github.com/Hopding/pdf-lib)",
      creationDate: "2021-03-15T00:00:00.000Z",
      modDate: "2021-06-01T00:00:00.000Z",
      publisher: "Spine Journal",
      year: 2021,
    });
  });

  it("prefers an explicit custom year over the one derived from CreationDate", async () => {
    const result = await new PDFTextExtractor().extract(fixturePath("explicit-year.pdf"));

    assert.equal(result.metadata?.year, 2019);
  });

  it("returns undefined metadata for a PDF with an empty Info dictionary", async () => {
    const result = await new PDFTextExtractor().extract(fixturePath("no-metadata.pdf"));

    assert.equal(result.metadata, undefined);
  });

  it("filters unsafe custom-metadata keys and trims whitespace-only values", () => {
    const extractor = new PDFTextExtractor() as unknown as {
      extractMetadata(info: Record<string, unknown>): Record<string, unknown> | undefined;
    };

    const metadata = extractor.extractMetadata({
      Custom: {
        ["__proto__"]: "evil",
        Constructor: "also evil",
        Publisher: "  Spine Journal  ",
        Empty: "   ",
      },
    });

    assert.deepEqual(metadata, {publisher: "Spine Journal"});
    assert.equal(Object.getPrototypeOf(metadata), Object.prototype);
  });

  it("carries a document's url through as its own field", () => {
    const extractor = new PDFTextExtractor() as unknown as {
      extractMetadata(info: Record<string, unknown>): Record<string, unknown> | undefined;
    };

    // What `scripts/apply-pdf-metadata.ts` writes for the CSV's `url` column. The key is "Url" and
    // not "URL" because only the first letter is lower-cased on the way back out.
    const metadata = extractor.extractMetadata({
      Custom: {Url: "https://example.org/lumbar-fusion-guideline"},
    });

    assert.deepEqual(metadata, {url: "https://example.org/lumbar-fusion-guideline"});
  });
});
