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
import {ChatService, ResponseBody} from "../src/services/chat/chat-service";
import {
  CITATION_DELIMITER,
  CITATION_START,
  CITATION_STOP,
} from "../src/services/chat/citation-marker";
import {createMockOpenAIClient} from "../src/services/chat/mock-openai-client";

const response = "Plainly Firebase end-to-end response.";

function requestWithArraySchema(
  constraints: Record<string, unknown>,
): ResponseBody {
  return {
    model: "test-model",
    input: [{role: "user", content: "Hello"}],
    stream: false,
    tools: [{
      type: "function",
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
      strict: false,
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
      input: [{role: "user", content: "Hello"}],
      stream: false,
    }));

    assert.equal(result.output_text, response);
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

  it("returns an OpenAI-compatible non-streaming response", async () => {
    const service = new ChatService(createMockOpenAIClient(response));

    const result = JSON.parse(await service.chatNonStreaming({
      model: "test-model",
      input: [{role: "user", content: "Hello"}],
      stream: false,
    }));

    assert.equal(result.object, "response");
    assert.equal(result.output_text, response);
    assert.equal(result.output[0].content[0].text, response);
  });

  it("requires incremental state for the configured follow-up", async () => {
    const client = createMockOpenAIClient(response, {validateResponseState: true});
    const followUp = {
      ...requestWithArraySchema({minItems: 1}),
      input: [{role: "user" as const, content: "Tell me more about my health records."}],
    };

    await assert.rejects(
      () => client.responses.create(followUp),
      OpenAI.BadRequestError,
    );
    const result = await client.responses.create({
      ...followUp,
      previous_response_id: "resp-previous",
    });
    assert.equal(result.previous_response_id, "resp-previous");
  });

  it("models a Responses function-call continuation", async () => {
    const client = createMockOpenAIClient(response, {returnFunctionCall: true});
    const first = await client.responses.create(requestWithArraySchema({minItems: 1}));
    const functionCall = first.output.find((item) => item.type === "function_call");
    assert.equal(functionCall?.name, "get_resources");
    assert.ok(functionCall?.call_id);
    assert.deepEqual(JSON.parse(functionCall?.arguments ?? "{}"), {
      resourceCategories: ["Observation"],
    });

    const second = await client.responses.create({
      ...requestWithArraySchema({minItems: 1}),
      input: [{
        type: "function_call_output",
        call_id: functionCall?.call_id ?? "",
        output: "Mock health record\nNested resource summary completed.",
      }],
      previous_response_id: first.id,
    });
    assert.equal(second.output_text, response);
    assert.equal(second.previous_response_id, first.id);
  });

  it("rejects malformed Responses function-call continuations", async () => {
    const client = createMockOpenAIClient(response, {returnFunctionCall: true});
    const output = {
      type: "function_call_output" as const,
      call_id: "call-plainly-emulator-get-resources",
      output: "Mock health record\nNested resource summary completed.",
    };

    await assert.rejects(
      () => client.responses.create({
        ...requestWithArraySchema({minItems: 1}),
        input: [output],
      }),
      /continue a previous response/,
    );
    await assert.rejects(
      () => client.responses.create({
        ...requestWithArraySchema({minItems: 1}),
        input: [output, {role: "user", content: "Unexpected replay"}],
        previous_response_id: "resp-previous",
      }),
      /contain only its function output/,
    );
    await assert.rejects(
      () => client.responses.create({
        ...requestWithArraySchema({minItems: 1}),
        input: [{...output, call_id: "call-unrelated"}],
        previous_response_id: "resp-previous",
      }),
      /matching call identifier/,
    );
    await assert.rejects(
      () => client.responses.create({
        ...requestWithArraySchema({minItems: 1}),
        input: [{...output, output: "No nested summary"}],
        previous_response_id: "resp-previous",
      }),
      /contain the nested resource summary/,
    );
  });

  it("returns a nested resource summary instead of another function call", async () => {
    const client = createMockOpenAIClient(response, {returnFunctionCall: true});
    const result = await client.responses.create({
      model: "test-model",
      input: [{role: "user", content: "Summarize this FHIR resource."}],
      stream: false,
    });

    assert.match(result.output_text, /Nested resource summary completed\./);
    assert.equal(result.output.some((item) => item.type === "function_call"), false);
  });

  it("returns OpenAI-compatible streaming events", async () => {
    const service = new ChatService(createMockOpenAIClient(response));
    const chunks: string[] = [];

    await service.chatStreaming(
      {
        model: "test-model",
        input: [{role: "user", content: "Hello"}],
        stream: true,
      },
      async (chunk) => {
        chunks.push(chunk);
        return true;
      },
    );

    const events = parseEvents(chunks);
    const content = events
      .filter((event) => event.type === "response.output_text.delta")
      .map((event) => event.delta)
      .join("");
    assert.equal(content, response);
    assert.equal(events.at(-1)?.type, "response.completed");
    assert.match(events.at(-1)?.response.id ?? "", /^resp-plainly-emulator-[0-9a-f-]{36}$/);
  });

  it("does not split Unicode code points across streaming events", async () => {
    const unicodeResponse = "Plainly 🧠 response";
    const service = new ChatService(createMockOpenAIClient(unicodeResponse));
    const chunks: string[] = [];

    await service.chatStreaming(
      {
        model: "test-model",
        input: [{role: "user", content: "Hello"}],
        stream: true,
      },
      async (chunk) => {
        chunks.push(chunk);
        return true;
      },
    );

    const contentChunks = parseEvents(chunks)
      .filter((event) => event.type === "response.output_text.delta")
      .map((event) => event.delta as string);
    assert.equal(contentChunks.join(""), unicodeResponse);
    assert.ok(contentChunks.every((chunk) => !chunk.includes("\uFFFD")));
  });

  it("accepts production-compatible array constraints", async () => {
    const service = new ChatService(createMockOpenAIClient(response));

    const result = await service.chatNonStreaming(requestWithArraySchema({
      minItems: 1,
      maxItems: 250,
      uniqueItems: true,
    }));

    assert.equal(JSON.parse(result).output_text, response);
  });

  for (const [keyword, expectedType] of [
    ["minItems", "integer"],
    ["maxItems", "integer"],
    ["uniqueItems", "boolean"],
  ] as const) {
    it(`rejects a null ${keyword} constraint like OpenAI`, async () => {
      const service = new ChatService(createMockOpenAIClient(response));

      await assert.rejects(
        () => service.chatNonStreaming(requestWithArraySchema({[keyword]: null})),
        (error: unknown) => {
          assert.ok(error instanceof OpenAI.BadRequestError);
          assert.equal(error.code, "invalid_function_parameters");
          assert.equal(error.param, "tools[0].parameters");
          assert.match(error.message, new RegExp(`must be ${expectedType}`));
          return true;
        },
      );
    });
  }

  it("rejects an empty enum like OpenAI", async () => {
    const service = new ChatService(createMockOpenAIClient(response));

    await assert.rejects(
      () => service.chatNonStreaming(requestWithArraySchema({
        items: {type: "string", enum: []},
      })),
      (error: unknown) => {
        assert.ok(error instanceof OpenAI.BadRequestError);
        assert.equal(error.code, "invalid_function_parameters");
        assert.equal(error.param, "tools[0].parameters");
        assert.match(error.message, /must NOT have fewer than 1 items/);
        return true;
      },
    );
  });

  it("can return a production-shaped API failure", async () => {
    const service = new ChatService(createMockOpenAIClient(response, {rejectRequest: true}));

    await assert.rejects(
      () => service.chatNonStreaming(requestWithArraySchema({
        minItems: 1,
        maxItems: 250,
        uniqueItems: true,
      })),
      OpenAI.BadRequestError,
    );
  });

  it("models a gateway that rejects streaming but accepts a normal response", async () => {
    const service = new ChatService(createMockOpenAIClient(
      response,
      {rejectStreamingRequest: true},
    ));
    const chunks: string[] = [];

    await service.chatStreaming(
      {...requestWithArraySchema({minItems: 1}), stream: true},
      async (chunk) => {
        chunks.push(chunk);
        return true;
      },
    );

    assert.equal(
      parseEvents(chunks)
        .filter((event) => event.type === "response.output_text.delta")
        .map((event) => event.delta)
        .join(""),
      response,
    );
  });

  it("can return a production-shaped failure after streaming starts", async () => {
    const service = new ChatService(createMockOpenAIClient(
      response,
      {rejectStreamAfterFirstChunk: true},
    ));
    const chunks: string[] = [];

    await assert.rejects(
      () => service.chatStreaming(
        {...requestWithArraySchema({minItems: 1}), stream: true},
        async (chunk) => {
          chunks.push(chunk);
          return true;
        },
      ),
      OpenAI.InternalServerError,
    );
    assert.equal(
      parseEvents(chunks).filter((event) => event.type === "response.output_text.delta").length,
      1,
    );
  });
});

interface ParsedEvent {
  type?: string;
  delta?: string;
  response?: {id?: string};
}

function parseEvents(chunks: string[]): ParsedEvent[] {
  return chunks.map((chunk) => JSON.parse(chunk.slice("data: ".length)));
}

describe("mock OpenAI client retrieval", () => {
  const marker = (sourceId: string) =>
    CITATION_START + "cite" + CITATION_DELIMITER + sourceId + CITATION_STOP;

  function citableInstructions(...ids: string[]): string {
    return ids.map((id) => `<citable id="${id}">Evidence.</citable>`).join("\n");
  }

  it("answers the retrieval planner's forced tool call with a query", async () => {
    const client = createMockOpenAIClient(response);

    // The RAG interceptor plans its queries before the chat request is ever made, so a mock that
    // cannot answer this call fails every retrieval-enabled request.
    const result = await client.responses.create({
      model: "test-model",
      input: [{role: "user", content: "Will fusion help me?"}],
      stream: false,
      tools: [{
        type: "function",
        name: "retrieve_context",
        description: "Retrieve relevant context from the knowledge base using a search query.",
        parameters: {
          type: "object",
          properties: {query: {type: "string"}},
          required: ["query"],
        },
        strict: false,
      }],
      tool_choice: {type: "function", name: "retrieve_context"},
    });

    const call = result.output.find((item) => item.type === "function_call");
    assert.equal(call?.name, "retrieve_context");
    assert.ok(call?.call_id);
    assert.deepEqual(JSON.parse(call?.arguments ?? "{}"), {
      query: "lumbar fusion functional outcomes",
    });
  });

  it("cites the sources the interceptor actually injected", async () => {
    const client = createMockOpenAIClient(response, {citeRetrievedContext: true});

    const result = await client.responses.create({
      model: "test-model",
      input: [{role: "user", content: "Hello"}],
      stream: false,
      instructions: citableInstructions("sabc12345c0", "sdef67890c3"),
    });

    // The ids come back out of the instructions, so the emulator exercises the same resolution
    // path a real answer does rather than a shape invented here.
    assert.equal(
      result.output_text,
      `${response}${marker("sabc12345c0")}${marker("sdef67890c3")}`,
    );
  });

  it("cites at most the first two injected sources", async () => {
    const client = createMockOpenAIClient(response, {citeRetrievedContext: true});

    const result = await client.responses.create({
      model: "test-model",
      input: [{role: "user", content: "Hello"}],
      stream: false,
      instructions: citableInstructions("sabc12345c0", "sdef67890c3", "sghi13579c7"),
    });

    assert.doesNotMatch(result.output_text, /sghi13579c7/);
  });

  it("leaves the answer unmarked when nothing was retrieved to cite", async () => {
    const client = createMockOpenAIClient(response, {citeRetrievedContext: true});

    const result = await client.responses.create({
      model: "test-model",
      input: [{role: "user", content: "Hello"}],
      stream: false,
      instructions: "You are a helpful assistant.",
    });

    assert.equal(result.output_text, response);
  });
});
