//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Ajv from "ajv";
import OpenAI from "openai";
import {ChatBody} from "./chat-service";

const completionId = "chatcmpl-plainly-emulator";
const schemaValidator = new Ajv({strict: false});

interface MockOpenAIClientOptions {
  rejectRequest?: boolean;
}

/** Creates the minimal OpenAI client surface used by ChatService. */
export function createMockOpenAIClient(
  response: string,
  options: MockOpenAIClientOptions = {},
): OpenAI {
  return {
    chat: {
      completions: {
        create: async (body: ChatBody) => {
          validateToolSchemas(body.tools);
          if (options.rejectRequest) {
            throw mockBadRequestError(
              "Mock chat request failed.",
              "mock_chat_request",
            );
          }
          if (body.stream) {
            return mockCompletionStream(body.model, response);
          }
          return mockCompletion(body.model, response);
        },
      },
    },
  } as unknown as OpenAI;
}

function validateToolSchemas(tools: ChatBody["tools"]): void {
  tools?.forEach((tool, index) => {
    if (tool.type !== "function" || tool.function.parameters === undefined) {
      return;
    }
    if (!schemaValidator.validateSchema(tool.function.parameters)) {
      const path = `tools[${index}].function.parameters`;
      throw mockBadRequestError(
        `Invalid schema for function '${tool.function.name}': ${schemaValidator.errorsText()}.`,
        path,
      );
    }
  });
}

function mockBadRequestError(message: string, param: string): Error {
  return OpenAI.APIError.generate(
    400,
    {
      error: {
        message,
        type: "invalid_request_error",
        code: "invalid_function_parameters",
        param,
      },
    },
    undefined,
    new Headers(),
  );
}

function mockCompletion(model: string, response: string) {
  return {
    id: completionId,
    object: "chat.completion",
    created: 0,
    model,
    choices: [{
      index: 0,
      message: {role: "assistant", content: response, refusal: null},
      logprobs: null,
      finish_reason: "stop",
    }],
    usage: {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0},
  };
}

async function* mockCompletionStream(model: string, response: string) {
  const splitIndex = Math.ceil(response.length / 2);
  for (const content of [response.slice(0, splitIndex), response.slice(splitIndex)]) {
    if (!content) {
      continue;
    }
    yield {
      id: completionId,
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{
        index: 0,
        delta: {role: "assistant", content},
        logprobs: null,
        finish_reason: null,
      }],
    };
  }
  yield {
    id: completionId,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{
      index: 0,
      delta: {},
      logprobs: null,
      finish_reason: "stop",
    }],
  };
}
