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
import {ChatHandlerServices, handleChatRequest} from "../src/functions/chat";
import {
  ResponseOwnerAccessError,
  ResponseOwnerStoreError,
} from "../src/services/chat/response-owner-store";

describe("chat callable handler", () => {
  it("rejects an unauthenticated request", async () => {
    await assert.rejects(
      handleChatRequest(request({auth: undefined}), undefined, services()),
      httpsError("unauthenticated"),
    );
  });

  it("rejects a missing or malformed studyId", async () => {
    await assert.rejects(
      handleChatRequest(request({query: {}}), undefined, services()),
      httpsError("invalid-argument"),
    );
    await assert.rejects(
      handleChatRequest(request({query: {studyId: "bad/id"}}), undefined, services()),
      httpsError("invalid-argument"),
    );
  });

  it("rejects a request body the allowlist refuses", async () => {
    await assert.rejects(
      handleChatRequest(request({data: body({evil: true})}), undefined, services()),
      httpsError("invalid-argument"),
    );
  });

  it("maps ownership failures onto callable error codes", async () => {
    const denied = services({
      assertAccess: () => Promise.reject(new ResponseOwnerAccessError("not yours")),
    });
    await assert.rejects(
      handleChatRequest(request({data: continuationBody()}), undefined, denied),
      httpsError("permission-denied"),
    );

    const unavailable = services({
      assertAccess: () => Promise.reject(new ResponseOwnerStoreError("store down", new Error("io"))),
    });
    await assert.rejects(
      handleChatRequest(request({data: continuationBody()}), undefined, unavailable),
      httpsError("unavailable"),
    );

    const broken = services({
      assertAccess: () => Promise.reject(new Error("unrelated")),
    });
    await assert.rejects(
      handleChatRequest(request({data: continuationBody()}), undefined, broken),
      (error: unknown) => error instanceof Error && error.message === "unrelated",
    );
  });

  it("answers unstreamed and binds the response to its owner once", async () => {
    const active = services({
      nonStreaming: async () => JSON.stringify({object: "response", id: "resp-1"}),
    });

    const result = await handleChatRequest(request(), undefined, active);

    assert.equal(result, JSON.stringify({object: "response", id: "resp-1"}));
    assert.deepEqual(active.bound, [["resp-1", "user-1", "study-1"]]);
    assert.deepEqual(active.serviceOptions?.studyId, "study-1");
  });

  it("streams chunks through the response and deduplicates owner binding", async () => {
    const chunks = [
      "data: {\"type\": \"response.created\", \"response\": {\"id\": \"resp-2\"}}\n\n",
      "data: not json\n\n",
      "data: {\"type\": \"response.completed\", \"response\": {\"id\": \"resp-2\"}}\n\n",
    ];
    const active = services({
      streaming: async (onChunk) => {
        for (const chunk of chunks) {
          await onChunk(chunk);
        }
      },
    });
    const stream = streamRecorder();

    const result = await handleChatRequest(
      request({data: continuationBody({stream: true}), acceptsStreaming: true}),
      stream,
      active,
    );

    assert.equal(result, undefined);
    assert.deepEqual(stream.chunks, chunks);
    assert.deepEqual(active.bound, [["resp-2", "user-1", "study-1"]]);
  });

  it("falls back to an unstreamed answer when the transport cannot stream", async () => {
    const active = services({
      nonStreaming: async () => JSON.stringify({object: "response", id: "resp-3"}),
    });

    const result = await handleChatRequest(
      request({data: continuationBody({stream: true}), acceptsStreaming: false}),
      undefined,
      active,
    );

    assert.equal(result, JSON.stringify({object: "response", id: "resp-3"}));
  });

  it("reports a streaming failure as a terminal error event", async () => {
    const active = services({
      streaming: () => Promise.reject(mockApiError(429)),
    });
    const stream = streamRecorder();

    const result = await handleChatRequest(
      request({data: continuationBody({stream: true}), acceptsStreaming: true}),
      stream,
      active,
    );

    assert.equal(result, undefined);
    assert.equal(stream.chunks.length, 1);
    const event = JSON.parse(stream.chunks[0].slice("data: ".length)) as Record<string, unknown>;
    assert.equal(event.type, "error");
    assert.equal(typeof event.sequence_number, "number");
  });

  it("maps unstreamed provider failures onto callable error codes", async () => {
    const cases: [number | undefined, string][] = [
      [400, "invalid-argument"],
      [401, "unauthenticated"],
      [403, "permission-denied"],
      [404, "not-found"],
      [409, "aborted"],
      [429, "resource-exhausted"],
      [503, "unavailable"],
      [undefined, "internal"],
    ];
    for (const [status, code] of cases) {
      const failing = services({
        nonStreaming: () => Promise.reject(status === undefined ? new Error("boom") : mockApiError(status)),
      });
      await assert.rejects(
        handleChatRequest(request(), undefined, failing),
        httpsError(code),
      );
    }
  });
});

interface RequestOverrides {
  auth?: {uid: string; token: object} | undefined;
  query?: Record<string, string>;
  data?: unknown;
  acceptsStreaming?: boolean;
}

function request(overrides: RequestOverrides = {}): CallableRequest<unknown> {
  const value = {
    auth: "auth" in overrides ? overrides.auth : {uid: "user-1", token: {}},
    data: "data" in overrides ? overrides.data : body(),
    acceptsStreaming: overrides.acceptsStreaming ?? false,
    rawRequest: {query: overrides.query ?? {studyId: "study-1"}},
  };
  return value as unknown as CallableRequest<unknown>;
}

function body(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({model: "gpt-5.5", input: [{role: "user", content: "Hello"}], ...extra});
}

function continuationBody(extra: Record<string, unknown> = {}): string {
  return body({previous_response_id: "resp-prior", ...extra});
}

interface FakeServices extends ChatHandlerServices {
  bound: [string, string, string][];
  serviceOptions?: {studyId: string};
}

interface ServiceOverrides {
  assertAccess?: () => Promise<void>;
  nonStreaming?: () => Promise<string>;
  streaming?: (onChunk: (chunk: string) => Promise<boolean>) => Promise<void>;
}

function services(overrides: ServiceOverrides = {}): FakeServices {
  const fake: FakeServices = {
    bound: [],
    createChatService: (options) => {
      fake.serviceOptions = options;
      return {
        chatNonStreaming: overrides.nonStreaming ?? (() => Promise.resolve("{}")),
        chatStreaming: async (_body, onChunk) => {
          await (overrides.streaming ?? (() => Promise.resolve()))(
            async (chunk) => (await onChunk(chunk)) !== false,
          );
        },
      };
    },
    responseOwners: {
      assertAccess: overrides.assertAccess ?? (() => Promise.resolve()),
      bind: async (responseId, uid, studyId) => {
        fake.bound.push([responseId, uid, studyId]);
      },
    },
    openAIApiKey: () => "test-key",
    openAIBaseUrl: () => undefined,
  };
  return fake;
}

function streamRecorder(): {chunks: string[]; sendChunk(chunk: string): Promise<boolean>} {
  const chunks: string[] = [];
  return {
    chunks,
    sendChunk: async (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
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
