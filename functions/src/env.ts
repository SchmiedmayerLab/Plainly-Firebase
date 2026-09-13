//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {defineSecret} from "firebase-functions/params";

export const Secrets = {
  OPENAI_API_KEY: defineSecret("OPENAI_API_KEY"),
  OPENAI_BASE_URL: defineSecret("OPENAI_BASE_URL"),
  OPENAI_REALTIME_API_KEY: defineSecret("OPENAI_REALTIME_API_KEY"),
  OPENAI_REALTIME_BASE_URL: defineSecret("OPENAI_REALTIME_BASE_URL"),
};

export interface OpenAICredentials {
  apiKey: string;
  baseUrl: string | undefined;
}

function chatCredentials(): OpenAICredentials {
  return {
    apiKey: Secrets.OPENAI_API_KEY.value(),
    baseUrl: Secrets.OPENAI_BASE_URL.value().trim() || undefined,
  };
}

/**
 * The key and endpoint voice sessions are minted for, and therefore the endpoint the client streams its audio to.
 *
 * A gateway that serves chat need not serve realtime yet, so voice can be pointed elsewhere on its own: set a
 * realtime key and the realtime pair is used, leave it empty and voice shares the chat pair.
 */
export function realtimeCredentials(): OpenAICredentials {
  const apiKey = Secrets.OPENAI_REALTIME_API_KEY.value().trim();
  if (!apiKey) {
    return chatCredentials();
  }
  const baseUrl = Secrets.OPENAI_REALTIME_BASE_URL.value().trim();
  // Without its endpoint the key would go to the SDK's default one, which need not be where it belongs.
  if (!baseUrl) {
    throw new Error("OPENAI_REALTIME_BASE_URL must be set whenever OPENAI_REALTIME_API_KEY is.");
  }
  return {apiKey, baseUrl};
}

export const SERVICE_ACCOUNT = `cloud-function-sa@${process.env.GCLOUD_PROJECT}.iam.gserviceaccount.com`;

export const STORAGE_BUCKET =
  process.env.STORAGE_BUCKET || `${process.env.GCLOUD_PROJECT}.firebasestorage.app`;

export const STORAGE_REGION = process.env.STORAGE_REGION || "us-central1";

export const STORAGE_FILE_PATH_PATTERN =
  /studies\/(?<studyId>[^/]+)\/rag_files\/(?<fileName>[^/]+)$/;

export const VERBOSE_LOGGING = process.env.VERBOSE_LOGGING === "true";

/**
 * Returns a deterministic chat response when explicitly configured for the
 * Firebase emulator. Production runtimes always return `undefined`.
 */
export function emulatorMockChatResponse(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (environment.FUNCTIONS_EMULATOR !== "true") {
    return undefined;
  }
  const response = environment.PLAINLY_MOCK_CHAT_RESPONSE?.trim();
  return response ? response : undefined;
}
