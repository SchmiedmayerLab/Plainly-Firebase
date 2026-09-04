//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {CallableRequest, HttpsError, onCall} from "firebase-functions/https";
import OpenAI from "openai";
import {Secrets, SERVICE_ACCOUNT} from "../env";
import {createChatService, ServiceOptions} from "../services/create-services";
import {ChatService, streamErrorSequenceNumber} from "../services/chat/chat-service";
import {parseResponseRequest} from "../services/chat/response-request";
import {
  ResponseOwnerAccessError,
  ResponseOwnerStore,
  ResponseOwnerStoreError,
} from "../services/chat/response-owner-store";

/** What the handler reaches for that a test replaces: services, ownership, and secrets. */
export interface ChatHandlerServices {
  createChatService: (options: ServiceOptions) => Pick<ChatService, "chatStreaming" | "chatNonStreaming">;
  responseOwners: Pick<ResponseOwnerStore, "assertAccess" | "bind">;
  openAIApiKey: () => string;
  openAIBaseUrl: () => string | undefined;
}

/** The slice of the callable's streaming response the handler uses. */
export interface ChatStreamingResponse {
  sendChunk(chunk: string): Promise<boolean>;
  /** Set once the client has gone; absent on transports that cannot tell. */
  signal?: AbortSignal;
}

export const chat = onCall(
  {
    secrets: [Secrets.OPENAI_API_KEY, Secrets.OPENAI_BASE_URL],
    serviceAccount: SERVICE_ACCOUNT,
    timeoutSeconds: 540,
    memory: "512MiB",
    // The iOS SDK fails a stream on the `: ping` heartbeat comment, and an unstreamed image generation is silent
    // for longer than the default 30 seconds.
    heartbeatSeconds: null,
  },
  async (req, res): Promise<string | void> => handleChatRequest(req, res),
);

export async function handleChatRequest(
  req: CallableRequest<unknown>,
  res: ChatStreamingResponse | undefined,
  services: ChatHandlerServices = {
    createChatService,
    responseOwners: new ResponseOwnerStore(),
    openAIApiKey: () => Secrets.OPENAI_API_KEY.value(),
    openAIBaseUrl: () => Secrets.OPENAI_BASE_URL.value(),
  },
): Promise<string | void> {
  if (!req.auth?.token) {
    throw new HttpsError("unauthenticated", "User must be authenticated");
  }

  const ragEnabled = req.rawRequest.query.ragEnabled === "true";
  // Per study, like RAG: the app asks for the hosted image generation tool only where a study allows it.
  const generatesImages = req.rawRequest.query.generatesImages === "true";

  const studyId = req.rawRequest.query.studyId;
  if (
    typeof studyId !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(studyId)
  ) {
    throw new HttpsError("invalid-argument", "Missing or invalid studyId query parameter");
  }

  let responseBody;
  try {
    responseBody = parseResponseRequest(req.data, {generatesImages});
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid Responses API request";
    // Logged because a rejected request never reaches the handler below, and a client that
    // trips the allowlist otherwise fails with no server-side trace of the reason.
    console.warn("Rejected Responses API request:", message);
    throw new HttpsError("invalid-argument", message);
  }
  const streamingResponse = responseBody.stream === true && req.acceptsStreaming ?
    res :
    undefined;
  const uid = req.auth.uid;
  const responseOwners = services.responseOwners;
  if (responseBody.previous_response_id) {
    try {
      await responseOwners.assertAccess(
        responseBody.previous_response_id,
        uid,
        studyId,
      );
    } catch (error) {
      if (error instanceof ResponseOwnerAccessError) {
        throw new HttpsError("permission-denied", error.message);
      }
      if (error instanceof ResponseOwnerStoreError) {
        console.error("Unable to validate response ownership:", error.cause);
        throw new HttpsError("unavailable", error.message);
      }
      throw error;
    }
  }

  const boundResponseIds = new Set<string>();
  const bindResponseOwner = async (payload: string): Promise<void> => {
    const responseId = responseIdFromPayload(payload);
    if (responseId && !boundResponseIds.has(responseId)) {
      await responseOwners.bind(responseId, uid, studyId);
      boundResponseIds.add(responseId);
    }
  };
  try {
    const chatService = services.createChatService({
      studyId,
      openAIApiKey: services.openAIApiKey(),
      openAIBaseUrl: services.openAIBaseUrl(),
      ragEnabled,
      mockScenario: typeof req.rawRequest.query.mockScenario === "string" ?
        req.rawRequest.query.mockScenario :
        undefined,
    });

    if (streamingResponse) {
      return await chatService.chatStreaming(
        {...responseBody, stream: true},
        async (chunk) => {
          // The client being gone is what ends the stream, checked before the write so nothing goes
          // to a closed connection and after it so a departure during the write is seen. `sendChunk`
          // resolves once the write has gone out; its `false` only says the socket buffer was full at
          // the time, which a frame the size of a generated image always causes.
          if (streamingResponse.signal?.aborted) {
            return false;
          }
          await bindResponseOwner(chunk);
          await streamingResponse.sendChunk(chunk);
          return !(streamingResponse.signal?.aborted ?? false);
        },
      );
    } else {
      const result = await chatService.chatNonStreaming({
        ...responseBody,
        stream: false,
      });
      await bindResponseOwner(result);
      return result;
    }
  } catch (error: unknown) {
    console.error("Error in chat endpoint:", error);
    if (streamingResponse) {
      await streamingResponse.sendChunk(formatStreamingErrorResponse(
        error,
        streamErrorSequenceNumber(error),
      ));
      return;
    }
    throw callableError(error);
  }
}

// ── Error formatting ────────────────────────────────────────────────────────

function formatStreamingErrorResponse(
  error: unknown,
  sequenceNumber: number,
): string {
  const isOpenAIError = error instanceof OpenAI.APIError;
  const apiError = isOpenAIError ? error : undefined;
  const openAIError = isOpenAIError ? apiError?.error : undefined;
  const fallbackMessage =
    error instanceof Error ? error.message : "Internal server error";

  const errorPayload = isOpenAIError ?
    {
      message: openAIError?.message ?? apiError?.message ?? "OpenAI error",
      type: openAIError?.type ?? "openai_error",
      code: openAIError?.code ?? null,
      param: openAIError?.param ?? null,
    } :
    {
      message: fallbackMessage,
      type: "server_error",
      code: null,
      param: null,
    };

  return `data: ${JSON.stringify({
    type: "error",
    code: errorPayload.code ?? null,
    message: errorPayload.message,
    param: errorPayload.param ?? null,
    sequence_number: sequenceNumber,
  })}\n\n`;
}

function callableError(error: unknown): HttpsError {
  const message = error instanceof Error ? error.message : "Internal server error";
  if (!(error instanceof OpenAI.APIError)) {
    return new HttpsError("internal", message);
  }

  switch (error.status) {
  case 400:
    return new HttpsError("invalid-argument", message);
  case 401:
    return new HttpsError("unauthenticated", message);
  case 403:
    return new HttpsError("permission-denied", message);
  case 404:
    return new HttpsError("not-found", message);
  case 409:
    return new HttpsError("aborted", message);
  case 429:
    return new HttpsError("resource-exhausted", message);
  default:
    return new HttpsError(
      error.status !== undefined && error.status >= 500 ? "unavailable" : "internal",
      message,
    );
  }
}

function responseIdFromPayload(payload: string): string | undefined {
  const json = payload.startsWith("data: ") ?
    payload.slice("data: ".length).trim() :
    payload;
  try {
    const value: unknown = JSON.parse(json);
    if (!isRecord(value)) return undefined;
    if (value.object === "response" && typeof value.id === "string") {
      return value.id;
    }
    const response = value.response;
    return isRecord(response) && typeof response.id === "string" ?
      response.id :
      undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
