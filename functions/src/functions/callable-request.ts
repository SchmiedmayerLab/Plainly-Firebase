//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {CallableRequest, HttpsError} from "firebase-functions/https";
import OpenAI from "openai";

const STUDY_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** Returns the study named by the callable's query, or rejects the request when it is missing or unsafe. */
export function studyIdFromQuery(req: CallableRequest<unknown>): string {
  const studyId = req.rawRequest.query.studyId;
  if (typeof studyId !== "string" || !STUDY_ID_PATTERN.test(studyId)) {
    throw new HttpsError("invalid-argument", "Missing or invalid studyId query parameter");
  }
  return studyId;
}

/** Maps a provider failure onto the callable error code a client can act on. */
export function callableError(error: unknown): HttpsError {
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
