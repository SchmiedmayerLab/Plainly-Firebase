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
import OpenAI from "openai";
import {emulatorMockChatResponse} from "../src/env";
import {
  createChatService,
  createContextStore,
  createIndexingService,
} from "../src/services/create-services";
import {ChatBody, ChatService} from "../src/services/chat/chat-service";
import {createMockOpenAIClient} from "../src/services/chat/mock-openai-client";

const response = "Plainly Firebase end-to-end response.";

function requestWithArraySchema(
  constraints: Record<string, unknown>,
): ChatBody {
  return {
    model: "test-model",
    messages: [{role: "user", content: "Hello"}],
    stream: false,
    tools: [{
      type: "function",
      function: {
        name: "get_resources",
        description: "Retrieve health resources.",
        parameters: {
          type: "object",
          properties: {
            resourceCategories: {
              type: "array",
              items: {type: "string"},
              ...constraints,
            },
          },
          required: ["resourceCategories"],
        },
      },
    }],
  };
}

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
    const service = new ChatService("test-key", [], createMockOpenAIClient(response));

    const result = JSON.parse(await service.chatNonStreaming({
      model: "test-model",
      messages: [{role: "user", content: "Hello"}],
      stream: false,
    }));

    assert.equal(result.object, "chat.completion");
    assert.equal(result.choices[0].message.content, response);
  });

  it("returns OpenAI-compatible streaming chunks", async () => {
    const service = new ChatService("test-key", [], createMockOpenAIClient(response));
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

    const content = chunks
      .slice(0, -2)
      .map((chunk) => JSON.parse(chunk.slice(6)).choices[0].delta.content)
      .join("");
    assert.equal(content, response);
    assert.equal(JSON.parse(chunks.at(-2)?.slice(6) ?? "").choices[0].finish_reason, "stop");
    assert.equal(chunks.at(-1), "data: [DONE]\n\n");
  });

  it("accepts production-compatible array constraints", async () => {
    const service = new ChatService("test-key", [], createMockOpenAIClient(response));

    const result = await service.chatNonStreaming(requestWithArraySchema({
      minItems: 1,
      maxItems: 250,
      uniqueItems: true,
    }));

    assert.equal(JSON.parse(result).choices[0].message.content, response);
  });

  for (const [keyword, expectedType] of [
    ["minItems", "integer"],
    ["maxItems", "integer"],
    ["uniqueItems", "boolean"],
  ] as const) {
    it(`rejects a null ${keyword} constraint like OpenAI`, async () => {
      const service = new ChatService("test-key", [], createMockOpenAIClient(response));

      await assert.rejects(
        () => service.chatNonStreaming(requestWithArraySchema({[keyword]: null})),
        (error: unknown) => {
          assert.ok(error instanceof OpenAI.BadRequestError);
          assert.equal(error.code, "invalid_function_parameters");
          assert.equal(error.param, "tools[0].function.parameters");
          assert.match(error.message, new RegExp(`must be ${expectedType}`));
          return true;
        },
      );
    });
  }

  it("rejects an empty enum like OpenAI", async () => {
    const service = new ChatService("test-key", [], createMockOpenAIClient(response));

    await assert.rejects(
      () => service.chatNonStreaming(requestWithArraySchema({
        items: {type: "string", enum: []},
      })),
      (error: unknown) => {
        assert.ok(error instanceof OpenAI.BadRequestError);
        assert.equal(error.code, "invalid_function_parameters");
        assert.equal(error.param, "tools[0].function.parameters");
        assert.match(error.message, /must NOT have fewer than 1 items/);
        return true;
      },
    );
  });

  it("can return a production-shaped API failure", async () => {
    const service = new ChatService(
      "test-key",
      [],
      createMockOpenAIClient(response, {rejectRequest: true}),
    );

    await assert.rejects(
      () => service.chatNonStreaming(requestWithArraySchema({minItems: 1, maxItems: 250, uniqueItems: true})),
      OpenAI.BadRequestError,
    );
  });
});
