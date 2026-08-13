//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {ComposedChunkingStrategy} from "../src/services/chunking/composed-chunking-strategy";
import {FileChunkingStrategy} from "../src/services/chunking/chunking-strategy";
import {TextChunker} from "../src/services/chunking/text-chunking/text-chunker";
import {TextExtractor} from "../src/services/chunking/text-extraction/text-extractor";
import {ChunkEmbedding, ContextStore} from "../src/services/context/context-store";
import {EmbeddingService} from "../src/services/embedding/embedding-service";
import {DefaultIndexingService} from "../src/services/indexing/default-indexing-service";

describe("ComposedChunkingStrategy", () => {
  it("chunks every extracted segment in document order", async () => {
    const extractor: TextExtractor = {
      extract: async () => ({segments: ["first", "second"]}),
    };
    const chunker: TextChunker = {
      chunk: (text) => [text, `${text}-continued`],
    };

    const chunks = await new ComposedChunkingStrategy(extractor, chunker)
      .chunkFile("document.txt");

    assert.deepEqual(chunks, [
      {text: "first", metadata: undefined},
      {text: "first-continued", metadata: undefined},
      {text: "second", metadata: undefined},
      {text: "second-continued", metadata: undefined},
    ]);
  });

  it("attaches the extracted document metadata to every chunk", async () => {
    const metadata = {title: "Lumbar Fusion Outcomes", author: "J. Smith"};
    const extractor: TextExtractor = {
      extract: async () => ({segments: ["first"], metadata}),
    };
    const chunker: TextChunker = {
      chunk: (text) => [text],
    };

    const chunks = await new ComposedChunkingStrategy(extractor, chunker)
      .chunkFile("document.pdf");

    assert.deepEqual(chunks, [{text: "first", metadata}]);
  });
});

describe("DefaultIndexingService", () => {
  const chunks = [{text: "first"}, {text: "second"}];
  const chunkingStrategy: FileChunkingStrategy = {
    chunkFile: async () => chunks,
  };
  const embeddings = [[1, 2], [3, 4]];
  const embeddingService: EmbeddingService = {
    embed: async () => embeddings[0],
    embedBatch: async () => embeddings,
  };

  it("stores each chunk with its corresponding embedding", async (context) => {
    context.mock.method(console, "log", () => undefined);
    let storedFilename: string | undefined;
    let storedChunks: ChunkEmbedding[] | undefined;
    const contextStore: ContextStore = {
      retrieve: async () => [],
      delete: async () => undefined,
      store: async (filename, indexedChunks) => {
        storedFilename = filename;
        storedChunks = indexedChunks;
      },
    };
    const service = new DefaultIndexingService(
      chunkingStrategy,
      embeddingService,
      contextStore,
    );

    const result = await service.index("/tmp/upload", "study.txt");

    assert.deepEqual(result, {success: true, chunksIndexed: 2});
    assert.equal(storedFilename, "study.txt");
    assert.deepEqual(storedChunks, [
      {text: "first", embedding: [1, 2], metadata: undefined},
      {text: "second", embedding: [3, 4], metadata: undefined},
    ]);
  });

  it("passes each chunk's metadata through to the stored embedding", async (context) => {
    context.mock.method(console, "log", () => undefined);
    const metadata = {title: "Lumbar Fusion Outcomes"};
    const metadataChunkingStrategy: FileChunkingStrategy = {
      chunkFile: async () => [{text: "first", metadata}],
    };
    const singleEmbeddingService: EmbeddingService = {
      embed: async () => embeddings[0],
      embedBatch: async () => [embeddings[0]],
    };
    let storedChunks: ChunkEmbedding[] | undefined;
    const contextStore: ContextStore = {
      retrieve: async () => [],
      delete: async () => undefined,
      store: async (_filename, indexedChunks) => {
        storedChunks = indexedChunks;
      },
    };
    const service = new DefaultIndexingService(
      metadataChunkingStrategy,
      singleEmbeddingService,
      contextStore,
    );

    await service.index("/tmp/upload", "study.pdf");

    assert.deepEqual(storedChunks, [{text: "first", embedding: [1, 2], metadata}]);
  });

  it("does not store partially embedded documents", async (context) => {
    context.mock.method(console, "log", () => undefined);
    context.mock.method(console, "error", () => undefined);
    let storeCalled = false;
    const incompleteEmbeddingService: EmbeddingService = {
      embed: async () => embeddings[0],
      embedBatch: async () => [embeddings[0]],
    };
    const contextStore: ContextStore = {
      retrieve: async () => [],
      delete: async () => undefined,
      store: async () => {
        storeCalled = true;
      },
    };
    const service = new DefaultIndexingService(
      chunkingStrategy,
      incompleteEmbeddingService,
      contextStore,
    );

    const result = await service.index("/tmp/upload", "study.txt");

    assert.equal(storeCalled, false);
    assert.deepEqual(result, {
      success: false,
      chunksIndexed: 0,
      error: "Expected 2 embeddings, received 1",
    });
  });
});
