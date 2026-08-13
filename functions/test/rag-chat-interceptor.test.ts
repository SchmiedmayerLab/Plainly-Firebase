//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {RAGChatInterceptor} from "../src/services/chat/rag-chat-interceptor";
import {ChatBody} from "../src/services/chat/chat-service";
import {ContextStore, RetrievedDocument} from "../src/services/context/context-store";

const request: ChatBody = {
  model: "test-model",
  messages: [
    {role: "system", content: "Answer with the available evidence."},
    {role: "user", content: "What are my treatment options?"},
  ],
  stream: false,
};

describe("RAGChatInterceptor", () => {
  it("queries with the last user message and injects the retrieved context", async (context) => {
    context.mock.method(console, "log", () => undefined);
    let receivedQuery: string | undefined;
    let receivedLimit: number | undefined;
    const docs: RetrievedDocument[] = [
      {
        text: "Fusion improves outcomes.",
        file: "guideline.pdf",
        distance: 0.1,
        chunkId: 4,
        metadata: {title: "Lumbar Fusion Outcomes", author: "J. Smith", year: 2021},
      },
    ];
    const contextStore: ContextStore = {
      retrieve: async (query, limit) => {
        receivedQuery = query;
        receivedLimit = limit;
        return docs;
      },
      store: async () => undefined,
      delete: async () => undefined,
    };
    const interceptor = new RAGChatInterceptor(contextStore);

    const result = await interceptor.intercept(request);

    assert.equal(receivedQuery, "What are my treatment options?");
    assert.equal(receivedLimit, 10);
    assert.equal(result.messages.at(-1)?.role, "user");
    assert.match(
      String(result.messages.at(-2)?.content),
      /\[Document: guideline\.pdf \| Title: Lumbar Fusion Outcomes \| Author: J\. Smith \| Year: 2021 \| Chunk 4\]/,
    );
  });

  it("skips context injection when the last message is not from the user", async (context) => {
    context.mock.method(console, "warn", () => undefined);
    let retrieveCalled = false;
    const contextStore: ContextStore = {
      retrieve: async () => {
        retrieveCalled = true;
        return [];
      },
      store: async () => undefined,
      delete: async () => undefined,
    };
    const interceptor = new RAGChatInterceptor(contextStore);
    const assistantLastRequest: ChatBody = {
      ...request,
      messages: [...request.messages, {role: "assistant", content: "Here's some info."}],
    };

    const result = await interceptor.intercept(assistantLastRequest);

    assert.equal(result, assistantLastRequest);
    assert.equal(retrieveCalled, false);
  });

  it("returns the original body unchanged when no context is found", async (context) => {
    context.mock.method(console, "log", () => undefined);
    const contextStore: ContextStore = {
      retrieve: async () => [],
      store: async () => undefined,
      delete: async () => undefined,
    };
    const interceptor = new RAGChatInterceptor(contextStore);

    const result = await interceptor.intercept(request);

    assert.deepEqual(result, request);
  });

  it("continues without context when retrieval fails", async (context) => {
    context.mock.method(console, "error", () => undefined);
    const contextStore: ContextStore = {
      retrieve: async () => {
        throw new Error("Firestore unavailable");
      },
      store: async () => undefined,
      delete: async () => undefined,
    };
    const interceptor = new RAGChatInterceptor(contextStore);

    const result = await interceptor.intercept(request);

    assert.deepEqual(result, request);
  });
});
