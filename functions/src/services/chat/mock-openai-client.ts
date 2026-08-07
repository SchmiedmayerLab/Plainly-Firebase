//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import OpenAI from "openai";
import {ChatBody} from "./chat-service";

const completionId = "chatcmpl-plainly-emulator";

/** Creates the minimal OpenAI client surface used by ChatService. */
export function createMockOpenAIClient(response: string): OpenAI {
  return {
    chat: {
      completions: {
        create: async (body: ChatBody) => {
          if (body.stream) {
            return mockCompletionStream(body.model, response);
          }
          return mockCompletion(body.model, response);
        },
      },
    },
  } as unknown as OpenAI;
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
  yield {
    id: completionId,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{
      index: 0,
      delta: {role: "assistant", content: response},
      logprobs: null,
      finish_reason: null,
    }],
  };
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
