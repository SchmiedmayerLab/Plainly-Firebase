//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {after, before, describe, it} from "node:test";
import {
  deleteApp as deleteAdminApp,
  initializeApp as initializeAdminApp,
} from "firebase-admin/app";
import {getFirestore, Timestamp} from "firebase-admin/firestore";
import {deleteApp, FirebaseApp, initializeApp} from "firebase/app";
import {
  Auth,
  connectAuthEmulator,
  getAuth,
  signInAnonymously,
} from "firebase/auth";
import {
  connectFunctionsEmulator,
  Functions,
  getFunctions,
  httpsCallable,
} from "firebase/functions";

let app: FirebaseApp;
let auth: Auth;
let functions: Functions;

before(() => {
  app = initializeApp({
    apiKey: "integration-test-key",
    appId: "integration-test-app",
    projectId: "demo-plainly",
  }, "callable-integration-tests");
  auth = getAuth(app);
  functions = getFunctions(app, "us-central1");
  connectAuthEmulator(auth, "http://127.0.0.1:9099", {disableWarnings: true});
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
});

after(async () => {
  await deleteApp(app);
});

describe("chat callable", () => {
  it("rejects unauthenticated requests", async () => {
    const chat = httpsCallable(functions, "chat");

    await assert.rejects(
      chat("{}"),
      hasFunctionsCode("functions/unauthenticated"),
    );
  });

  it("validates the study after authenticating the caller", async () => {
    await signInAnonymously(auth);
    const chat = httpsCallable(functions, "chat");

    await assert.rejects(
      chat("{}"),
      hasFunctionsCode("functions/invalid-argument"),
    );
  });

  for (const studyId of ["../other-study", "study\nforged-log"]) {
    it(`rejects an unsafe study identifier: ${JSON.stringify(studyId)}`, async () => {
      const chat = httpsCallable(
        functions,
        `chat?studyId=${encodeURIComponent(studyId)}`,
      );

      await assert.rejects(
        chat("{}"),
        hasFunctionsCode("functions/invalid-argument"),
      );
    });
  }

  it("returns the configured emulator response", async () => {
    const chat = httpsCallable(functions, "chat?studyId=test-study&ragEnabled=true");
    const result = await chat(JSON.stringify({
      model: "gpt-5.5",
      input: [{role: "user", content: "Hello"}],
      stream: false,
    }));
    const response = JSON.parse(result.data as string);

    assert.equal(response.object, "response");
    assert.equal(response.output_text, process.env.PLAINLY_MOCK_CHAT_RESPONSE);
  });

  it("continues a response only for the same Firebase user and study", async () => {
    const response = await createNonStreamingResponse(functions, "test-study");
    const continuation = await createNonStreamingResponse(
      functions,
      "test-study",
      response.id,
    );

    assert.equal(continuation.object, "response");
    await assert.rejects(
      createNonStreamingResponse(functions, "other-study", response.id),
      hasFunctionsCode("functions/permission-denied"),
    );

    const other = await createSignedInClient();
    try {
      await assert.rejects(
        createNonStreamingResponse(other.functions, "test-study", response.id),
        hasFunctionsCode("functions/permission-denied"),
      );
    } finally {
      await deleteApp(other.app);
    }
  });

  it("rejects unknown and expired response identifiers without storing the raw identifier", async () => {
    await assert.rejects(
      createNonStreamingResponse(functions, "test-study", "resp-unknown"),
      hasFunctionsCode("functions/permission-denied"),
    );

    const response = await createNonStreamingResponse(functions, "test-study");
    const admin = initializeAdminApp(
      {projectId: "demo-plainly"},
      `ownership-integration-${randomUUID()}`,
    );
    try {
      const digest = createHash("sha256").update(response.id, "utf8").digest("hex");
      const reference = getFirestore(admin)
        .collection("_responseOwnership")
        .doc(digest);
      const owner = await reference.get();
      assert.equal(owner.exists, true);
      assert.equal(JSON.stringify(owner.data()).includes(response.id), false);

      await reference.update({expiresAt: Timestamp.fromMillis(Date.now() - 1)});
      await assert.rejects(
        createNonStreamingResponse(functions, "test-study", response.id),
        hasFunctionsCode("functions/permission-denied"),
      );
    } finally {
      await deleteAdminApp(admin);
    }
  });

  it("rejects a failed non-streaming upstream request", async () => {
    const chat = httpsCallable(
      functions,
      "chat?studyId=test-study&mockScenario=chatError",
    );

    await assert.rejects(
      chat(JSON.stringify({
        model: "gpt-5.5",
        input: [{role: "user", content: "Hello"}],
        stream: false,
      })),
      hasFunctionsCode("functions/invalid-argument"),
    );
  });

  it("streams the configured emulator response", async () => {
    const chat = httpsCallable<string, void, string>(
      functions,
      "chat?studyId=test-study&ragEnabled=true",
    );
    const result = await chat.stream(JSON.stringify({
      model: "gpt-5.5",
      input: [{role: "user", content: "Hello"}],
      stream: true,
    }));
    const chunks: string[] = [];

    for await (const chunk of result.stream) {
      chunks.push(chunk);
    }
    await result.data;

    const expected = process.env.PLAINLY_MOCK_CHAT_RESPONSE;
    assert.ok(expected, "PLAINLY_MOCK_CHAT_RESPONSE must be configured");
    const content = chunks
      .map((chunk) => JSON.parse(chunk.slice(6)))
      .filter((event) => event.type === "response.output_text.delta")
      .map((event) => event.delta)
      .join("");
    assert.equal(content, expected);
    assert.equal(JSON.parse(chunks.at(-1)?.slice(6) ?? "{}").type, "response.completed");

    const responseId = responseIdFromChunks(chunks);
    const continuation = await createNonStreamingResponse(
      functions,
      "test-study",
      responseId,
    );
    assert.equal(continuation.object, "response");
  });

  it("falls back when the upstream gateway does not support streaming", async () => {
    const chat = httpsCallable<string, void, string>(
      functions,
      "chat?studyId=test-study&mockScenario=responseStreamingUnsupported",
    );
    const result = await chat.stream(JSON.stringify({
      model: "gpt-5.5",
      input: [{role: "user", content: "Hello"}],
      stream: true,
    }));
    const chunks: string[] = [];

    for await (const chunk of result.stream) {
      chunks.push(chunk);
    }
    await result.data;

    const events = chunks.map((chunk) => JSON.parse(chunk.slice(6)));
    assert.equal(
      events
        .filter((event) => event.type === "response.output_text.delta")
        .map((event) => event.delta)
        .join(""),
      process.env.PLAINLY_MOCK_CHAT_RESPONSE,
    );
    assert.equal(events.at(-1)?.type, "response.completed");

    const responseId = responseIdFromChunks(chunks);
    const continuation = await createNonStreamingResponse(
      functions,
      "test-study",
      responseId,
    );
    assert.equal(continuation.object, "response");
  });
});

interface TestClient {
  app: FirebaseApp;
  functions: Functions;
}

interface ResponseResult {
  id: string;
  object: string;
  output_text: string;
}

async function createSignedInClient(): Promise<TestClient> {
  const otherApp = initializeApp({
    apiKey: "integration-test-key",
    appId: "integration-test-app",
    projectId: "demo-plainly",
  }, `callable-integration-${randomUUID()}`);
  const otherAuth = getAuth(otherApp);
  const otherFunctions = getFunctions(otherApp, "us-central1");
  connectAuthEmulator(otherAuth, "http://127.0.0.1:9099", {disableWarnings: true});
  connectFunctionsEmulator(otherFunctions, "127.0.0.1", 5001);
  await signInAnonymously(otherAuth);
  return {app: otherApp, functions: otherFunctions};
}

async function createNonStreamingResponse(
  targetFunctions: Functions,
  studyId: string,
  previousResponseId?: string,
): Promise<ResponseResult> {
  const chat = httpsCallable(
    targetFunctions,
    `chat?studyId=${encodeURIComponent(studyId)}`,
  );
  const result = await chat(JSON.stringify({
    model: "gpt-5.5",
    input: [{role: "user", content: "Hello"}],
    previous_response_id: previousResponseId,
    stream: false,
  }));
  return JSON.parse(result.data as string) as ResponseResult;
}

function responseIdFromChunks(chunks: string[]): string {
  const terminal = JSON.parse(chunks.at(-1)?.slice(6) ?? "{}") as {
    response?: {id?: string};
  };
  assert.equal(typeof terminal.response?.id, "string");
  return terminal.response?.id ?? "";
}

function hasFunctionsCode(expectedCode: string) {
  return (error: unknown): boolean => {
    assert.equal(
      (error as {code?: string}).code,
      expectedCode,
    );
    return true;
  };
}
