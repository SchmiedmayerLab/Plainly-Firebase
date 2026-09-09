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
    // Reset preserves rules and avoids the emulator SDK deletion endpoint's double decoding of %2F.
    fetch("http://127.0.0.1:9199/internal/reset", {method: "POST"}).then((response) => {
      if (!response.ok) {
        throw new Error(`Failed to reset Storage emulator: ${response.status}`);
      }
    }),
  ]);
});

after(async () => {
  await testEnvironment.cleanup();
});

describe("Firebase Security Rules", () => {
  it("allows study reports with the authenticated user's metadata", async () => {
    for (const {userId, filename} of [
      {userId: "owner", filename: "study_pid-participant-1_2026-09-08T14-30-22.123Z_a1b2c3d4.json"},
      {userId: "other-user", filename: "study_2026-09-08T14-30-22.123Z_a1b2c3d4.json"},
      {userId: "owner", filename: "study_pid-site%2Fparticipant-1_2026-09-08T14-30-22.123Z_a1b2c3d4.json"},
    ]) {
      const user = testEnvironment.authenticatedContext(userId);
      await assertSucceeds(
        user.storage(bucketUrl).ref(`studies/study/reports/${filename}`).putString(
          "{}",
          "raw",
          {contentType: "application/octet-stream", customMetadata: {userId}},
        ),
      );
    }
  });

  it("rejects reports with missing or mismatched user metadata", async () => {
    const owner = testEnvironment.authenticatedContext("owner");
    const path = "studies/study/reports/study_2026-09-08T14-30-22.123Z_a1b2c3d4.json";

    await assertFails(owner.storage(bucketUrl).ref(path).putString(
      "{}",
      "raw",
      {contentType: "application/octet-stream"},
    ));
    await assertFails(owner.storage(bucketUrl).ref(path).putString(
      "{}",
      "raw",
      {contentType: "application/octet-stream", customMetadata: {userId: "other-user"}},
    ));
    await assertFails(
      testEnvironment.authenticatedContext("other-user").storage(bucketUrl).ref(path).putString(
        "{}",
        "raw",
        {contentType: "application/octet-stream", customMetadata: {userId: "owner"}},
      ),
    );
  });

  it("rejects unauthenticated report uploads even with user metadata", async () => {
    await assertFails(
      testEnvironment.unauthenticatedContext().storage(bucketUrl)
        .ref("studies/study/reports/study_2026-09-08T14-30-22.123Z_a1b2c3d4.json").putString(
          "{}",
          "raw",
          {contentType: "application/octet-stream", customMetadata: {userId: "owner"}},
        ),
    );
  });

  it("limits the report rule to JSON files in the reports folder", async () => {
    const owner = testEnvironment.authenticatedContext("owner");
    for (const path of [
      "studies/study/reports/report.txt",
      "studies/study/report.json",
      "studies/study/rag_files/injected.json",
      "studies/study/rag_files/injected.txt",
      "studies/study/users/other-user/report.json",
    ]) {
      await assertFails(owner.storage(bucketUrl).ref(path).putString(
        "{}",
        "raw",
        {contentType: "application/octet-stream", customMetadata: {userId: "owner"}},
      ));
    }
  });

  it("prevents clients from reading, replacing, or deleting reports", async () => {
    const owner = testEnvironment.authenticatedContext("owner");
    const file = owner.storage(bucketUrl)
      .ref("studies/study/reports/study_2026-09-08T14-30-22.123Z_a1b2c3d4.json");
    const metadata = {contentType: "application/octet-stream", customMetadata: {userId: "owner"}};
    await assertSucceeds(file.putString("{}", "raw", metadata));

    await assertFails(file.getMetadata());
    await assertFails(file.putString("{\"replacement\":true}", "raw", metadata));
    await assertFails(file.updateMetadata({customMetadata: {userId: "other-user"}}));
    await assertFails(file.delete());
    await assertFails(owner.storage(bucketUrl).ref("studies/study").listAll());
  });

  it("keeps legacy uploads restricted to the authenticated user's study path", async () => {
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
      otherUser.storage(bucketUrl).ref("studies/study/users/owner/another.json").putString("denied"),
    );
    await assertFails(
      anonymous.storage(bucketUrl).ref("studies/study/users/owner/anonymous.json").putString("denied"),
    );
    await assertFails(
      owner.storage(bucketUrl)
        .ref("studies/study/rag_files/injected.txt")
        .putString("denied"),
    );
  });

  it("prevents clients from reading, replacing, or deleting legacy files", async () => {
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
