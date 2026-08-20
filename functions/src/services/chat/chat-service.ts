//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import OpenAI from "openai";
import {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseOutputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import {ChatInterceptor} from "./chat-interceptor";


export type ResponseBody =
  | ResponseCreateParamsStreaming
  | ResponseCreateParamsNonStreaming;

/** Callback invoked for each chunk during a streaming response. */
export type OnChunk = (data: string) => Promise<boolean>;

const streamingErrorSequenceNumbers = new WeakMap<object, number>();

/** Returns the next event sequence number for an error raised while forwarding a stream. */
export function streamErrorSequenceNumber(error: unknown): number {
  return isObject(error) ? streamingErrorSequenceNumbers.get(error) ?? 0 : 0;
}

/**
 * Forwards Responses API requests and adapts non-streaming fallback responses
 * to the same event stream consumed by clients.
 */
export class ChatService {
  constructor(
    private readonly openai: OpenAI,
    readonly interceptors: ChatInterceptor[] = [],
    private readonly responsesStreamingSupported = true,
  ) {}

  async chatNonStreaming(body: ResponseCreateParamsNonStreaming): Promise<string> {
    const updatedBody = await this.applyInterceptors(body);
    const response = await this.openai.responses.create({
      ...updatedBody,
      stream: false,
    });
    return JSON.stringify(responseWithoutInstructions(response));
  }

  async chatStreaming(body: ResponseCreateParamsStreaming, onChunk: OnChunk): Promise<void> {
    const updatedBody = await this.applyInterceptors(body);
    let hasCommittedConversation = false;
    let receivedEvent = false;
    let nextForwardedSequenceNumber = 0;
    const forwardEvent = async (event: ResponseStreamEvent): Promise<boolean> => {
      const sanitizedEvent = eventWithoutInstructions(event);
      const shouldContinue = await onChunk(formatServerSentEvent(sanitizedEvent));
      nextForwardedSequenceNumber = Math.max(
        nextForwardedSequenceNumber,
        sanitizedEvent.sequence_number + 1,
      );
      return shouldContinue;
    };

    const forwardNonStreamingResponse = async (): Promise<void> => {
      const response = await this.openai.responses.create({
        ...updatedBody,
        stream: false,
      });
      for (const event of streamEvents(response)) {
        if (!await forwardEvent(event)) {
          return;
        }
      }
    };

    if (!this.responsesStreamingSupported) {
      try {
        await forwardNonStreamingResponse();
        return;
      } catch (error) {
        throw sequencedError(error, nextForwardedSequenceNumber);
      }
    }

    try {
      const stream = await this.openai.responses.create({
        ...updatedBody,
        stream: true,
      }, {maxRetries: 0});

      for await (const event of stream) {
        receivedEvent = true;
        hasCommittedConversation ||= eventCommitsConversation(event);
        if (!await forwardEvent(event)) {
          return;
        }
      }

      if (!receivedEvent || !hasCommittedConversation) {
        throw new IncompleteResponseStreamError();
      }
    } catch (error) {
      if (
        receivedEvent ||
        hasCommittedConversation ||
        !shouldRetryWithoutStreaming(error)
      ) {
        throw sequencedError(error, nextForwardedSequenceNumber);
      }

      console.warn(
        "Streaming the Responses API failed before producing output; retrying without streaming.",
      );
      try {
        await forwardNonStreamingResponse();
      } catch (fallbackError) {
        throw sequencedError(fallbackError, nextForwardedSequenceNumber);
      }
    }
  }

  private async applyInterceptors(body: ResponseBody): Promise<ResponseBody> {
    let current = body;
    for (const interceptor of this.interceptors) {
      current = await interceptor.intercept(current);
    }
    return current;
  }
}

class IncompleteResponseStreamError extends Error {
  constructor() {
    super("The upstream Responses API stream ended without a terminal event.");
    this.name = "IncompleteResponseStreamError";
  }
}

function shouldRetryWithoutStreaming(error: unknown): boolean {
  // Stanford's gateway answers `stream: true` with HTTP 500 before emitting an event for the reasoning
  // models: it puts `reasoning.effort: "none"` into its own `ResponseCreatedEvent`, which its event model
  // rejects. Streaming succeeds there only with an explicit effort, which would change what the model does,
  // so the request is replayed unstreamed instead. Non-reasoning models stream normally.
  // Never replay ambiguous connection failures, other server errors, or a request that already produced a
  // response identifier.
  return error instanceof OpenAI.APIError && error.status === 500;
}

function eventCommitsConversation(event: ResponseStreamEvent): boolean {
  switch (event.type) {
  case "response.completed":
  case "response.incomplete":
  case "response.failed":
  case "error":
    return true;
  default:
    return false;
  }
}

function formatServerSentEvent(event: ResponseStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function eventWithoutInstructions(event: ResponseStreamEvent): ResponseStreamEvent {
  switch (event.type) {
  case "response.created":
  case "response.in_progress":
  case "response.completed":
  case "response.incomplete":
  case "response.failed":
  case "response.queued":
    return {...event, response: responseWithoutInstructions(event.response)};
  default:
    return event;
  }
}

function responseWithoutInstructions(response: Response): Response {
  return {...response, instructions: null};
}

/**
 * Replays a completed response as the event sequence a streaming client expects.
 *
 * Used both by the non-streaming fallback and by the emulator mock, so the two cannot drift apart.
 */
export function* streamEvents(response: Response): Generator<ResponseStreamEvent> {
  response = responseWithoutInstructions(response);
  if (response.status === "queued" || response.status === "in_progress") {
    throw new Error(`Non-streaming response ended with status '${response.status}'.`);
  }

  let sequenceNumber = 0;
  const nextSequenceNumber = () => sequenceNumber++;
  const createdResponse: Response = {
    ...response,
    status: "in_progress",
    output: [],
    output_text: "",
    error: null,
    incomplete_details: null,
    completed_at: null,
    usage: undefined,
  };

  yield {
    type: "response.created",
    response: createdResponse,
    sequence_number: nextSequenceNumber(),
  };

  for (const [outputIndex, item] of response.output.entries()) {
    yield* outputItemEvents(item, outputIndex, nextSequenceNumber);
  }

  switch (response.status) {
  case "failed":
    yield {
      type: "response.failed",
      response,
      sequence_number: nextSequenceNumber(),
    };
    break;
  case "incomplete":
  case "cancelled":
    yield {
      type: "response.incomplete",
      response,
      sequence_number: nextSequenceNumber(),
    };
    break;
  default:
    yield {
      type: "response.completed",
      response,
      sequence_number: nextSequenceNumber(),
    };
  }
}

function sequencedError(error: unknown, sequenceNumber: number): unknown {
  const result = isObject(error) ? error : new Error(String(error));
  streamingErrorSequenceNumbers.set(result, sequenceNumber);
  return result;
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function* outputItemEvents(
  item: ResponseOutputItem,
  outputIndex: number,
  nextSequenceNumber: () => number,
): Generator<ResponseStreamEvent> {
  yield {
    type: "response.output_item.added",
    item: initialOutputItem(item),
    output_index: outputIndex,
    sequence_number: nextSequenceNumber(),
  };

  if (item.type === "reasoning") {
    for (const [summaryIndex, summary] of item.summary.entries()) {
      yield {
        type: "response.reasoning_summary_part.added",
        item_id: item.id,
        output_index: outputIndex,
        summary_index: summaryIndex,
        part: {...summary, text: ""},
        sequence_number: nextSequenceNumber(),
      };
      yield {
        type: "response.reasoning_summary_text.delta",
        item_id: item.id,
        output_index: outputIndex,
        summary_index: summaryIndex,
        delta: summary.text,
        sequence_number: nextSequenceNumber(),
      };
      yield {
        type: "response.reasoning_summary_text.done",
        item_id: item.id,
        output_index: outputIndex,
        summary_index: summaryIndex,
        text: summary.text,
        sequence_number: nextSequenceNumber(),
      };
      yield {
        type: "response.reasoning_summary_part.done",
        item_id: item.id,
        output_index: outputIndex,
        summary_index: summaryIndex,
        part: summary,
        sequence_number: nextSequenceNumber(),
      };
    }
  }

  if (item.type === "message") {
    for (const [contentIndex, content] of item.content.entries()) {
      const initialContent = content.type === "output_text" ?
        {...content, text: "", annotations: []} :
        {...content, refusal: ""};
      yield {
        type: "response.content_part.added",
        item_id: item.id,
        output_index: outputIndex,
        content_index: contentIndex,
        part: initialContent,
        sequence_number: nextSequenceNumber(),
      };
      if (content.type === "output_text") {
        yield {
          type: "response.output_text.delta",
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          delta: content.text,
          logprobs: content.logprobs ?? [],
          sequence_number: nextSequenceNumber(),
        };
        yield {
          type: "response.output_text.done",
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          text: content.text,
          logprobs: content.logprobs ?? [],
          sequence_number: nextSequenceNumber(),
        };
      } else {
        yield {
          type: "response.refusal.delta",
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          delta: content.refusal,
          sequence_number: nextSequenceNumber(),
        };
        yield {
          type: "response.refusal.done",
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          refusal: content.refusal,
          sequence_number: nextSequenceNumber(),
        };
      }
      yield {
        type: "response.content_part.done",
        item_id: item.id,
        output_index: outputIndex,
        content_index: contentIndex,
        part: content,
        sequence_number: nextSequenceNumber(),
      };
    }
  }

  if (item.type === "function_call") {
    const itemId = item.id ?? item.call_id;
    yield {
      type: "response.function_call_arguments.delta",
      item_id: itemId,
      output_index: outputIndex,
      delta: item.arguments,
      sequence_number: nextSequenceNumber(),
    };
    yield {
      type: "response.function_call_arguments.done",
      item_id: itemId,
      output_index: outputIndex,
      name: item.name,
      arguments: item.arguments,
      sequence_number: nextSequenceNumber(),
    };
  }

  yield {
    type: "response.output_item.done",
    item,
    output_index: outputIndex,
    sequence_number: nextSequenceNumber(),
  };
}

function initialOutputItem(item: ResponseOutputItem): ResponseOutputItem {
  switch (item.type) {
  case "message":
    return {...item, status: "in_progress", content: []};
  case "reasoning":
    return {...item, status: "in_progress", summary: [], content: []};
  case "function_call":
    return {...item, status: "in_progress", arguments: ""};
  default:
    return item;
  }
}
