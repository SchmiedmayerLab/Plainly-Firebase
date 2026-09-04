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
import {accumulateResponse} from "openai/lib/responses/ResponseAccumulator";
import {Response, ResponseStreamEvent} from "openai/resources/responses/responses";
import {ChatInterceptor} from "../src/services/chat/chat-interceptor";
import {
  ChatService,
  ResponseBody,
  streamErrorSequenceNumber,
  streamEvents,
} from "../src/services/chat/chat-service";
import {CitationOutputTransform} from "../src/services/chat/citation-output-transform";
import {createMockOpenAIClient} from "../src/services/chat/mock-openai-client";

const request: ResponseBody = {
  model: "test-model",
  input: [{role: "user", content: "Hello"}],
  stream: false,
};

describe("ChatService", () => {
  it("applies interceptors before a non-streaming request", async () => {
    let receivedBody: ResponseBody | undefined;
    const response = {
      ...completedResponse("Hello"),
      instructions: "Retrieved context sentinel",
    };
    const client = {
      responses: {
        create: async (body: ResponseBody) => {
          receivedBody = body;
          return response;
        },
      },
    } as unknown as OpenAI;
    const interceptor: ChatInterceptor = {
      intercept: async (body) => ({body: {...body, instructions: "Retrieved context"}}),
    };
    const service = new ChatService(client, [interceptor]);

    const result = await service.chatNonStreaming({...request, stream: false});

    assert.equal(JSON.parse(result).id, response.id);
    assert.equal(JSON.parse(result).instructions, null);
    assert.equal(receivedBody?.instructions, "Retrieved context");
    assert.equal(receivedBody?.stream, false);
  });

  it("does not generate a response when an interceptor fails", async () => {
    let generated = false;
    const client = {
      responses: {
        create: async () => {
          generated = true;
          return completedResponse("Ungrounded answer");
        },
      },
    } as unknown as OpenAI;
    const service = new ChatService(client, [{
      intercept: async () => {
        throw new Error("Retrieval unavailable");
      },
    }]);

    await assert.rejects(
      service.chatNonStreaming({...request, stream: false}),
      /Retrieval unavailable/,
    );
    assert.equal(generated, false);
  });

  it("forwards Responses API events through server-sent events", async () => {
    const client = createMockOpenAIClient("Hello");
    const originalCreate = client.responses.create.bind(client.responses);
    client.responses.create = (async (...args: Parameters<typeof originalCreate>) => {
      const stream = await originalCreate(...args);
      return (async function* () {
        for await (const event of stream as AsyncIterable<ResponseStreamEvent>) {
          if ("response" in event) {
            yield {
              ...event,
              response: {
                ...event.response,
                instructions: "Retrieved context sentinel",
              },
            } as ResponseStreamEvent;
          } else {
            yield event;
          }
        }
      })();
    }) as typeof client.responses.create;
    const service = new ChatService(client);
    const chunks: string[] = [];

    await service.chatStreaming(
      {...request, stream: true},
      async (chunk) => {
        chunks.push(chunk);
        return true;
      },
    );

    const events = parseEvents(chunks);
    assert.equal(events.at(0)?.type, "response.created");
    assert.equal(events.at(-1)?.type, "response.completed");
    assert.equal(events.at(0)?.response?.instructions, null);
    assert.equal(events.at(-1)?.response?.instructions, null);
    assert.equal(
      events
        .filter((event) => event.type === "response.output_text.delta")
        .map((event) => event.delta)
        .join(""),
      "Hello",
    );
  });

  it("stops consuming a stream when the client disconnects", async () => {
    let yieldedAfterOutput = false;
    async function* responseStream() {
      yield {type: "response.created"};
      yield {type: "response.output_text.delta"};
      yieldedAfterOutput = true;
      yield {type: "response.completed"};
    }
    const client = {
      responses: {create: async () => responseStream()},
    } as unknown as OpenAI;
    const service = new ChatService(client);
    const chunks: string[] = [];

    await service.chatStreaming(
      {...request, stream: true},
      async (chunk) => {
        chunks.push(chunk);
        return false;
      },
    );

    assert.equal(yieldedAfterOutput, false);
    assert.equal(chunks.length, 1);
  });

  it("retries a server-side streaming failure without streaming", async () => {
    const response = {
      ...completedResponse("Fallback response"),
      instructions: "Retrieved context sentinel",
    };
    const streamModes: Array<boolean | null | undefined> = [];
    const retryOptions: Array<number | undefined> = [];
    let interceptions = 0;
    const client = {
      responses: {
        create: async (body: ResponseBody, options?: {maxRetries?: number}) => {
          streamModes.push(body.stream);
          retryOptions.push(options?.maxRetries);
          if (body.stream) {
            throw mockApiError(500);
          }
          return response;
        },
      },
    } as unknown as OpenAI;
    const service = new ChatService(client, [{
      intercept: async (body) => {
        interceptions += 1;
        return {body: {...body, instructions: "Context"}};
      },
    }]);
    const chunks: string[] = [];

    await service.chatStreaming(
      {...request, stream: true},
      async (chunk) => {
        chunks.push(chunk);
        return true;
      },
    );

    assert.deepEqual(streamModes, [true, false]);
    assert.deepEqual(retryOptions, [0, undefined]);
    assert.equal(interceptions, 1);
    const events = parseEvents(chunks);
    assert.equal(textFromEvents(events), "Fallback response");
    assert.equal(events.at(0)?.response?.status, "in_progress");
    assert.deepEqual(events.at(0)?.response?.output, []);
    assert.equal(events.at(0)?.response?.instructions, null);
    assert.equal(events.at(-1)?.response?.id, response.id);
    assert.equal(events.at(-1)?.response?.instructions, null);
    assert.deepEqual(events.map((event) => event.sequence_number),
      events.map((_, index) => index));
  });

  it("uses one normal response when streaming is disabled for the endpoint", async () => {
    const response = completedResponse("Configured fallback response");
    const streamModes: Array<boolean | null | undefined> = [];
    const client = {
      responses: {
        create: async (body: ResponseBody) => {
          streamModes.push(body.stream);
          return response;
        },
      },
    } as unknown as OpenAI;
    const service = new ChatService(client, [], false);
    const chunks: string[] = [];

    await service.chatStreaming(
      {...request, stream: true},
      async (chunk) => {
        chunks.push(chunk);
        return true;
      },
    );

    assert.deepEqual(streamModes, [false]);
    assert.equal(textFromEvents(parseEvents(chunks)), "Configured fallback response");
    assert.equal(parseEvents(chunks).at(-1)?.type, "response.completed");
  });

  it("does not retry after the upstream allocated a response", async () => {
    const response = completedResponse("Unused fallback response");
    let callCount = 0;
    const client = {
      responses: {
        create: async (body: ResponseBody) => {
          callCount += 1;
          if (!body.stream) return response;
          return (async function* () {
            yield {
              type: "response.created",
              response: {...response, status: "in_progress"},
              sequence_number: 8,
            };
            yield {
              type: "response.in_progress",
              response: {...response, status: "in_progress"},
              sequence_number: 9,
            };
            throw mockApiError(500);
          })();
        },
      },
    } as unknown as OpenAI;
    const service = new ChatService(client);
    const chunks: string[] = [];

    await assert.rejects(
      service.chatStreaming(
        {...request, stream: true},
        async (chunk) => {
          chunks.push(chunk);
          return true;
        },
      ),
      OpenAI.InternalServerError,
    );

    const events = parseEvents(chunks);
    assert.equal(callCount, 1);
    assert.equal(events.filter((event) => event.type === "response.created").length, 1);
    // Numbered by the service rather than carried over from upstream: an interceptor's output
    // transform can inject events, so the upstream numbering no longer describes this stream.
    assert.deepEqual(events.map((event) => event.sequence_number), [0, 1]);
  });

  it("does not replay an empty stream", async () => {
    let calls = 0;
    const client = {
      responses: {
        create: async () => {
          calls += 1;
          return (async function* () {
            yield* [] as ResponseStreamEvent[];
          })();
        },
      },
    } as unknown as OpenAI;
    const service = new ChatService(client);

    await assert.rejects(
      service.chatStreaming({...request, stream: true}, async () => true),
      /ended without a terminal event/,
    );
    assert.equal(calls, 1);
  });

  it("opens a generated image without its bytes and finishes it with them", () => {
    const item = {
      id: "image-1",
      type: "image_generation_call",
      status: "completed",
      output_format: "png",
      result: "iVBORw0KGgo=",
    };
    const events = [...streamEvents({...completedResponse(""), output: [item]})];
    const added = events.find((event) => event.type === "response.output_item.added");
    const done = events.find((event) => event.type === "response.output_item.done");

    assert.equal((added as {item: {result: string | null}}).item.result, null);
    assert.equal((done as {item: {result: string | null}}).item.result, "iVBORw0KGgo=");
    assert.equal(events.at(-1)?.type, "response.completed");
  });

  it("preserves complete output items when adapting a fallback response", async () => {
    const response = {
      ...completedResponse("Cited answer"),
      output: [
        {
          id: "reasoning-1",
          type: "reasoning",
          summary: [{type: "summary_text", text: "Evidence considered"}],
        },
        {
          id: "message-1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{
            type: "output_text",
            text: "Cited answer",
            annotations: [{
              type: "url_citation",
              url: "https://example.com/evidence",
              title: "Evidence",
              start_index: 0,
              end_index: 5,
            }],
          }],
        },
        {
          id: "call-1",
          type: "function_call",
          call_id: "call-1",
          name: "get_resource",
          arguments: "{}",
          status: "completed",
        },
      ],
    } as unknown as Response;
    const client = {
      responses: {
        create: async (body: ResponseBody) => {
          if (body.stream) throw mockApiError(500);
          return response;
        },
      },
    } as unknown as OpenAI;
    const service = new ChatService(client);
    const chunks: string[] = [];

    await service.chatStreaming(
      {...request, stream: true},
      async (chunk) => {
        chunks.push(chunk);
        return true;
      },
    );

    const events = parseEvents(chunks);
    assert.equal(
      events.find((event) => event.type === "response.reasoning_summary_text.delta")?.delta,
      "Evidence considered",
    );
    const doneItems = events
      .filter((event) => event.type === "response.output_item.done")
      .map((event) => event.item);
    assert.equal(doneItems.find((item) => item.type === "message")
      ?.content[0].annotations[0].url, "https://example.com/evidence");
    assert.equal(doneItems.find((item) => item.type === "function_call")?.name, "get_resource");
    assert.equal(
      events.find((event) => event.type === "response.function_call_arguments.delta")?.delta,
      "{}",
    );
    assert.equal(
      events.find((event) => event.type === "response.function_call_arguments.done")?.arguments,
      "{}",
    );

    let snapshot: Response | undefined;
    for (const event of parseResponseEvents(chunks)) {
      snapshot = accumulateResponse(event, snapshot);
    }
    assert.equal(snapshot?.id, response.id);
    assert.deepEqual(snapshot?.output, response.output);
  });

  it("does not retry after output has reached the client", async () => {
    const service = new ChatService(createMockOpenAIClient(
      "Partial response",
      {rejectStreamAfterFirstChunk: true},
    ));
    const chunks: string[] = [];

    let failure: unknown;
    try {
      await service.chatStreaming(
        {...request, stream: true},
        async (chunk) => {
          chunks.push(chunk);
          return true;
        },
      );
    } catch (error) {
      failure = error;
    }

    assert.ok(failure instanceof OpenAI.InternalServerError);
    assert.equal(
      parseEvents(chunks).filter((event) => event.type === "response.output_text.delta").length,
      1,
    );
    const forwardedSequenceNumbers = parseEvents(chunks)
      .flatMap((event) => event.sequence_number ?? []);
    assert.equal(
      streamErrorSequenceNumber(failure),
      Math.max(...forwardedSequenceNumbers) + 1,
    );
  });

  for (const status of [400, 401, 403, 429]) {
    it(`does not retry an upstream ${status} response`, async () => {
      let calls = 0;
      const client = {
        responses: {
          create: async () => {
            calls += 1;
            throw mockApiError(status);
          },
        },
      } as unknown as OpenAI;
      const service = new ChatService(client);

      await assert.rejects(
        service.chatStreaming({...request, stream: true}, async () => true),
        OpenAI.APIError,
      );
      assert.equal(calls, 1);
    });
  }

  it("does not replay an ambiguous connection failure", async () => {
    let calls = 0;
    const client = {
      responses: {
        create: async () => {
          calls += 1;
          throw new OpenAI.APIConnectionError({message: "Connection lost"});
        },
      },
    } as unknown as OpenAI;
    const service = new ChatService(client);

    await assert.rejects(
      service.chatStreaming({...request, stream: true}, async () => true),
      OpenAI.APIConnectionError,
    );
    assert.equal(calls, 1);
  });

  it("does not interpret other server failures as unsupported streaming", async () => {
    let calls = 0;
    const client = {
      responses: {
        create: async () => {
          calls += 1;
          throw mockApiError(503);
        },
      },
    } as unknown as OpenAI;
    const service = new ChatService(client);

    await assert.rejects(
      service.chatStreaming({...request, stream: true}, async () => true),
      OpenAI.APIError,
    );
    assert.equal(calls, 1);
  });
});

function completedResponse(text: string): Response {
  return {
    id: "response-1",
    object: "response",
    created_at: 0,
    status: "completed",
    model: "test-model",
    output: [{
      id: "message-1",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{type: "output_text", text, annotations: []}],
    }],
    output_text: text,
  } as unknown as Response;
}

function mockApiError(status: number): OpenAI.APIError {
  return OpenAI.APIError.generate(
    status,
    {error: {message: "Mock API error", type: "server_error"}},
    undefined,
    new Headers(),
  );
}

interface ParsedEvent {
  type?: string;
  delta?: string;
  arguments?: string;
  sequence_number?: number;
  response?: {
    id?: string;
    status?: string;
    output?: unknown[];
    instructions?: string | null;
  };
  item?: {
    type?: string;
    name?: string;
    content?: Array<{annotations?: Array<{url?: string}>}>;
  };
}

function parseEvents(chunks: string[]): ParsedEvent[] {
  return chunks.map((chunk) => JSON.parse(chunk.slice("data: ".length)));
}

function parseResponseEvents(chunks: string[]): ResponseStreamEvent[] {
  return chunks.map((chunk) =>
    JSON.parse(chunk.slice("data: ".length)) as ResponseStreamEvent);
}

function textFromEvents(events: ParsedEvent[]): string {
  return events
    .filter((event) => event.type === "response.output_text.delta")
    .map((event) => event.delta)
    .join("");
}

describe("ChatService citations", () => {
  const source = {
    id: "sguidelinec4",
    file: "guideline.pdf",
    title: "Smith et al. (2021) — Lumbar Fusion Guideline · NASS",
  };
  const marker = String.fromCharCode(0xe200) + "cite" + String.fromCharCode(0xe202) +
    source.id + String.fromCharCode(0xe201);

  const citingInterceptor: ChatInterceptor = {
    intercept: async (body) => ({
      body,
      outputTransform: new CitationOutputTransform(new Map([[source.id, source]])),
    }),
  };

  function markedResponse(): Response {
    return completedResponse(`Fusion improves function.${marker}`);
  }

  function streamingClient(): OpenAI {
    return {
      responses: {
        create: async (body: ResponseBody) => body.stream ?
          (async function* () {
            yield* streamEvents(markedResponse());
          })() :
          markedResponse(),
      },
    } as unknown as OpenAI;
  }

  it("never streams a citation marker to the client", async () => {
    const chunks: string[] = [];
    const service = new ChatService(streamingClient(), [citingInterceptor]);

    await service.chatStreaming({...request, stream: true}, async (chunk) => {
      chunks.push(chunk);
      return true;
    });

    assert.doesNotMatch(chunks.join(""), new RegExp(String.fromCharCode(0xe200)));
    assert.equal(textFromEvents(parseEvents(chunks)), "Fusion improves function.[1]");
  });

  it("puts the citation on the finished message item, where the iOS client reads it", async () => {
    const chunks: string[] = [];
    const service = new ChatService(streamingClient(), [citingInterceptor]);

    await service.chatStreaming({...request, stream: true}, async (chunk) => {
      chunks.push(chunk);
      return true;
    });

    const done = parseEvents(chunks).find((event) => event.type === "response.output_item.done");
    assert.deepEqual(done?.item?.content?.[0].annotations, [{
      type: "file_citation",
      file_id: "guideline.pdf",
      filename: source.title,
      // The end of the sentence the marker followed.
      index: "Fusion improves function.".length,
    }]);
  });

  it("announces each citation as its own event as well", async () => {
    const chunks: string[] = [];
    const service = new ChatService(streamingClient(), [citingInterceptor]);

    await service.chatStreaming({...request, stream: true}, async (chunk) => {
      chunks.push(chunk);
      return true;
    });

    const events = parseEvents(chunks);
    assert.equal(
      events.filter((event) => event.type === "response.output_text.annotation.added").length,
      1,
    );
    // Injecting events must not leave a gap or a repeat in what the client receives.
    assert.deepEqual(
      events.map((event) => event.sequence_number),
      events.map((_, index) => index),
    );
  });

  it("cites the same way when the endpoint cannot stream", async () => {
    const chunks: string[] = [];
    const service = new ChatService(streamingClient(), [citingInterceptor], false);

    await service.chatStreaming({...request, stream: true}, async (chunk) => {
      chunks.push(chunk);
      return true;
    });

    const events = parseEvents(chunks);
    assert.equal(textFromEvents(events), "Fusion improves function.[1]");
    const done = events.find((event) => event.type === "response.output_item.done");
    assert.equal(done?.item?.content?.[0].annotations?.length, 1);
    assert.equal(
      events.filter((event) => event.type === "response.output_text.annotation.added").length,
      1,
    );
  });

  it("cites a non-streaming response too", async () => {
    const service = new ChatService(streamingClient(), [citingInterceptor]);

    const result = JSON.parse(await service.chatNonStreaming({...request, stream: false}));

    assert.equal(result.output[0].content[0].text, "Fusion improves function.[1]");
    assert.equal(result.output[0].content[0].annotations[0].filename, source.title);
  });
});
