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
import {PlainTextExtractor} from "../src/services/chunking/text-extraction/plain-text-extractor";
import {TextExtractor} from "../src/services/chunking/text-extraction/text-extractor";

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

    assert.deepEqual(result, ["Full-width: A value here\n\nNext"]);
  });

  it("dispatches case-insensitive file extensions to the configured extractor", async () => {
    let receivedPath: string | undefined;
    const extractor: TextExtractor = {
      extract: async (filePath) => {
        receivedPath = filePath;
        return ["content"];
      },
    };
    const dispatcher = new DispatchingTextExtractor({".txt": extractor});

    assert.deepEqual(await dispatcher.extract("Study.TXT"), ["content"]);
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
