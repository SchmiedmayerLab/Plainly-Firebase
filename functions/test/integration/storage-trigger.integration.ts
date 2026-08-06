//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import assert from "node:assert/strict";
import {after, before, describe, it} from "node:test";
import {
  initializeTestEnvironment,
  RulesTestEnvironment,
} from "@firebase/rules-unit-testing";

const projectId = "demo-plainly";
const bucketUrl = `gs://${projectId}.firebasestorage.app`;
let testEnvironment: RulesTestEnvironment;

before(async () => {
  testEnvironment = await initializeTestEnvironment({
    projectId,
    firestore: {host: "127.0.0.1", port: 8080},
    storage: {host: "127.0.0.1", port: 9199},
  });
  await Promise.all([
    testEnvironment.clearFirestore(),
    testEnvironment.clearStorage(),
  ]);
});

after(async () => {
  await testEnvironment.cleanup();
});

describe("document deletion trigger", () => {
  it("removes only the deleted document's indexed chunks", async () => {
    await testEnvironment.withSecurityRulesDisabled(async (context) => {
      const objectName = "studies/study/rag_files/context.txt";
      const embeddings = context.firestore()
        .collection("studies/study/embeddings");
      await Promise.all([
        embeddings.doc("target-1").set({file: objectName, text: "first"}),
        embeddings.doc("target-2").set({file: objectName, text: "second"}),
        embeddings.doc("other").set({file: "other.txt", text: "keep"}),
      ]);
      const file = context.storage(bucketUrl).ref(objectName);
      await file.putString(
        "ignored",
        "raw",
        {contentType: "application/octet-stream"},
      );

      await file.delete();

      await waitFor(async () => (await embeddings
        .where("file", "==", objectName).get()).empty);
      assert.equal((await embeddings.doc("other").get()).exists, true);
    });
  });
});

async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMilliseconds = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the storage trigger");
}
