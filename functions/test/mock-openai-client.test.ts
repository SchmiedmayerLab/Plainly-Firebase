//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {deleteApp, getApp, initializeApp} from "firebase-admin/app";
import {emulatorMockChatResponse} from "../src/env";
import {
  createChatService,
  createContextStore,
  createIndexingService,
} from "../src/services/create-services";
import {ChatService} from "../src/services/chat/chat-service";
import {createMockOpenAIClient} from "../src/services/chat/mock-openai-client";

const response = "Plainly Firebase end-to-end response.";

describe("emulator mock guard", () => {
  it("never enables the mock outside the Firebase emulator", () => {
    assert.equal(emulatorMockChatResponse({
      PLAINLY_MOCK_CHAT_RESPONSE: response,
    }), undefined);
  });

  it("returns a configured response inside the Firebase emulator", () => {
    assert.equal(emulatorMockChatResponse({
      FUNCTIONS_EMULATOR: "true",
      PLAINLY_MOCK_CHAT_RESPONSE: `  ${response}  `,
    }), response);
  });
});

describe("mock OpenAI client", () => {
  it("is selected by the service factory when configured", async () => {
    const service = createChatService({
      studyId: "test-study",
      openAIApiKey: "test-key",
      ragEnabled: true,
    }, response);

    const result = JSON.parse(await service.chatNonStreaming({
      model: "test-model",
      messages: [{role: "user", content: "Hello"}],
      stream: false,
    }));

    assert.equal(result.choices[0].message.content, response);
  });

  it("constructs the production service graph", async () => {
    let createdApp = false;
    try {
      getApp();
    } catch {
      initializeApp({projectId: "plainly-service-factory-test"});
      createdApp = true;
    }

    try {
      assert.ok(createContextStore("test-study"));
      assert.ok(createIndexingService({
        studyId: "test-study",
        openAIApiKey: "test-key",
      }));
    } finally {
      if (createdApp) {
        await deleteApp(getApp());
      }
    }
  });

  it("returns an OpenAI-compatible non-streaming completion", async () => {
    const service = new ChatService("test-key", [], undefined, createMockOpenAIClient(response));

    const result = JSON.parse(await service.chatNonStreaming({
      model: "test-model",
      messages: [{role: "user", content: "Hello"}],
      stream: false,
    }));

    assert.equal(result.object, "chat.completion");
    assert.equal(result.choices[0].message.content, response);
  });

  it("returns OpenAI-compatible streaming chunks", async () => {
    const service = new ChatService("test-key", [], undefined, createMockOpenAIClient(response));
    const chunks: string[] = [];

    await service.chatStreaming(
      {
        model: "test-model",
        messages: [{role: "user", content: "Hello"}],
        stream: true,
      },
      async (chunk) => {
        chunks.push(chunk);
        return true;
      },
    );

    assert.equal(JSON.parse(chunks[0].slice(6)).choices[0].delta.content, response);
    assert.equal(JSON.parse(chunks[1].slice(6)).choices[0].finish_reason, "stop");
    assert.equal(chunks[2], "data: [DONE]\n\n");
  });
});
