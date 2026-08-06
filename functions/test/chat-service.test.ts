//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import assert from "node:assert/strict";
import {describe, it} from "node:test";
import OpenAI from "openai";
import {ChatInterceptor} from "../src/services/chat/chat-interceptor";
import {ChatBody, ChatService} from "../src/services/chat/chat-service";

const request: ChatBody = {
  model: "test-model",
  messages: [{role: "user", content: "Hello"}],
  stream: false,
};

describe("ChatService", () => {
  it("applies interceptors before a non-streaming request", async () => {
    let receivedBody: ChatBody | undefined;
    const client = {
      chat: {
        completions: {
          create: async (body: ChatBody) => {
            receivedBody = body;
            return {id: "completion"};
          },
        },
      },
    } as unknown as OpenAI;
    const interceptor: ChatInterceptor = {
      intercept: async (body) => ({
        ...body,
        messages: [{role: "system", content: "Context"}, ...body.messages],
      }),
    };
    const service = new ChatService("test-key", [interceptor], client);

    const result = await service.chatNonStreaming({...request, stream: false});

    assert.deepEqual(JSON.parse(result), {id: "completion"});
    assert.deepEqual(receivedBody?.messages, [
      {role: "system", content: "Context"},
      {role: "user", content: "Hello"},
    ]);
  });

  it("forwards streaming chunks and terminates the stream", async () => {
    async function* completionStream() {
      yield {id: "first"};
      yield {id: "second"};
    }

    const client = {
      chat: {
        completions: {
          create: async () => completionStream(),
        },
      },
    } as unknown as OpenAI;
    const service = new ChatService("test-key", [], client);
    const chunks: string[] = [];

    await service.chatStreaming(
      {...request, stream: true},
      async (chunk) => {
        chunks.push(chunk);
        return true;
      },
    );

    assert.deepEqual(chunks, [
      'data: {"id":"first"}\n\n',
      'data: {"id":"second"}\n\n',
      "data: [DONE]\n\n",
    ]);
  });

  it("stops consuming a stream when the client disconnects", async () => {
    let yieldedSecondChunk = false;
    async function* completionStream() {
      yield {id: "first"};
      yieldedSecondChunk = true;
      yield {id: "second"};
    }

    const client = {
      chat: {
        completions: {
          create: async () => completionStream(),
        },
      },
    } as unknown as OpenAI;
    const service = new ChatService("test-key", [], client);
    const chunks: string[] = [];

    await service.chatStreaming(
      {...request, stream: true},
      async (chunk) => {
        chunks.push(chunk);
        return false;
      },
    );

    assert.equal(yieldedSecondChunk, false);
    assert.deepEqual(chunks, [
      'data: {"id":"first"}\n\n',
      "data: [DONE]\n\n",
    ]);
  });
});
