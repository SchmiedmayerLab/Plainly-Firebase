//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {CallableRequest, HttpsError} from "firebase-functions/https";
import OpenAI from "openai";
import {handleRealtimeSessionRequest, RealtimeSessionHandlerServices} from "../src/functions/realtime-session";
import {ServiceOptions} from "../src/services/create-services";
import {RealtimeSessionGrant} from "../src/services/realtime/realtime-session-minter";
import {
  RealtimeSessionLimitError,
  RealtimeSessionStoreError,
} from "../src/services/realtime/realtime-session-store";

describe("realtime session callable handler", () => {
  it("rejects an unauthenticated request", async () => {
    await assert.rejects(
      handleRealtimeSessionRequest(request({auth: undefined}), services()),
      httpsError("unauthenticated"),
    );
  });

  it("rejects a missing study and a malformed body without touching the allowance", async () => {
    const untouched = services();
    await assert.rejects(
      handleRealtimeSessionRequest(request({query: {}}), untouched),
      httpsError("invalid-argument"),
    );
    await assert.rejects(
      handleRealtimeSessionRequest(request({data: "{}"}), untouched),
      httpsError("invalid-argument"),
    );
    assert.deepEqual(untouched.reserved, []);
  });

  it("maps the allowance onto callable error codes", async () => {
    await assert.rejects(
      handleRealtimeSessionRequest(
        request(),
        services({reserve: () => Promise.reject(new RealtimeSessionLimitError())}),
      ),
      httpsError("resource-exhausted"),
    );
    await assert.rejects(
      handleRealtimeSessionRequest(
        request(),
        services({reserve: () => Promise.reject(new RealtimeSessionStoreError(new Error("io")))}),
      ),
      httpsError("unavailable"),
    );
    await assert.rejects(
      handleRealtimeSessionRequest(request(), services({reserve: () => Promise.reject(new Error("odd"))})),
      (error: unknown) => error instanceof Error && error.message === "odd",
    );
  });

  it("reserves the allowance before minting and returns the grant", async () => {
    const active = services();

    const result = await handleRealtimeSessionRequest(request(), active);

    assert.deepEqual(active.reserved, [["user-1", "study-1"]]);
    assert.equal(active.serviceOptions?.studyId, "study-1");
    assert.equal(active.serviceOptions?.openAIApiKey, "test-key");
    assert.equal(active.serviceOptions?.openAIBaseUrl, undefined);
    assert.deepEqual(
      active.minted,
      [{model: "gpt-realtime", instructions: "Hi", voice: undefined, language: undefined}],
    );
    assert.equal(JSON.parse(result).value, "ek_test");
  });

  it("maps provider failures onto callable error codes and returns the allowance", async () => {
    const failing = services({mint: () => Promise.reject(mockApiError(401))});

    await assert.rejects(
      handleRealtimeSessionRequest(request(), failing),
      (error: unknown) => error instanceof HttpsError && error.code === "failed-precondition" &&
        !error.message.includes("Mock API error"),
    );
    assert.equal(failing.released, 1);
  });

  it("keeps the provider's failure when the allowance cannot be returned", async () => {
    const failing = services({
      mint: () => Promise.reject(mockApiError(503)),
      release: () => Promise.reject(new Error("offline")),
    });

    await assert.rejects(handleRealtimeSessionRequest(request(), failing), httpsError("unavailable"));
  });

  it("refuses to mint without touching the allowance when voice is misconfigured", async () => {
    const misconfigured = services({credentials: () => {
      throw new Error("OPENAI_REALTIME_BASE_URL must be set");
    }});

    await assert.rejects(handleRealtimeSessionRequest(request(), misconfigured), httpsError("failed-precondition"));
    assert.deepEqual(misconfigured.reserved, []);
    assert.equal(misconfigured.released, 0);
  });
});

interface RequestOverrides {
  auth?: {uid: string; token: object} | undefined;
  query?: Record<string, string>;
  data?: unknown;
}

function request(overrides: RequestOverrides = {}): CallableRequest<unknown> {
  const value = {
    auth: "auth" in overrides ? overrides.auth : {uid: "user-1", token: {}},
    data: "data" in overrides ? overrides.data : JSON.stringify({model: "gpt-realtime", instructions: "Hi"}),
    rawRequest: {query: overrides.query ?? {studyId: "study-1"}},
  };
  return value as unknown as CallableRequest<unknown>;
}

interface FakeServices extends RealtimeSessionHandlerServices {
  reserved: [string, string][];
  released: number;
  minted: unknown[];
  serviceOptions?: ServiceOptions;
}

interface ServiceOverrides {
  reserve?: () => Promise<void>;
  release?: () => Promise<void>;
  mint?: () => Promise<RealtimeSessionGrant>;
  credentials?: () => {apiKey: string; baseUrl: string | undefined};
}

function services(overrides: ServiceOverrides = {}): FakeServices {
  const fake: FakeServices = {
    reserved: [],
    released: 0,
    minted: [],
    createRealtimeSessionMinter: (options) => {
      fake.serviceOptions = options;
      return {
        mint: async (sessionRequest) => {
          fake.minted.push(sessionRequest);
          return overrides.mint ? overrides.mint() : grant();
        },
      };
    },
    sessions: {
      reserve: async (uid, studyId) => {
        fake.reserved.push([uid, studyId]);
        await overrides.reserve?.();
        return {uid, createdAtMillis: 1};
      },
      release: async () => {
        fake.released += 1;
        await overrides.release?.();
      },
    },
    credentials: overrides.credentials ?? (() => ({apiKey: "test-key", baseUrl: undefined})),
  };
  return fake;
}

function grant(): RealtimeSessionGrant {
  return {
    value: "ek_test",
    expires_at: 1,
    session: {id: "sess_test", object: "realtime.session", type: "realtime"},
    base_url: "https://x/v1",
  };
}

function httpsError(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof HttpsError && error.code === code;
}

function mockApiError(status: number): OpenAI.APIError {
  return OpenAI.APIError.generate(
    status,
    {error: {message: "Mock API error", type: "server_error"}},
    undefined,
    new Headers(),
  );
}
