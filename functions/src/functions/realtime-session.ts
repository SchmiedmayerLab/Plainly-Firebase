//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {CallableRequest, HttpsError, onCall} from "firebase-functions/https";
import OpenAI from "openai";
import {OpenAICredentials, realtimeCredentials, Secrets, SERVICE_ACCOUNT} from "../env";
import {createRealtimeSessionMinter, ServiceOptions} from "../services/create-services";
import {RealtimeSessionMinter} from "../services/realtime/realtime-session-minter";
import {parseRealtimeSessionRequest} from "../services/realtime/realtime-session-request";
import {
  RealtimeSessionLimitError,
  RealtimeSessionReservation,
  RealtimeSessionStore,
  RealtimeSessionStoreError,
} from "../services/realtime/realtime-session-store";
import {callableError, studyIdFromQuery} from "./callable-request";

/** What the handler reaches for that a test replaces: minting, the allowance, and secrets. */
export interface RealtimeSessionHandlerServices {
  createRealtimeSessionMinter: (options: ServiceOptions) => Pick<RealtimeSessionMinter, "mint">;
  sessions: Pick<RealtimeSessionStore, "reserve" | "release">;
  credentials: () => OpenAICredentials;
}

/**
 * Mints the ephemeral credential a client opens a voice session with.
 *
 * The session is pinned here: its only tool forwards each participant turn to the `chat` function, so the
 * voice layer never answers on its own. Audio itself never passes through Firebase; the client streams it
 * to the configured endpoint directly.
 */
export const realtimeSession = onCall(
  {
    secrets: [
      Secrets.OPENAI_API_KEY,
      Secrets.OPENAI_BASE_URL,
      Secrets.OPENAI_REALTIME_API_KEY,
      Secrets.OPENAI_REALTIME_BASE_URL,
    ],
    serviceAccount: SERVICE_ACCOUNT,
    timeoutSeconds: 30,
    memory: "256MiB",
  },
  async (req): Promise<string> => handleRealtimeSessionRequest(req),
);

export async function handleRealtimeSessionRequest(
  req: CallableRequest<unknown>,
  services: RealtimeSessionHandlerServices = {
    createRealtimeSessionMinter,
    sessions: new RealtimeSessionStore(),
    credentials: realtimeCredentials,
  },
): Promise<string> {
  if (!req.auth?.token) {
    throw new HttpsError("unauthenticated", "User must be authenticated");
  }
  const studyId = studyIdFromQuery(req);

  let request;
  try {
    request = parseRealtimeSessionRequest(req.data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid realtime session request";
    console.warn("Rejected realtime session request:", message);
    throw new HttpsError("invalid-argument", message);
  }

  let credentials: OpenAICredentials;
  try {
    credentials = services.credentials();
  } catch (error) {
    console.error("Voice sessions are misconfigured:", error);
    throw new HttpsError("failed-precondition", "Voice sessions are not configured.");
  }

  const uid = req.auth.uid;
  let reservation: RealtimeSessionReservation;
  try {
    reservation = await services.sessions.reserve(uid, studyId);
  } catch (error) {
    if (error instanceof RealtimeSessionLimitError) {
      throw new HttpsError("resource-exhausted", error.message);
    }
    if (error instanceof RealtimeSessionStoreError) {
      console.error("Unable to record the voice session:", error.cause);
      throw new HttpsError("unavailable", error.message);
    }
    throw error;
  }

  try {
    const minter = services.createRealtimeSessionMinter({
      studyId,
      openAIApiKey: credentials.apiKey,
      openAIBaseUrl: credentials.baseUrl,
    });
    const grant = await minter.mint(request);
    // The session identifier ties a provider-side session back to a participant when a secret leaks.
    console.info(`Minted realtime session ${grant.session.id} for user ${uid} in study ${studyId}`);
    return JSON.stringify(grant);
  } catch (error) {
    console.error("Error in realtime session endpoint:", error);
    // A session that never started does not count against the participant.
    await services.sessions.release(reservation).catch((releaseError: unknown) => {
      console.error("Unable to return the voice session allowance:", releaseError);
    });
    throw realtimeSessionError(error);
  }
}

/**
 * A provider failure as the participant sees it: they signed in, so a rejected key is the backend's configuration, and
 * the provider's own message stays in the logs.
 */
function realtimeSessionError(error: unknown): HttpsError {
  if (error instanceof OpenAI.APIError && (error.status === 401 || error.status === 403)) {
    return new HttpsError("failed-precondition", "Voice sessions are not available right now.");
  }
  return new HttpsError(callableError(error).code, "The voice session could not be started.");
}
