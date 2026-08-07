//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import assert from "node:assert/strict";
import {after, before, describe, it} from "node:test";
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

  it("returns the configured emulator response", async () => {
    const chat = httpsCallable(functions, "chat?studyId=test-study&ragEnabled=true");
    const result = await chat(JSON.stringify({
      model: "test-model",
      messages: [{role: "user", content: "Hello"}],
      stream: false,
    }));
    const completion = JSON.parse(result.data as string);

    assert.equal(completion.choices[0].message.content, process.env.PLAINLY_MOCK_CHAT_RESPONSE);
  });

  it("streams the configured emulator response", async () => {
    const chat = httpsCallable<string, void, string>(
      functions,
      "chat?studyId=test-study&ragEnabled=true",
    );
    const result = await chat.stream(JSON.stringify({
      model: "test-model",
      messages: [{role: "user", content: "Hello"}],
      stream: true,
    }));
    const chunks: string[] = [];

    for await (const chunk of result.stream) {
      chunks.push(chunk);
    }
    await result.data;

    const expected = process.env.PLAINLY_MOCK_CHAT_RESPONSE;
    assert.ok(expected, "PLAINLY_MOCK_CHAT_RESPONSE must be configured");
    assert.ok(chunks.join("").includes(expected));
  });
});

function hasFunctionsCode(expectedCode: string) {
  return (error: unknown): boolean => {
    assert.equal(
      (error as {code?: string}).code,
      expectedCode,
    );
    return true;
  };
}
