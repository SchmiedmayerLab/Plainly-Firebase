//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {Firestore, getFirestore, Timestamp} from "firebase-admin/firestore";

const COLLECTION = "_realtimeSessions";
const WINDOW_MS = 60 * 60 * 1000;
// A study session lasts under an hour and a dropped connection needs a fresh secret, so this leaves room
// for reconnects while keeping a leaked account from running the model all day.
export const DEFAULT_SESSIONS_PER_HOUR = 10;

interface SessionStart {
  studyId: string;
  createdAt: Timestamp;
}

interface ParticipantSessions {
  sessions: SessionStart[];
  /** When the newest start leaves the window; a Firestore TTL policy on this field removes idle documents. */
  expiresAt: Timestamp;
}

/** A recorded session start, which ``RealtimeSessionStore.release`` can take back. */
export interface RealtimeSessionReservation {
  uid: string;
  createdAtMillis: number;
}

/** Raised when a participant has started more voice sessions than the hourly allowance. */
export class RealtimeSessionLimitError extends Error {
  constructor() {
    super("Too many voice sessions were started recently. Please try again later.");
    this.name = "RealtimeSessionLimitError";
  }
}

/** Raised when the allowance cannot be durably checked or recorded. */
export class RealtimeSessionStoreError extends Error {
  constructor(cause: unknown) {
    super("The voice session could not be secured.", {cause});
    this.name = "RealtimeSessionStoreError";
  }
}

/** Counts the voice sessions each participant starts, so a secret is only minted within the allowance. */
export class RealtimeSessionStore {
  constructor(
    private readonly firestore: Firestore = getFirestore(),
    private readonly now: () => number = Date.now,
    private readonly sessionsPerHour: number = DEFAULT_SESSIONS_PER_HOUR,
  ) {}

  /** Records a session start for the participant, or throws when the hourly allowance is used up. */
  async reserve(uid: string, studyId: string): Promise<RealtimeSessionReservation> {
    const reference = this.firestore.collection(COLLECTION).doc(uid);
    let createdAtMillis = 0;
    try {
      await this.firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(reference);
        const stored = snapshot.data() as ParticipantSessions | undefined;
        const windowStart = this.now() - WINDOW_MS;
        const sessions = Array.isArray(stored?.sessions) ? stored.sessions : [];
        const recent = sessions.filter((session) =>
          session.createdAt instanceof Timestamp && session.createdAt.toMillis() > windowStart,
        );
        if (recent.length >= this.sessionsPerHour) {
          throw new RealtimeSessionLimitError();
        }
        const createdAt = Timestamp.fromMillis(this.now());
        createdAtMillis = createdAt.toMillis();
        recent.push({studyId, createdAt});
        transaction.set(reference, {
          sessions: recent,
          expiresAt: Timestamp.fromMillis(createdAt.toMillis() + WINDOW_MS),
        } satisfies ParticipantSessions);
      });
    } catch (error) {
      if (error instanceof RealtimeSessionLimitError) throw error;
      throw new RealtimeSessionStoreError(error);
    }
    return {uid, createdAtMillis};
  }

  /** Takes back one recorded start, for a session that never began. */
  async release(reservation: RealtimeSessionReservation): Promise<void> {
    const reference = this.firestore.collection(COLLECTION).doc(reservation.uid);
    try {
      await this.firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(reference);
        const stored = snapshot.data() as ParticipantSessions | undefined;
        if (!stored || !Array.isArray(stored.sessions)) return;
        const index = stored.sessions.findIndex((session) =>
          session.createdAt instanceof Timestamp && session.createdAt.toMillis() === reservation.createdAtMillis,
        );
        if (index < 0) return;
        const sessions = [...stored.sessions.slice(0, index), ...stored.sessions.slice(index + 1)];
        transaction.set(reference, {...stored, sessions});
      });
    } catch (error) {
      throw new RealtimeSessionStoreError(error);
    }
  }
}
