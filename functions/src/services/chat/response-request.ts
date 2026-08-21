//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {ResponseInput} from "openai/resources/responses/responses";
import {ResponseBody} from "./chat-service";

// The Swift and web clients both stop at 7 MiB, so a larger bound here would never be the one that
// rejects an oversized request.
const MAX_REQUEST_BYTES = 7 * 1024 * 1024;
const MAX_INPUT_ITEMS = 512;
const MAX_INLINE_IMAGES = 2;
const MAX_INLINE_IMAGE_BYTES = 4_000_000;
const MAX_FUNCTION_TOOLS = 16;
const MAX_TOOL_SCHEMA_BYTES = 100_000;
const MAX_OUTPUT_TOKENS = 32_768;
// Gateways encode routing state into the identifier they return, so it is far longer than
// OpenAI's own `resp_…`; the bound only exists to keep an unbounded string out of Firestore.
const MAX_RESPONSE_ID_LENGTH = 4096;

/**
 * The request properties that steer sampling rather than describe the conversation.
 *
 * Nothing about the conversation is lost by leaving them out, which is what makes dropping them the right
 * answer for a model that will not take them.
 */
const SAMPLING_PARAMETERS = [
  "temperature",
  "top_p",
  "top_k",
  "presence_penalty",
  "frequency_penalty",
];

/**
 * The models Plainly may request, and whether each accepts the sampling controls of the Responses API.
 *
 * Support is declared per model rather than inferred from the identifier, because it does not follow the
 * naming: reasoning models and the current Claude generation reject `temperature` and `top_p` with a 400
 * instead of ignoring them, while their predecessors accept both. Adding a model therefore means answering
 * this question for it, and `samplingControlsByModel` is the one place that answer lives.
 */
const SAMPLING_CONTROL_SUPPORT = {
  "gpt-5.4": false,
  "gpt-5.5": false,
  "gpt-4o": true,
  "claude-opus-5": false,
  "claude-sonnet-5": false,
  "claude-haiku-4-5": true,
  "gemini-2.5-pro": true,
  "gemini-2.5-flash": true,
  "gemini-2.5-flash-lite": true,
  "Llama-4": true,
} as const satisfies Record<string, boolean>;

export const ALLOWED_MODELS: ReadonlySet<string> = new Set(Object.keys(SAMPLING_CONTROL_SUPPORT));

const ALLOWED_KEYS = new Set([
  "input",
  "instructions",
  "max_output_tokens",
  "metadata",
  "model",
  "parallel_tool_calls",
  "previous_response_id",
  "reasoning",
  "store",
  "stream",
  "temperature",
  "text",
  "tool_choice",
  "tools",
  "top_p",
  "truncation",
]);

const ALLOWED_INPUT_ITEM_TYPES = new Set([
  "message",
  "function_call",
  "function_call_output",
]);

/** Parses the narrow Responses API surface that Plainly clients use. */
export function parseResponseRequest(json: unknown): ResponseBody {
  if (typeof json !== "string") {
    throw new Error("The Responses API request must be a JSON string.");
  }
  if (Buffer.byteLength(json, "utf8") > MAX_REQUEST_BYTES) {
    throw new Error("The Responses API request is too large.");
  }

  const value: unknown = JSON.parse(json);
  if (!isRecord(value)) {
    throw new Error("The Responses API request must be an object.");
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`Unsupported Responses API property '${key}'.`);
    }
  }
  if (typeof value.model !== "string" || !ALLOWED_MODELS.has(value.model)) {
    throw new Error("The requested Responses API model is not enabled for Plainly.");
  }
  if (value.stream !== undefined && value.stream !== null &&
      typeof value.stream !== "boolean") {
    throw new Error("The Responses API stream property must be a Boolean.");
  }
  if (value.store !== undefined && value.store !== null &&
      typeof value.store !== "boolean") {
    throw new Error("The Responses API store property must be a Boolean.");
  }
  if (value.store === false) {
    throw new Error(
      "Plainly requires stored Responses API state for conversation continuation.",
    );
  }
  if (value.max_output_tokens !== undefined && value.max_output_tokens !== null &&
      (!Number.isInteger(value.max_output_tokens) ||
       (value.max_output_tokens as number) <= 0 ||
       (value.max_output_tokens as number) > MAX_OUTPUT_TOKENS)) {
    throw new Error(`Responses are limited to ${MAX_OUTPUT_TOKENS} output tokens.`);
  }
  if (value.previous_response_id !== undefined && value.previous_response_id !== null &&
      (typeof value.previous_response_id !== "string" ||
       value.previous_response_id.length === 0 ||
       value.previous_response_id.length > MAX_RESPONSE_ID_LENGTH)) {
    throw new Error("The Responses API previous response identifier is invalid.");
  }

  validateInput(value.input);
  validateTools(value.tools);
  validateToolChoice(value.tool_choice);
  return {...withoutUnsupportedSampling(value), store: true} as ResponseBody;
}

/**
 * Drops the sampling controls a reasoning model would reject.
 *
 * A client that pins a temperature for reproducibility should keep working when a study moves onto a
 * reasoning model, rather than having every request fail.
 */
function withoutUnsupportedSampling(value: Record<string, unknown>): Record<string, unknown> {
  const model = value.model as keyof typeof SAMPLING_CONTROL_SUPPORT;
  if (SAMPLING_CONTROL_SUPPORT[model]) {
    return value;
  }
  const remaining = {...value};
  for (const key of SAMPLING_PARAMETERS) {
    delete remaining[key];
  }
  return remaining;
}

function validateInput(input: unknown): void {
  if (input === undefined || typeof input === "string") {
    return;
  }
  if (!Array.isArray(input)) {
    throw new Error("The Responses API input must be a string or an array.");
  }
  if (input.length > MAX_INPUT_ITEMS) {
    throw new Error("The Responses API request contains too many input items.");
  }
  let inlineImageCount = 0;
  for (const item of input as ResponseInput) {
    if (!isRecord(item)) {
      throw new Error("Every Responses API input item must be an object.");
    }
    if (item.type !== undefined &&
        (typeof item.type !== "string" || !ALLOWED_INPUT_ITEM_TYPES.has(item.type))) {
      throw new Error(`Unsupported Responses API input item '${String(item.type)}'.`);
    }
    inlineImageCount += validateAttachments(item);
  }
  if (inlineImageCount > MAX_INLINE_IMAGES) {
    throw new Error(`Responses API requests are limited to ${MAX_INLINE_IMAGES} inline images.`);
  }
}

function validateTools(tools: unknown): void {
  if (tools === undefined || tools === null) {
    return;
  }
  if (!Array.isArray(tools) || tools.length > MAX_FUNCTION_TOOLS) {
    throw new Error("The Responses API request contains an invalid number of tools.");
  }
  for (const tool of tools) {
    if (!isRecord(tool) || tool.type !== "function" ||
        typeof tool.name !== "string" || tool.name.length === 0) {
      throw new Error("Only named client-side function tools are supported.");
    }
    if (Buffer.byteLength(JSON.stringify(tool.parameters ?? {}), "utf8") >
        MAX_TOOL_SCHEMA_BYTES) {
      throw new Error(`The schema for function '${tool.name}' is too large.`);
    }
  }
}

function validateToolChoice(toolChoice: unknown): void {
  if (toolChoice === undefined || toolChoice === null) {
    return;
  }
  if (typeof toolChoice === "string") {
    if (["auto", "none", "required"].includes(toolChoice)) {
      return;
    }
    throw new Error(`Unsupported Responses API tool choice '${toolChoice}'.`);
  }
  if (!isRecord(toolChoice) || toolChoice.type !== "function" ||
      typeof toolChoice.name !== "string" || toolChoice.name.length === 0) {
    throw new Error("Only client-side function tool choices are supported.");
  }
}

function validateAttachments(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + validateAttachments(item), 0);
  }
  if (!isRecord(value)) {
    return 0;
  }
  if (value.type === "input_file") {
    throw new Error("Chat file uploads are not enabled.");
  }
  if (value.type === "input_image") {
    validateInlineImage(value);
    return 1;
  }
  return Object.values(value).reduce<number>(
    (count, item) => count + validateAttachments(item),
    0,
  );
}

function validateInlineImage(image: Record<string, unknown>): void {
  const imageUrl = image.image_url;
  if (typeof imageUrl !== "string") {
    throw new Error("Inline images must contain a data URL.");
  }
  const match = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(imageUrl);
  if (!match) {
    throw new Error("Only inline JPEG and PNG data URLs are supported.");
  }
  const encoded = match[2];
  const decodedBytes = Math.floor(encoded.length * 3 / 4) -
    (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
  if (decodedBytes > MAX_INLINE_IMAGE_BYTES) {
    throw new Error(`Inline images are limited to ${MAX_INLINE_IMAGE_BYTES} bytes each.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
