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
import {AgenticContextChatInterceptor} from "../src/services/chat/agentic-context-chat-interceptor";
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

describe("AgenticContextChatInterceptor", () => {
  it("retrieves each generated query and injects the closest results", async () => {
    const queries: string[] = [];
    const documents: Record<string, RetrievedDocument[]> = {
      treatment: [{text: "Treatment evidence", file: "treatment.pdf", distance: 0.4, chunkId: 2}],
      alternatives: [{text: "Alternative evidence", file: "alternatives.pdf", distance: 0.1, chunkId: 5}],
    };
    const contextStore: ContextStore = {
      retrieve: async (query, limit) => {
        queries.push(query);
        assert.equal(limit, 10);
        return documents[query];
      },
      store: async () => undefined,
      delete: async () => undefined,
    };
    const client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              message: {
                tool_calls: [
                  {type: "function", function: {name: "retrieve_context", arguments: '{"query":"treatment"}'}},
                  {type: "function", function: {name: "retrieve_context", arguments: '{"query":"alternatives"}'}},
                ],
              },
            }],
          }),
        },
      },
    } as unknown as OpenAI;
    const interceptor = new AgenticContextChatInterceptor(
      "test-key",
      contextStore,
      client,
    );

    const result = await interceptor.intercept(request);

    assert.deepEqual(queries, ["treatment", "alternatives"]);
    assert.equal(result.messages.at(-1)?.role, "user");
    assert.match(
      String(result.messages.at(-2)?.content),
      /alternatives\.pdf[\s\S]*Alternative evidence[\s\S]*treatment\.pdf[\s\S]*Treatment evidence/,
    );
  });

  it("continues without context when a generated query is invalid", async (context) => {
    context.mock.method(console, "error", () => undefined);
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
    const client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              message: {
                tool_calls: [
                  {type: "function", function: {name: "retrieve_context", arguments: "not-json"}},
                ],
              },
            }],
          }),
        },
      },
    } as unknown as OpenAI;
    const interceptor = new AgenticContextChatInterceptor(
      "test-key",
      contextStore,
      client,
    );

    const result = await interceptor.intercept(request);

    assert.equal(result, request);
    assert.equal(retrieveCalled, false);
  });
});
