//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_INSTRUCTIONS_LENGTH = 32_000;

const ALLOWED_KEYS = new Set(["model", "instructions", "voice", "language"]);

// The languages the transcription model supports; a device set to another one is transcribed without a hint.
const TRANSCRIPTION_LANGUAGES = new Set([
  "af", "ar", "az", "be", "bg", "bs", "ca", "cs", "cy", "da", "de", "el", "en", "es", "et", "fa", "fi", "fr", "gl",
  "he", "hi", "hr", "hu", "hy", "id", "is", "it", "ja", "kk", "kn", "ko", "lt", "lv", "mi", "mk", "mr", "ms", "ne",
  "nl", "no", "pl", "pt", "ro", "ru", "sk", "sl", "sr", "sv", "sw", "ta", "th", "tl", "tr", "uk", "ur", "vi", "zh",
]);

const ALLOWED_MODELS = new Set([
  "gpt-realtime",
  "gpt-realtime-mini",
  "gpt-realtime-2.1",
  "gpt-realtime-2.1-mini",
]);

const ALLOWED_VOICES = new Set([
  "alloy", "ash", "ballad", "cedar", "coral", "echo", "marin", "sage", "shimmer", "verse",
]);

/** What a client may choose about a voice session; everything else is pinned by the server. */
export interface RealtimeSessionRequest {
  model: string;
  instructions: string;
  voice?: string;
  /** ISO 639-1 code steering the input transcription. */
  language?: string;
}

export function parseRealtimeSessionRequest(json: unknown): RealtimeSessionRequest {
  if (typeof json !== "string") {
    throw new Error("The realtime session request must be a JSON string.");
  }
  if (Buffer.byteLength(json, "utf8") > MAX_REQUEST_BYTES) {
    throw new Error("The realtime session request is too large.");
  }
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The realtime session request must be an object.");
  }
  const request = value as Record<string, unknown>;
  for (const key of Object.keys(request)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`Unsupported realtime session property '${key}'.`);
    }
  }
  if (typeof request.model !== "string" || !ALLOWED_MODELS.has(request.model)) {
    throw new Error("The requested realtime model is not enabled for Plainly.");
  }
  if (typeof request.instructions !== "string" || request.instructions.trim().length === 0) {
    throw new Error("The realtime session instructions are missing.");
  }
  if (request.instructions.length > MAX_INSTRUCTIONS_LENGTH) {
    throw new Error(`Realtime session instructions are limited to ${MAX_INSTRUCTIONS_LENGTH} characters.`);
  }
  if (request.voice !== undefined && (typeof request.voice !== "string" || !ALLOWED_VOICES.has(request.voice))) {
    throw new Error("The requested voice is not available.");
  }
  if (request.language !== undefined &&
      (typeof request.language !== "string" || !/^[a-z]{2}$/.test(request.language))) {
    throw new Error("The transcription language must be an ISO 639-1 code.");
  }
  return {
    model: request.model,
    instructions: request.instructions,
    voice: request.voice as string | undefined,
    language: TRANSCRIPTION_LANGUAGES.has(request.language as string) ? request.language as string : undefined,
  };
}
