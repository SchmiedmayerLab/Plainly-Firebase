//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import type {
  Response,
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseOutputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";

export const DEFAULT_MAX_TOOL_CONTINUATION_ROUNDS = 8;
export const DEFAULT_MAX_TOOL_CALLS = 16;
export const DEFAULT_RESPONSE_MODEL = "gpt-5.5";

export function resolveResponseModel(override?: string): string {
  return override?.trim() || DEFAULT_RESPONSE_MODEL;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ResponseProgress {
  text: string;
  toolCalls: ToolCall[];
  responseId?: string;
}

export interface ExecutedToolCall {
  call: ToolCall;
  output: string;
}

export interface ResponseToolRound {
  text: string;
  toolCalls: ExecutedToolCall[];
}

export interface ResponseTurnResult {
  text: string;
  responseId: string;
}

type ResponseRequest = Omit<
  ResponseCreateParamsStreaming,
  "input" | "previous_response_id" | "store" | "stream"
>;

export interface ResponseTurnOptions {
  request: ResponseRequest;
  input: ResponseInput;
  createResponse: (
    request: ResponseCreateParamsStreaming,
  ) => Promise<AsyncIterable<ResponseStreamEvent>>;
  executeTool: (call: ToolCall) => string;
  onEvent?: (event: ResponseStreamEvent) => boolean;
  onText?: (text: string) => void;
  onToolRound?: (round: ResponseToolRound) => void;
  maxToolContinuationRounds?: number;
  maxToolCalls?: number;
}

/**
 * Owns the last fully completed Responses conversation marker. Intermediate
 * tool-call response IDs are used only inside the active turn and never replace
 * the stable marker unless the complete tool loop succeeds.
 */
export class ResponseConversation {
  #previousResponseId: string | undefined;

  constructor(previousResponseId?: string) {
    this.#previousResponseId = previousResponseId;
  }

  get previousResponseId(): string | undefined {
    return this.#previousResponseId;
  }

  reset(): void {
    this.#previousResponseId = undefined;
  }

  async run(options: ResponseTurnOptions): Promise<ResponseTurnResult> {
    const stableResponseId = this.#previousResponseId;
    let previousResponseId = stableResponseId;
    let input = options.input;
    let toolContinuationRounds = 0;
    let toolCallCount = 0;
    const maxToolContinuationRounds =
      options.maxToolContinuationRounds ??
      DEFAULT_MAX_TOOL_CONTINUATION_ROUNDS;
    const maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;

    try {
      while (true) {
        const stream = await options.createResponse({
          ...options.request,
          input,
          previous_response_id: previousResponseId,
          store: true,
          stream: true,
        });
        let progress = emptyResponseProgress();

        for await (const event of stream) {
          if (options.onEvent?.(event)) {
            continue;
          }
          const priorText = progress.text;
          progress = applyResponseEvent(progress, event);
          if (progress.text !== priorText) {
            options.onText?.(progress.text);
          }
        }

        if (!progress.responseId) {
          throw new Error(
            "The response ended without a response identifier.",
          );
        }

        if (progress.toolCalls.length === 0) {
          this.#previousResponseId = progress.responseId;
          return { text: progress.text, responseId: progress.responseId };
        }

        if (toolContinuationRounds >= maxToolContinuationRounds) {
          throw new Error(
            `The assistant exceeded the ${maxToolContinuationRounds}-round tool continuation limit.`,
          );
        }
        if (toolCallCount + progress.toolCalls.length > maxToolCalls) {
          throw new Error(
            `The assistant exceeded the ${maxToolCalls}-call tool limit.`,
          );
        }

        const executedToolCalls = progress.toolCalls.map((call) => ({
          call,
          output: options.executeTool(call),
        }));
        options.onToolRound?.({
          text: progress.text,
          toolCalls: executedToolCalls,
        });

        toolContinuationRounds += 1;
        toolCallCount += executedToolCalls.length;
        previousResponseId = progress.responseId;
        const outputByCallId = new Map(
          executedToolCalls.map(({ call, output }) => [call.id, output]),
        );
        input = toolOutputInput(
          progress.toolCalls,
          (call) => outputByCallId.get(call.id) ?? "",
        );
      }
    } catch (error) {
      this.#previousResponseId = stableResponseId;
      throw error;
    }
  }
}

export function emptyResponseProgress(): ResponseProgress {
  return { text: "", toolCalls: [] };
}

/** Applies one Responses API event to the state displayed by the comparison client. */
export function applyResponseEvent(
  progress: ResponseProgress,
  event: ResponseStreamEvent,
): ResponseProgress {
  switch (event.type) {
    case "response.output_text.delta":
    case "response.refusal.delta":
      return { ...progress, text: progress.text + event.delta };
    case "response.output_item.done":
      return appendOutputItem(progress, event.item);
    case "response.completed":
      return applyCompletedResponse(progress, event.response);
    case "response.incomplete": {
      const reason = event.response.incomplete_details?.reason;
      throw new Error(
        reason ?
          `The response was incomplete (${reason.replaceAll("_", " ")}).` :
          "The response was incomplete.",
      );
    }
    case "response.failed":
      throw new Error(event.response.error?.message ?? "The model failed to generate a response.");
    case "error":
      throw new Error(event.message);
    default:
      return progress;
  }
}

/** Builds the input that continues a Responses API conversation after local tool execution. */
export function toolOutputInput(
  calls: ToolCall[],
  execute: (call: ToolCall) => string,
): ResponseInput {
  return calls.map((call) => ({
    type: "function_call_output" as const,
    call_id: call.id,
    output: execute(call),
  }));
}

function applyCompletedResponse(
  progress: ResponseProgress,
  response: Response,
): ResponseProgress {
  let updated: ResponseProgress = { ...progress, responseId: response.id };
  for (const item of response.output) {
    updated = appendOutputItem(updated, item);
  }
  const terminalText = response.output_text || response.output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content)
    .map((content) => content.type === "output_text" ? content.text : content.refusal)
    .join("");
  return terminalText ? { ...updated, text: terminalText } : updated;
}

function appendOutputItem(
  progress: ResponseProgress,
  item: ResponseOutputItem,
): ResponseProgress {
  if (item.type === "function_call") {
    if (progress.toolCalls.some((call) => call.id === item.call_id)) {
      return progress;
    }
    return {
      ...progress,
      toolCalls: [
        ...progress.toolCalls,
        { id: item.call_id, name: item.name, arguments: item.arguments },
      ],
    };
  }

  return progress;
}
