//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {HttpsError, onCall} from "firebase-functions/https";
import OpenAI from "openai";
import {OPENAI_BASE_URL, Secrets, SERVICE_ACCOUNT} from "../env";
import {createChatService} from "../services/create-services";
import {streamErrorSequenceNumber} from "../services/chat/chat-service";
import {parseResponseRequest} from "../services/chat/response-request";
import {
  ResponseOwnerAccessError,
  ResponseOwnerStore,
  ResponseOwnerStoreError,
} from "../services/chat/response-owner-store";

export const chat = onCall(
  {
    secrets: [Secrets.OPENAI_API_KEY],
    serviceAccount: SERVICE_ACCOUNT,
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async (req, res): Promise<string | void> => {
    if (!req.auth?.token) {
      throw new HttpsError("unauthenticated", "User must be authenticated");
    }

    const ragEnabled = req.rawRequest.query.ragEnabled === "true";

    const studyId = req.rawRequest.query.studyId;
    if (
      typeof studyId !== "string" ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(studyId)
    ) {
      throw new HttpsError("invalid-argument", "Missing or invalid studyId query parameter");
    }

    let responseBody;
    try {
      responseBody = parseResponseRequest(req.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid Responses API request";
      // Logged because a rejected request never reaches the handler below, and a client that
      // trips the allowlist otherwise fails with no server-side trace of the reason.
      console.warn("Rejected Responses API request:", message);
      throw new HttpsError("invalid-argument", message);
    }
    const willStream = responseBody.stream === true &&
      req.acceptsStreaming && res !== undefined;
    const uid = req.auth.uid;
    const responseOwners = new ResponseOwnerStore();
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
      const chatService = createChatService({
        studyId,
        openAIApiKey: Secrets.OPENAI_API_KEY.value(),
        openAIBaseUrl: OPENAI_BASE_URL.value(),
        ragEnabled,
        mockScenario: typeof req.rawRequest.query.mockScenario === "string" ?
          req.rawRequest.query.mockScenario :
          undefined,
      });

      if (willStream) {
        return await chatService.chatStreaming(
          {...responseBody, stream: true},
          async (chunk) => {
            await bindResponseOwner(chunk);
            return res.sendChunk(chunk);
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
      if (willStream) {
        await res.sendChunk(formatStreamingErrorResponse(
          error,
          streamErrorSequenceNumber(error),
        ));
        return;
      }
      throw callableError(error);
    }
  },
);

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
