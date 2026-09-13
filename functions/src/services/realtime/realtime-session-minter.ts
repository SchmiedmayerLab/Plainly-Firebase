//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {
  ClientSecretCreateParams,
  ClientSecretCreateResponse,
} from "openai/resources/realtime/client-secrets";
import {RealtimeFunctionTool} from "openai/resources/realtime/realtime";
import {RealtimeSessionRequest} from "./realtime-session-request";

export const ASK_PLAINLY_TOOL_NAME = "ask_plainly";

/** The only tool a voice session gets: every participant turn is forwarded to the chat function through it. */
export const ASK_PLAINLY_TOOL: RealtimeFunctionTool = {
  type: "function",
  name: ASK_PLAINLY_TOOL_NAME,
  description:
    "Forwards the participant's spoken question to Plainly, the study's health record assistant, and returns " +
    "its answer. Call it for every participant turn and read the answer back to them.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The participant's question, in their own words.",
      },
    },
    required: ["question"],
    additionalProperties: false,
  },
};

const TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const MAX_OUTPUT_TOKENS = 2048;
// Only gates opening the session, which the client does right away; the session itself lives up to an hour.
const CLIENT_SECRET_LIFETIME_SECONDS = 120;

/** The slice of the OpenAI client that mints ephemeral realtime credentials. */
export interface RealtimeClientSecrets {
  create(body: ClientSecretCreateParams): Promise<ClientSecretCreateResponse>;
}

/** What a client receives: the ephemeral secret, the pinned session, and where to connect with it. */
export interface RealtimeSessionGrant extends ClientSecretCreateResponse {
  base_url: string;
}

/** Pins the session configuration server-side so the client can only ever choose what the request allows. */
export function realtimeSessionConfiguration(request: RealtimeSessionRequest): ClientSecretCreateParams {
  return {
    expires_after: {anchor: "created_at", seconds: CLIENT_SECRET_LIFETIME_SECONDS},
    session: {
      type: "realtime",
      model: request.model,
      instructions: request.instructions,
      output_modalities: ["audio"],
      max_output_tokens: MAX_OUTPUT_TOKENS,
      audio: {
        input: {
          transcription: {
            model: TRANSCRIPTION_MODEL,
            ...(request.language === undefined ? {} : {language: request.language}),
          },
          // No barge-in for now: on devices without echo cancellation the assistant's own voice would cut it off,
          // and the client holds its microphone while the assistant speaks for the same reason.
          turn_detection: {type: "semantic_vad", create_response: true, interrupt_response: false},
        },
        output: request.voice === undefined ? {} : {voice: request.voice},
      },
      tools: [ASK_PLAINLY_TOOL],
      // Required rather than naming the tool: gpt-realtime answers a named choice with the arguments as plain
      // text instead of a call. The client lifts it for the spoken reply.
      tool_choice: "required",
    },
  };
}

export class RealtimeSessionMinter {
  constructor(
    private readonly clientSecrets: RealtimeClientSecrets,
    private readonly baseUrl: string,
  ) {}

  async mint(request: RealtimeSessionRequest): Promise<RealtimeSessionGrant> {
    const response = await this.clientSecrets.create(realtimeSessionConfiguration(request));
    return {...response, base_url: this.baseUrl};
  }
}
