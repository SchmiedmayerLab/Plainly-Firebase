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
};

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
