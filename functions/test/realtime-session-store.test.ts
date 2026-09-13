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
  RealtimeSessionLimitError,
  RealtimeSessionStore,
  RealtimeSessionStoreError,
} from "../src/services/realtime/realtime-session-store";

describe("RealtimeSessionStore", () => {
  it("counts session starts per participant within the hour", async () => {
    const fake = fakeFirestore();
    let now = 1_000;
    const store = new RealtimeSessionStore(fake.firestore, () => now, 2);

    await store.reserve("user-1", "study-1");
    await store.reserve("user-1", "study-2");
    await assert.rejects(store.reserve("user-1", "study-1"), RealtimeSessionLimitError);
    await store.reserve("user-2", "study-1");

    now += 60 * 60 * 1_000 + 1;
    await store.reserve("user-1", "study-1");
    assert.equal(fake.documents.get("_realtimeSessions/user-1")?.sessions.length, 1);
  });

  it("drops malformed entries instead of counting them", async () => {
    const fake = fakeFirestore();
    fake.documents.set("_realtimeSessions/user-1", {
      sessions: [{studyId: "study-1", createdAt: "yesterday" as unknown as Timestamp}],
    });
    const store = new RealtimeSessionStore(fake.firestore, () => 1_000, 1);

    await store.reserve("user-1", "study-1");

    const stored = fake.documents.get("_realtimeSessions/user-1");
    assert.equal(stored?.sessions.length, 1);
    assert.equal(stored?.expiresAt?.toMillis(), 1_000 + 60 * 60 * 1_000);
  });

  it("tolerates a document whose sessions are not a list", async () => {
    const fake = fakeFirestore();
    fake.documents.set("_realtimeSessions/user-1", {sessions: {} as unknown as never[]});
    const store = new RealtimeSessionStore(fake.firestore, () => 1_000, 1);

    await store.reserve("user-1", "study-1");

    assert.equal(fake.documents.get("_realtimeSessions/user-1")?.sessions.length, 1);
  });

  it("takes back exactly the start that did not become a session", async () => {
    const fake = fakeFirestore();
    let now = 1_000;
    const store = new RealtimeSessionStore(fake.firestore, () => now, 2);

    await store.reserve("user-1", "study-1");
    now += 1;
    const failed = await store.reserve("user-1", "study-1");
    await store.release(failed);
    await store.release(failed);
    await store.release({uid: "user-2", createdAtMillis: 1_000});

    assert.deepEqual(failed, {uid: "user-1", createdAtMillis: 1_001});
    const remaining = fake.documents.get("_realtimeSessions/user-1")?.sessions ?? [];
    assert.deepEqual(remaining.map((session) => session.createdAt.toMillis()), [1_000]);
    await store.reserve("user-1", "study-1");
  });

  it("wraps storage failures", async () => {
    const firestore = {
      collection: () => ({doc: () => ({})}),
      runTransaction: () => Promise.reject(new Error("offline")),
    } as unknown as Firestore;

    await assert.rejects(new RealtimeSessionStore(firestore).reserve("user-1", "study-1"), RealtimeSessionStoreError);
    await assert.rejects(
      new RealtimeSessionStore(firestore).release({uid: "user-1", createdAtMillis: 1}),
      RealtimeSessionStoreError,
    );
  });
});

interface StoredSessions {
  sessions: {studyId: string; createdAt: Timestamp}[];
  expiresAt?: Timestamp;
}

function fakeFirestore(): {firestore: Firestore; documents: Map<string, StoredSessions>} {
  const documents = new Map<string, StoredSessions>();
  const firestore = {
    collection: (collection: string) => ({
      doc: (id: string) => ({path: `${collection}/${id}`}),
    }),
    runTransaction: async (operation: (transaction: unknown) => Promise<void>) =>
      operation({
        get: async (document: {path: string}) => {
          const stored = documents.get(document.path);
          return {exists: stored !== undefined, data: () => stored};
        },
        set: (document: {path: string}, value: StoredSessions) => {
          documents.set(document.path, value);
        },
      }),
  } as unknown as Firestore;
  return {firestore, documents};
}
