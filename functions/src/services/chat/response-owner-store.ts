//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {createHash} from "node:crypto";
import {Firestore, getFirestore, Timestamp} from "firebase-admin/firestore";

const COLLECTION = "_responseOwnership";
const OWNERSHIP_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

interface ResponseOwner {
  uid: string;
  studyId: string;
  createdAt: Timestamp;
  expiresAt: Timestamp;
}

/** Raised when stored Responses state does not belong to the current participant and study. */
export class ResponseOwnerAccessError extends Error {
  constructor() {
    super("Response state is unavailable for this participant and study.");
    this.name = "ResponseOwnerAccessError";
  }
}

/** Raised when response ownership cannot be durably checked or recorded. */
export class ResponseOwnerStoreError extends Error {
  constructor(cause: unknown) {
    super("The response could not be secured.", {cause});
    this.name = "ResponseOwnerStoreError";
  }
}

/** Binds opaque provider response IDs to the Firebase principal allowed to continue them. */
export class ResponseOwnerStore {
  constructor(
    private readonly firestore: Firestore = getFirestore(),
    private readonly now: () => number = Date.now,
  ) {}

  async assertAccess(responseId: string, uid: string, studyId: string): Promise<void> {
    try {
      const snapshot = await this.document(responseId).get();
      const owner = snapshot.data() as ResponseOwner | undefined;
      if (
        !snapshot.exists ||
        owner?.uid !== uid ||
        owner.studyId !== studyId ||
        !(owner.expiresAt instanceof Timestamp) ||
        owner.expiresAt.toMillis() <= this.now()
      ) {
        throw new ResponseOwnerAccessError();
      }
    } catch (error) {
      if (error instanceof ResponseOwnerAccessError) throw error;
      throw new ResponseOwnerStoreError(error);
    }
  }

  async bind(responseId: string, uid: string, studyId: string): Promise<void> {
    const reference = this.document(responseId);
    try {
      await this.firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(reference);
        const existing = snapshot.data() as ResponseOwner | undefined;
        if (snapshot.exists) {
          if (
            existing?.uid !== uid ||
            existing.studyId !== studyId ||
            !(existing.expiresAt instanceof Timestamp) ||
            existing.expiresAt.toMillis() <= this.now()
          ) {
            throw new ResponseOwnerAccessError();
          }
          return;
        }
        const createdAt = Timestamp.fromMillis(this.now());
        transaction.set(reference, {
          uid,
          studyId,
          createdAt,
          expiresAt: Timestamp.fromMillis(createdAt.toMillis() + OWNERSHIP_LIFETIME_MS),
        } satisfies ResponseOwner);
      });
    } catch (error) {
      if (error instanceof ResponseOwnerAccessError) throw error;
      throw new ResponseOwnerStoreError(error);
    }
  }

  private document(responseId: string) {
    const digest = createHash("sha256").update(responseId, "utf8").digest("hex");
    return this.firestore.collection(COLLECTION).doc(digest);
  }
}
