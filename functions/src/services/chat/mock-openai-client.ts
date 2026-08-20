//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Ajv from "ajv";
import {randomUUID} from "node:crypto";
import OpenAI from "openai";
import {
  Response,
  ResponseFunctionToolCall,
  ResponseOutputMessage,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import {ResponseBody, streamEvents} from "./chat-service";

const schemaValidator = new Ajv({strict: false});

export interface MockOpenAIClientOptions {
  rejectRequest?: boolean;
  rejectStreamingRequest?: boolean;
  rejectStreamAfterFirstChunk?: boolean;
  returnEmptyStream?: boolean;
  validateResponseState?: boolean;
  returnFunctionCall?: boolean;
}

const EXPECTED_CONTINUATION = "Tell me more about my health records.";
const MOCK_FUNCTION_CALL_ID = "call-plainly-emulator-get-resources";
const MOCK_RESOURCE_SUMMARY = "Mock health record\nNested resource summary completed.";

/** Creates the minimal OpenAI Responses client surface used by ChatService. */
export function createMockOpenAIClient(
  responseText: string,
  options: MockOpenAIClientOptions = {},
): OpenAI {
  return {
    responses: {
      create: async (body: ResponseBody) => {
        validateToolSchemas(body.tools);
        if (options.validateResponseState) {
          validateIncrementalResponseState(body);
        }
        if (options.rejectRequest) {
          throw mockApiError(
            400,
            "Mock response request failed.",
            "mock_response_request",
          );
        }
        if (body.stream && options.rejectStreamingRequest) {
          throw mockApiError(
            500,
            "Mock response streaming is unavailable.",
            "mock_response_stream",
          );
        }
        const responseId = `resp-plainly-emulator-${randomUUID()}`;
        const messageId = `msg-plainly-emulator-${randomUUID()}`;
        const hasGetResourcesTool = advertisesGetResourcesTool(body);
        if (options.returnFunctionCall && hasGetResourcesTool && !hasFunctionCallOutput(body)) {
          const response = mockFunctionCallResponse(
            body.model ?? "test-model",
            responseId,
            body.previous_response_id,
          );
          return body.stream ? responseEvents([...streamEvents(response)]) : response;
        }
        if (options.returnFunctionCall && hasFunctionCallOutput(body)) {
          validateFunctionCallOutput(body);
        }
        const outputText = options.returnFunctionCall && !hasGetResourcesTool ?
          MOCK_RESOURCE_SUMMARY :
          responseText;
        if (body.stream) {
          return options.returnEmptyStream ?
            emptyResponseStream() :
            mockResponseStream(
              body.model ?? "test-model",
              outputText,
              responseId,
              messageId,
              body.previous_response_id,
              options.rejectStreamAfterFirstChunk,
            );
        }
        return mockResponse(
          body.model ?? "test-model",
          outputText,
          responseId,
          messageId,
          body.previous_response_id,
        );
      },
    },
  } as unknown as OpenAI;
}

function validateToolSchemas(tools: ResponseBody["tools"]): void {
  tools?.forEach((tool, index) => {
    if (tool.type !== "function" || tool.parameters === null) {
      return;
    }
    if (!schemaValidator.validateSchema(tool.parameters)) {
      const path = `tools[${index}].parameters`;
      throw mockApiError(
        400,
        `Invalid schema for function '${tool.name}': ${schemaValidator.errorsText()}.`,
        path,
      );
    }
  });
}

function mockApiError(status: number, message: string, param: string): Error {
  return OpenAI.APIError.generate(
    status,
    {
      error: {
        message,
        type: "invalid_request_error",
        code: status >= 500 ? "server_error" : "invalid_function_parameters",
        param,
      },
    },
    undefined,
    new Headers(),
  );
}

function mockOutputMessage(
  responseText: string,
  messageId: string,
): ResponseOutputMessage {
  return {
    id: messageId,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{type: "output_text", text: responseText, annotations: []}],
  };
}

function mockResponse(
  model: string,
  responseText: string,
  responseId: string,
  messageId: string,
  previousResponseId?: string | null,
): Response {
  return {
    id: responseId,
    object: "response",
    created_at: 0,
    status: "completed",
    model,
    output: [mockOutputMessage(responseText, messageId)],
    output_text: responseText,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    metadata: {},
    parallel_tool_calls: true,
    previous_response_id: previousResponseId ?? null,
    reasoning: null,
    store: true,
    temperature: 1,
    text: {format: {type: "text"}},
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
  } as Response;
}

function emptyResponseStream(): AsyncIterable<ResponseStreamEvent> {
  return responseEvents([]);
}

async function* responseEvents(
  events: ResponseStreamEvent[],
): AsyncGenerator<ResponseStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

async function* mockResponseStream(
  model: string,
  responseText: string,
  responseId: string,
  messageId: string,
  previousResponseId?: string | null,
  rejectAfterFirstChunk = false,
): AsyncGenerator<ResponseStreamEvent> {
  const response = mockResponse(model, responseText, responseId, messageId, previousResponseId);
  const message = mockOutputMessage(responseText, messageId);
  let sequenceNumber = 0;

  yield {
    type: "response.created",
    response: {
      ...response,
      status: "in_progress",
      output: [],
      output_text: "",
    },
    sequence_number: sequenceNumber++,
  };
  yield {
    type: "response.output_item.added",
    item: {...message, status: "in_progress", content: []},
    output_index: 0,
    sequence_number: sequenceNumber++,
  };
  yield {
    type: "response.content_part.added",
    item_id: messageId,
    output_index: 0,
    content_index: 0,
    part: {type: "output_text", text: "", annotations: []},
    sequence_number: sequenceNumber++,
  };

  const codePoints = Array.from(responseText);
  const splitIndex = Math.ceil(codePoints.length / 2);
  for (const [index, delta] of [
    codePoints.slice(0, splitIndex).join(""),
    codePoints.slice(splitIndex).join(""),
  ].entries()) {
    if (!delta) {
      continue;
    }
    yield {
      type: "response.output_text.delta",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      delta,
      logprobs: [],
      sequence_number: sequenceNumber++,
    };
    if (index === 0 && rejectAfterFirstChunk) {
      throw mockApiError(
        500,
        "Mock response stream failed after its first chunk.",
        "mock_response_stream",
      );
    }
  }

  yield {
    type: "response.output_text.done",
    item_id: messageId,
    output_index: 0,
    content_index: 0,
    text: responseText,
    logprobs: [],
    sequence_number: sequenceNumber++,
  };
  yield {
    type: "response.content_part.done",
    item_id: messageId,
    output_index: 0,
    content_index: 0,
    part: message.content[0],
    sequence_number: sequenceNumber++,
  };
  yield {
    type: "response.output_item.done",
    item: message,
    output_index: 0,
    sequence_number: sequenceNumber++,
  };
  yield {
    type: "response.completed",
    response,
    sequence_number: sequenceNumber,
  };
}

function validateIncrementalResponseState(body: ResponseBody): void {
  const items = responseInputItems(body);
  const containsExpectedContinuation = items.some(
    (item) => inputText(item) === EXPECTED_CONTINUATION,
  );
  if (!containsExpectedContinuation) {
    return;
  }
  if (!body.previous_response_id || items.length !== 1) {
    throw mockApiError(
      400,
      "The follow-up must use previous_response_id and contain only the new user input.",
      "previous_response_id",
    );
  }
}

function advertisesGetResourcesTool(body: ResponseBody): boolean {
  return body.tools?.some(
    (tool) => tool.type === "function" && tool.name === "get_resources",
  ) ?? false;
}

function hasFunctionCallOutput(body: ResponseBody): boolean {
  return responseInputItems(body).some((item) => item.type === "function_call_output");
}

function validateFunctionCallOutput(body: ResponseBody): void {
  const items = responseInputItems(body);
  const output = items.find((item) => item.type === "function_call_output");
  if (!body.previous_response_id) {
    throw mockApiError(
      400,
      "The function result must continue a previous response.",
      "previous_response_id",
    );
  }
  if (items.length !== 1) {
    throw mockApiError(
      400,
      "The function continuation must contain only its function output.",
      "input",
    );
  }
  if (output?.call_id !== MOCK_FUNCTION_CALL_ID) {
    throw mockApiError(
      400,
      "The function result must continue the response with its matching call identifier.",
      "input[0].call_id",
    );
  }
  if (typeof output.output !== "string" || !output.output.includes(MOCK_RESOURCE_SUMMARY)) {
    throw mockApiError(
      400,
      "The function result must contain the nested resource summary.",
      "input[0].output",
    );
  }
}

function responseInputItems(body: ResponseBody): Array<Record<string, unknown>> {
  if (!Array.isArray(body.input)) return [];
  return (body.input as unknown[]).filter(
    (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
  );
}

function inputText(item: Record<string, unknown>): string | undefined {
  if (item.role !== "user") return undefined;
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return undefined;
  const inputText = item.content.find(
    (content) => typeof content === "object" && content !== null && content.type === "input_text",
  );
  return inputText && "text" in inputText && typeof inputText.text === "string" ?
    inputText.text :
    undefined;
}

function mockFunctionCallResponse(
  model: string,
  responseId: string,
  previousResponseId?: string | null,
): Response {
  const functionCall: ResponseFunctionToolCall = {
    id: `item-${MOCK_FUNCTION_CALL_ID}`,
    type: "function_call",
    call_id: MOCK_FUNCTION_CALL_ID,
    name: "get_resources",
    arguments: JSON.stringify({resourceCategories: ["Observation"]}),
    status: "completed",
  };
  return {
    ...mockResponse(model, "", responseId, `msg-${responseId}`, previousResponseId),
    output: [functionCall],
    output_text: "",
  };
}
