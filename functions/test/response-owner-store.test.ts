//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {Firestore, Timestamp} from "firebase-admin/firestore";
import {
  ResponseOwnerAccessError,
  ResponseOwnerStore,
} from "../src/services/chat/response-owner-store";

describe("ResponseOwnerStore", () => {
  it("binds a hashed identifier and accepts only its active owner", async () => {
    const fake = fakeFirestore();
    const store = new ResponseOwnerStore(fake.firestore, () => 1_000);

    await store.bind("resp-sensitive", "user-1", "study-1");
    await store.assertAccess("resp-sensitive", "user-1", "study-1");

    assert.equal(fake.documents.size, 1);
    const [path, owner] = [...fake.documents.entries()][0];
    assert.match(path, /^_responseOwnership\/[a-f0-9]{64}$/);
    assert.doesNotMatch(path, /resp-sensitive/);
    assert.deepEqual(
      {uid: owner.uid, studyId: owner.studyId},
      {uid: "user-1", studyId: "study-1"},
    );
  });

  it("rejects unknown, expired, cross-user, and cross-study state", async () => {
    const fake = fakeFirestore();
    let now = 1_000;
    const store = new ResponseOwnerStore(fake.firestore, () => now);
    await store.bind("resp-owned", "user-1", "study-1");

    await assert.rejects(
      store.assertAccess("resp-unknown", "user-1", "study-1"),
      ResponseOwnerAccessError,
    );
    await assert.rejects(
      store.assertAccess("resp-owned", "user-2", "study-1"),
      ResponseOwnerAccessError,
    );
    await assert.rejects(
      store.assertAccess("resp-owned", "user-1", "study-2"),
      ResponseOwnerAccessError,
    );

    now += 31 * 24 * 60 * 60 * 1_000;
    await assert.rejects(
      store.assertAccess("resp-owned", "user-1", "study-1"),
      ResponseOwnerAccessError,
    );
  });

  it("keeps an idempotent binding's original expiry and rejects reassignment", async () => {
    const fake = fakeFirestore();
    let now = 1_000;
    const store = new ResponseOwnerStore(fake.firestore, () => now);
    await store.bind("resp-owned", "user-1", "study-1");
    const originalExpiry = [...fake.documents.values()][0].expiresAt.toMillis();

    now = 2_000;
    await store.bind("resp-owned", "user-1", "study-1");
    assert.equal(
      [...fake.documents.values()][0].expiresAt.toMillis(),
      originalExpiry,
    );
    await assert.rejects(
      store.bind("resp-owned", "user-2", "study-1"),
      ResponseOwnerAccessError,
    );
  });
});

interface StoredOwner {
  uid: string;
  studyId: string;
  createdAt: Timestamp;
  expiresAt: Timestamp;
}

function fakeFirestore(): {
  firestore: Firestore;
  documents: Map<string, StoredOwner>;
  } {
  const documents = new Map<string, StoredOwner>();
  const reference = (path: string) => ({
    path,
    get: async () => snapshot(documents.get(path)),
  });
  const firestore = {
    collection: (collection: string) => ({
      doc: (id: string) => reference(`${collection}/${id}`),
    }),
    runTransaction: async (operation: (transaction: unknown) => Promise<void>) =>
      operation({
        get: async (document: {path: string}) =>
          snapshot(documents.get(document.path)),
        set: (document: {path: string}, owner: StoredOwner) => {
          documents.set(document.path, owner);
        },
      }),
  } as unknown as Firestore;
  return {firestore, documents};
}

function snapshot(owner: StoredOwner | undefined) {
  return {
    exists: owner !== undefined,
    data: () => owner,
  };
}
