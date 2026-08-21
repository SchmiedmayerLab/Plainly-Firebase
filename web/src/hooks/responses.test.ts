//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import {
  applyResponseEvent,
  emptyResponseProgress,
  ResponseConversation,
  resolveResponseModel,
  toolOutputInput,
} from "./responses.ts";

function event(value: unknown): ResponseStreamEvent {
  return value as ResponseStreamEvent;
}

async function* eventStream(
  events: ResponseStreamEvent[],
): AsyncIterable<ResponseStreamEvent> {
  yield* events;
}

function functionCallResponse(
  responseId: string,
  callId: string,
): ResponseStreamEvent[] {
  const call = {
    type: "function_call",
    call_id: callId,
    name: "get_resources",
    arguments: '{"resourceCategories":["Observation-Weight-10-18-2023"]}',
  };
  return [
    event({ type: "response.output_item.done", item: call }),
    event({
      type: "response.completed",
      response: { id: responseId, output: [call] },
    }),
  ];
}

function finalTextResponse(
  responseId: string,
  text: string,
): ResponseStreamEvent[] {
  return [
    event({ type: "response.output_text.delta", delta: text }),
    event({
      type: "response.completed",
      response: { id: responseId, output: [] },
    }),
  ];
}

describe("Responses API event handling", () => {
  it("uses a Stanford-supported model by default and preserves an override", () => {
    assert.equal(resolveResponseModel(undefined), "gpt-5.5");
    assert.equal(resolveResponseModel("  "), "gpt-5.5");
    assert.equal(resolveResponseModel("custom-deployment"), "custom-deployment");
  });

  it("collects streamed text, tool calls, and the response identifier", () => {
    let progress = emptyResponseProgress();
    progress = applyResponseEvent(progress, event({
      type: "response.output_text.delta",
      delta: "Hello ",
    }));
    progress = applyResponseEvent(progress, event({
      type: "response.output_text.delta",
      delta: "world",
    }));
    progress = applyResponseEvent(progress, event({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: "call_1",
        name: "get_resources",
        arguments: '{"resourceCategories":["Observation-Weight-10-18-2023"]}',
      },
    }));
    progress = applyResponseEvent(progress, event({
      type: "response.completed",
      response: {
        id: "resp_1",
        output: [{
          type: "function_call",
          call_id: "call_1",
          name: "get_resources",
          arguments: '{"resourceCategories":["Observation-Weight-10-18-2023"]}',
        }],
      },
    }));

    assert.equal(progress.text, "Hello world");
    assert.equal(progress.responseId, "resp_1");
    assert.deepEqual(progress.toolCalls, [{
      id: "call_1",
      name: "get_resources",
      arguments: '{"resourceCategories":["Observation-Weight-10-18-2023"]}',
    }]);
  });

  it("surfaces text from a terminal-only non-streaming response", () => {
    const progress = applyResponseEvent(emptyResponseProgress(), event({
      type: "response.completed",
      response: {
        id: "resp_fallback",
        output: [{
          type: "message",
          content: [{ type: "output_text", text: "Fallback response." }],
        }],
      },
    }));

    assert.equal(progress.text, "Fallback response.");
    assert.equal(progress.responseId, "resp_fallback");
  });

  it("uses the complete text from every terminal message without duplicating deltas", () => {
    let progress = applyResponseEvent(emptyResponseProgress(), event({
      type: "response.output_text.delta",
      delta: "First",
    }));
    progress = applyResponseEvent(progress, event({
      type: "response.completed",
      response: {
        id: "resp_multiple_messages",
        output_text: "FirstSecond",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "First" }],
          },
          {
            type: "message",
            content: [{ type: "output_text", text: "Second" }],
          },
        ],
      },
    }));

    assert.equal(progress.text, "FirstSecond");
    assert.equal(progress.responseId, "resp_multiple_messages");
  });

  it("converts local tool results into Responses API continuation input", () => {
    const input = toolOutputInput(
      [{ id: "call_1", name: "get_resources", arguments: "{}" }],
      () => "FHIR summary",
    );

    assert.deepEqual(input, [{
      type: "function_call_output",
      call_id: "call_1",
      output: "FHIR summary",
    }]);
  });

  it("surfaces failed response events", () => {
    assert.throws(
      () => applyResponseEvent(emptyResponseProgress(), event({
        type: "response.failed",
        response: { error: { message: "Gateway failure" } },
      })),
      /Gateway failure/,
    );
  });

  it("continues a function call with its output and commits the final response", async () => {
    const requests: ResponseCreateParamsStreaming[] = [];
    const scripts = [
      functionCallResponse("resp_tool", "call_1"),
      finalTextResponse("resp_final", "Your weight was 155 lbs."),
    ];
    const toolRounds: string[][] = [];
    const conversation = new ResponseConversation();

    const result = await conversation.run({
      request: {
        model: "gpt-5.5",
        instructions: "Use health records when needed.",
        tools: [],
      },
      input: [{ role: "user", content: "What was my weight?" }],
      createResponse: async (request) => {
        requests.push(request);
        return eventStream(scripts.shift() ?? []);
      },
      executeTool: () => "FHIR summary",
      onToolRound: ({ toolCalls }) => {
        toolRounds.push(toolCalls.map(({ output }) => output));
      },
    });

    assert.deepEqual(result, {
      text: "Your weight was 155 lbs.",
      responseId: "resp_final",
    });
    assert.equal(conversation.previousResponseId, "resp_final");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].model, "gpt-5.5");
    assert.equal(requests[0].store, true);
    assert.equal(requests[0].stream, true);
    assert.equal(requests[0].previous_response_id, undefined);
    assert.equal(requests[1].instructions, "Use health records when needed.");
    assert.equal(requests[1].store, true);
    assert.equal(requests[1].stream, true);
    assert.equal(requests[1].previous_response_id, "resp_tool");
    assert.deepEqual(requests[1].input, [{
      type: "function_call_output",
      call_id: "call_1",
      output: "FHIR summary",
    }]);
    assert.deepEqual(toolRounds, [["FHIR summary"]]);
  });

  it("stops repeated tool calls at the configured call limit", async () => {
    const requests: ResponseCreateParamsStreaming[] = [];
    let executeCount = 0;
    let responseCount = 0;
    const conversation = new ResponseConversation("resp_stable");

    await assert.rejects(
      conversation.run({
        request: { model: "gpt-5.5" },
        input: [{ role: "user", content: "Repeat the lookup." }],
        createResponse: async (request) => {
          requests.push(request);
          responseCount += 1;
          return eventStream(functionCallResponse(
            `resp_tool_${responseCount}`,
            `call_${responseCount}`,
          ));
        },
        executeTool: () => {
          executeCount += 1;
          return "FHIR summary";
        },
        maxToolContinuationRounds: 10,
        maxToolCalls: 2,
      }),
      /2-call tool limit/,
    );

    assert.equal(requests.length, 3);
    assert.equal(executeCount, 2);
    assert.equal(conversation.previousResponseId, "resp_stable");
  });

  it("stops repeated tool continuations at the configured round limit", async () => {
    let requestCount = 0;
    let executeCount = 0;
    const conversation = new ResponseConversation("resp_stable");

    await assert.rejects(
      conversation.run({
        request: { model: "gpt-5.5" },
        input: [{ role: "user", content: "Repeat the lookup." }],
        createResponse: async () => {
          requestCount += 1;
          return eventStream(functionCallResponse(
            `resp_tool_${requestCount}`,
            `call_${requestCount}`,
          ));
        },
        executeTool: () => {
          executeCount += 1;
          return "FHIR summary";
        },
        maxToolContinuationRounds: 1,
        maxToolCalls: 10,
      }),
      /1-round tool continuation limit/,
    );

    assert.equal(requestCount, 2);
    assert.equal(executeCount, 1);
    assert.equal(conversation.previousResponseId, "resp_stable");
  });

  it("restores the stable response ID when a tool continuation fails", async () => {
    const requests: ResponseCreateParamsStreaming[] = [];
    const conversation = new ResponseConversation("resp_stable");

    await assert.rejects(
      conversation.run({
        request: { model: "gpt-5.5" },
        input: [{ role: "user", content: "Look up my weight." }],
        createResponse: async (request) => {
          requests.push(request);
          if (requests.length === 1) {
            return eventStream(functionCallResponse("resp_tool", "call_1"));
          }
          throw new Error("Continuation unavailable");
        },
        executeTool: () => "FHIR summary",
      }),
      /Continuation unavailable/,
    );

    assert.equal(requests.length, 2);
    assert.equal(requests[0].previous_response_id, "resp_stable");
    assert.equal(requests[1].previous_response_id, "resp_tool");
    assert.equal(conversation.previousResponseId, "resp_stable");
  });

  it("restores the stable response ID when local tool execution fails", async () => {
    const conversation = new ResponseConversation("resp_stable");

    await assert.rejects(
      conversation.run({
        request: { model: "gpt-5.5" },
        input: [{ role: "user", content: "Look up my weight." }],
        createResponse: async () =>
          eventStream(functionCallResponse("resp_tool", "call_1")),
        executeTool: () => {
          throw new Error("Tool execution failed");
        },
      }),
      /Tool execution failed/,
    );

    assert.equal(conversation.previousResponseId, "resp_stable");
  });

  it("rejects partial incomplete responses without committing or executing tools", async () => {
    const conversation = new ResponseConversation("resp_stable");
    const displayedText: string[] = [];
    let executeCount = 0;
    const call = {
      type: "function_call",
      call_id: "call_1",
      name: "get_resources",
      arguments: "{}",
    };

    await assert.rejects(
      conversation.run({
        request: { model: "gpt-5.5" },
        input: [{ role: "user", content: "Look up my records." }],
        createResponse: async () => eventStream([
          event({ type: "response.output_text.delta", delta: "Partial answer" }),
          event({ type: "response.output_item.done", item: call }),
          event({
            type: "response.incomplete",
            response: {
              id: "resp_incomplete",
              incomplete_details: { reason: "max_output_tokens" },
              output: [call],
            },
          }),
        ]),
        executeTool: () => {
          executeCount += 1;
          return "FHIR summary";
        },
        onText: (text) => displayedText.push(text),
      }),
      /incomplete \(max output tokens\)/,
    );

    assert.deepEqual(displayedText, ["Partial answer"]);
    assert.equal(executeCount, 0);
    assert.equal(conversation.previousResponseId, "resp_stable");
  });
});
