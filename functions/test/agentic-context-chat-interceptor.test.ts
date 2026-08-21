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
import {Response} from "openai/resources/responses/responses";
import {AgenticContextChatInterceptor} from "../src/services/chat/agentic-context-chat-interceptor";
import {ResponseBody} from "../src/services/chat/chat-service";
import {ContextStore, RetrievedDocument} from "../src/services/context/context-store";

const request: ResponseBody = {
  model: "test-model",
  instructions: "Answer with the available evidence.",
  input: [{role: "user", content: "What are my treatment options?"}],
  previous_response_id: "previous-response",
  stream: false,
  tools: [{
    type: "function",
    name: "get_resources",
    description: "Retrieve the participant's health records.",
    parameters: {type: "object", properties: {}},
    strict: false,
  }],
};

describe("AgenticContextChatInterceptor", () => {
  it("retrieves each generated query and injects the closest results", async () => {
    const queries: string[] = [];
    const documents: Record<string, RetrievedDocument[]> = {
      treatment: [{text: "Treatment evidence", file: "treatment.pdf", distance: 0.4, chunkId: 2}],
      alternatives: [{text: "Alternative evidence", file: "alternatives.pdf", distance: 0.1, chunkId: 5}],
    };
    const contextStore = makeContextStore(async (query, limit) => {
      queries.push(query);
      assert.equal(limit, 10);
      return documents[query];
    });
    let internalRequest: ResponseBody | undefined;
    const client = responseClient(async (body) => {
      internalRequest = body;
      return toolCallResponse([
        {query: "treatment"},
        {query: "alternatives"},
      ]);
    });
    const interceptor = new AgenticContextChatInterceptor(contextStore, client);

    const result = await interceptor.intercept(request);

    assert.deepEqual(queries, ["treatment", "alternatives"]);
    assert.equal(internalRequest?.stream, false);
    assert.equal(internalRequest?.store, false);
    assert.equal(internalRequest?.previous_response_id, "previous-response");
    assert.deepEqual(internalRequest?.input, request.input);
    assert.deepEqual(internalRequest?.tool_choice, {
      type: "function",
      name: "retrieve_context",
    });
    assert.equal(internalRequest?.tools?.[0].type, "function");
    assert.deepEqual(result.input, request.input);
    assert.match(
      result.instructions ?? "",
      /alternatives\.pdf[\s\S]*Alternative evidence[\s\S]*treatment\.pdf[\s\S]*Treatment evidence/,
    );
    assert.match(result.instructions ?? "", /^Answer with the available evidence\./);
  });

  it("includes document metadata in the injected context", async () => {
    const contextStore = makeContextStore(async () => [{
      text: "Fusion improves outcomes.",
      file: "guideline.pdf",
      distance: 0.1,
      chunkId: 4,
      metadata: {title: "Lumbar Fusion Outcomes", author: "J. Smith", year: 2021},
    }]);
    const interceptor = new AgenticContextChatInterceptor(
      contextStore,
      responseClient(async () => toolCallResponse([{query: "fusion"}])),
    );

    const result = await interceptor.intercept(request);
    assert.match(
      result.instructions ?? "",
      /\[Document: guideline\.pdf \| Title: Lumbar Fusion Outcomes \| Author: J\. Smith \| Year: 2021 \| Chunk 4\]/,
    );
  });

  it("converts a plain string input while preserving the user message", async () => {
    const contextStore = makeContextStore(async () => [{
      text: "Relevant context",
      file: "evidence.pdf",
    }]);
    const interceptor = new AgenticContextChatInterceptor(
      contextStore,
      responseClient(async () => toolCallResponse([{query: "evidence"}])),
    );

    const result = await interceptor.intercept({...request, input: "What helps?"});

    assert.equal(result.input, "What helps?");
    assert.match(result.instructions ?? "", /Relevant context/);
  });

  it("deduplicates and limits model-generated retrieval queries", async () => {
    const queries: string[] = [];
    const contextStore = makeContextStore(async (query) => {
      queries.push(query);
      return [];
    });
    const interceptor = new AgenticContextChatInterceptor(
      contextStore,
      responseClient(async () => toolCallResponse([
        {query: "first"},
        {query: " first "},
        {query: "second"},
        {query: "third"},
        {query: "fourth"},
      ])),
    );

    await interceptor.intercept(request);

    assert.deepEqual(queries, ["first", "second", "third"]);
  });

  it("keeps context transient across a tool continuation and a new user turn", async () => {
    const generatedQueries = ["first-turn", "first-turn", "second-turn"];
    let plannerCall = 0;
    const contextStore = makeContextStore(async (query) => [{
      text: query === "first-turn" ? "First-turn evidence" : "Second-turn evidence",
      file: `${query}.pdf`,
    }]);
    const interceptor = new AgenticContextChatInterceptor(
      contextStore,
      responseClient(async () => toolCallResponse([{
        query: generatedQueries[plannerCall++],
      }])),
    );
    const firstTurn: ResponseBody = {
      ...request,
      previous_response_id: undefined,
    };
    const continuation: ResponseBody = {
      model: "test-model",
      instructions: request.instructions,
      tools: request.tools,
      previous_response_id: "first-response",
      input: [{
        type: "function_call_output",
        call_id: "call-1",
        output: "Tool output",
      }],
      stream: false,
    };
    const secondTurn: ResponseBody = {
      ...request,
      previous_response_id: "continuation-response",
      input: [{role: "user", content: "A different question"}],
    };

    const firstResult = await interceptor.intercept(firstTurn);
    const continuationResult = await interceptor.intercept(continuation);
    const secondResult = await interceptor.intercept(secondTurn);

    assert.deepEqual(firstResult.input, firstTurn.input);
    assert.deepEqual(continuationResult.input, continuation.input);
    assert.deepEqual(secondResult.input, secondTurn.input);
    assert.match(firstResult.instructions ?? "", /First-turn evidence/);
    assert.match(continuationResult.instructions ?? "", /First-turn evidence/);
    assert.match(secondResult.instructions ?? "", /Second-turn evidence/);
    assert.doesNotMatch(secondResult.instructions ?? "", /First-turn evidence/);
    assert.equal(plannerCall, 3);
  });

  it("does not retrieve for an assistant-only continuation", async () => {
    let plannerCalled = false;
    const interceptor = new AgenticContextChatInterceptor(
      makeContextStore(async () => {
        assert.fail("Assistant-only input must not retrieve context.");
      }),
      responseClient(async () => {
        plannerCalled = true;
        return toolCallResponse([{query: "unused"}]);
      }),
    );
    const assistantOnly: ResponseBody = {
      model: "test-model",
      tools: request.tools,
      input: [
        {role: "user", content: "Historical user input"},
        {
          type: "function_call",
          call_id: "call-1",
          name: "get_resources",
          arguments: "{}",
        },
      ],
      stream: false,
    };

    const result = await interceptor.intercept(assistantOnly);

    assert.equal(result, assistantOnly);
    assert.equal(plannerCalled, false);
  });

  it("does not retrieve for a non-chat one-shot request", async () => {
    let plannerCalled = false;
    const interceptor = new AgenticContextChatInterceptor(
      makeContextStore(async () => {
        assert.fail("A one-shot resource request must not retrieve study context.");
      }),
      responseClient(async () => {
        plannerCalled = true;
        return toolCallResponse([{query: "unused"}]);
      }),
    );
    const oneShot: ResponseBody = {
      model: "test-model",
      input: [{role: "user", content: "Summarize this FHIR resource."}],
      stream: false,
    };

    const result = await interceptor.intercept(oneShot);

    assert.equal(result, oneShot);
    assert.equal(plannerCalled, false);
  });

  it("fails closed when a generated query is invalid", async (context) => {
    context.mock.method(console, "error", () => undefined);
    let retrieveCalled = false;
    const contextStore = makeContextStore(async () => {
      retrieveCalled = true;
      return [];
    });
    const client = responseClient(async () => toolCallResponse([], ["not-json"]));
    const interceptor = new AgenticContextChatInterceptor(contextStore, client);

    await assert.rejects(
      interceptor.intercept(request),
      /study knowledge base could not be retrieved/,
    );
    assert.equal(retrieveCalled, false);
  });

  it("fails closed when retrieval fails during a tool continuation", async (context) => {
    context.mock.method(console, "error", () => undefined);
    const interceptor = new AgenticContextChatInterceptor(
      makeContextStore(async () => {
        throw new Error("Firestore unavailable");
      }),
      responseClient(async () => toolCallResponse([{query: "active request"}])),
    );
    const continuation: ResponseBody = {
      model: "test-model",
      tools: request.tools,
      previous_response_id: "tool-call-response",
      input: [{
        type: "function_call_output",
        call_id: "call-1",
        output: "FHIR result",
      }],
      stream: false,
    };

    await assert.rejects(
      interceptor.intercept(continuation),
      /study knowledge base could not be retrieved/,
    );
  });
});

function makeContextStore(
  retrieve: ContextStore["retrieve"],
): ContextStore {
  return {
    retrieve,
    store: async () => undefined,
    delete: async () => undefined,
  };
}

function responseClient(
  create: (body: ResponseBody) => Promise<Response>,
): OpenAI {
  return {responses: {create}} as unknown as OpenAI;
}

function toolCallResponse(
  queries: Array<{query: string}>,
  rawArguments: string[] = [],
): Response {
  const arguments_ = [
    ...queries.map((query) => JSON.stringify(query)),
    ...rawArguments,
  ];
  return {
    id: "query-response",
    object: "response",
    created_at: 0,
    status: "completed",
    model: "test-model",
    output: arguments_.map((argumentsValue, index) => ({
      id: `item-${index}`,
      type: "function_call",
      call_id: `call-${index}`,
      name: "retrieve_context",
      arguments: argumentsValue,
      status: "completed",
    })),
    output_text: "",
  } as unknown as Response;
}
