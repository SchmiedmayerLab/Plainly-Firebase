//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import assert from "node:assert/strict";
import {before, describe, it} from "node:test";
import {getApps, initializeApp} from "firebase-admin/app";
import {createAI, createChatService, createIndexingService} from "../src/services/create-services";

const options = {
  studyId: "study",
  openAIApiKey: "test-key",
};

const customBaseUrlOptions = {
  ...options,
  openAIBaseUrl: "https://openai.example.com/v1",
};

describe("createAI", () => {
  it("uses the openAI plugin when no base URL is configured", () => {
    const {embedder} = createAI(options);

    assert.equal(embedder.name, "openai/text-embedding-ada-002");
  });

  it("resolves embedders and models from a custom base URL", async () => {
    const {ai, embedder} = createAI(customBaseUrlOptions);

    assert.equal(embedder.name, "customOpenAI/text-embedding-ada-002");
    assert.ok(await ai.registry.lookupAction("/embedder/customOpenAI/text-embedding-ada-002"));
    assert.ok(await ai.registry.lookupAction("/model/customOpenAI/gpt-4o-mini"));
  });
});

describe("createChatService", () => {
  before(() => {
    if (getApps().length === 0) {
      initializeApp({projectId: "demo-plainly"});
    }
  });

  it("returns a mocked service when a mock response is configured", async () => {
    const service = createChatService(options, "Mocked response.");

    const result = await service.chatNonStreaming({
      model: "gpt-4o-mini",
      messages: [{role: "user", content: "Hello"}],
      stream: false,
    });

    assert.match(result, /Mocked response\./);
  });

  it("creates a service without interceptors when RAG is disabled", () => {
    const service = createChatService(options, undefined);

    assert.equal(service.interceptors.length, 0);
  });

  it("adds the agentic context interceptor when RAG is enabled", () => {
    const service = createChatService({...customBaseUrlOptions, ragEnabled: true}, undefined);

    assert.equal(service.interceptors.length, 1);
  });
});

describe("createIndexingService", () => {
  before(() => {
    if (getApps().length === 0) {
      initializeApp({projectId: "demo-plainly"});
    }
  });

  it("creates an indexing service for a custom base URL", () => {
    assert.ok(createIndexingService(customBaseUrlOptions));
  });
});
