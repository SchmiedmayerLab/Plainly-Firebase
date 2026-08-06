//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {after, before, beforeEach, describe, it} from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from "@firebase/rules-unit-testing";

const projectId = "demo-plainly";
const bucketUrl = `gs://${projectId}.firebasestorage.app`;
let testEnvironment: RulesTestEnvironment;

before(async () => {
  const [firestoreRules, storageRules] = await Promise.all([
    readFile(resolve("../firestore.rules"), "utf8"),
    readFile(resolve("../storage.rules"), "utf8"),
  ]);
  testEnvironment = await initializeTestEnvironment({
    projectId,
    firestore: {host: "127.0.0.1", port: 8080, rules: firestoreRules},
    storage: {host: "127.0.0.1", port: 9199, rules: storageRules},
  });
});

beforeEach(async () => {
  await Promise.all([
    testEnvironment.clearFirestore(),
    testEnvironment.clearStorage(),
  ]);
});

after(async () => {
  await testEnvironment.cleanup();
});

describe("Firebase Security Rules", () => {
  it("allows a user to create files only in their own study path", async () => {
    const owner = testEnvironment.authenticatedContext("owner");
    const otherUser = testEnvironment.authenticatedContext("other-user");
    const anonymous = testEnvironment.unauthenticatedContext();
    const path = "studies/study/users/owner/records/report.json";

    await assertSucceeds(
      owner.storage(bucketUrl).ref(path).putString(
        "allowed",
        "raw",
        {contentType: "application/octet-stream"},
      ),
    );
    await assertFails(
      otherUser.storage(bucketUrl).ref(path).putString("denied"),
    );
    await assertFails(
      anonymous.storage(bucketUrl).ref(path).putString("denied"),
    );
    await assertFails(
      owner.storage(bucketUrl)
        .ref("studies/study/rag_files/injected.txt")
        .putString("denied"),
    );
  });

  it("prevents clients from reading, replacing, or deleting uploaded files", async () => {
    const owner = testEnvironment.authenticatedContext("owner");
    const file = owner.storage(bucketUrl)
      .ref("studies/study/users/owner/report.json");
    await assertSucceeds(file.putString(
      "original",
      "raw",
      {contentType: "application/octet-stream"},
    ));

    await assertFails(file.getMetadata());
    await assertFails(file.putString("replacement"));
    await assertFails(file.delete());
  });

  it("prevents all client access to indexed Firestore documents", async () => {
    const authenticated = testEnvironment.authenticatedContext("owner")
      .firestore().doc("studies/study/embeddings/chunk");
    const anonymous = testEnvironment.unauthenticatedContext()
      .firestore().doc("studies/study/embeddings/chunk");

    await assertFails(authenticated.get());
    await assertFails(authenticated.set({text: "private context"}));
    await assertFails(anonymous.get());
  });
});
