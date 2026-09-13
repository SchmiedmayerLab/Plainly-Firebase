//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

export const DEFAULT_REALTIME_MODEL = "gpt-realtime-mini";
export const ASK_PLAINLY_TOOL_NAME = "ask_plainly";

export interface RealtimeFunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

/** One participant turn ready to be forwarded: the call that asked for it and the words to send. */
export interface VoiceTurn {
  call: RealtimeFunctionCall;
  question: string;
  /** Where the question came from; the model's paraphrase only stands in when no transcript arrived. */
  source: "transcript" | "paraphrase";
}

/** A minted session as the callable returns it. */
export interface RealtimeSessionGrant {
  value: string;
  expires_at: number;
  base_url: string;
  session: { id: string; model?: string };
}

export function realtimeCallsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/realtime/calls`;
}

/** The words the realtime model put into the forwarding call. */
export function questionFromArguments(rawArguments: string): string {
  try {
    const parsed: unknown = JSON.parse(rawArguments);
    if (typeof parsed === "object" && parsed !== null && "question" in parsed) {
      const question = (parsed as { question: unknown }).question;
      if (typeof question === "string") return question;
    }
  } catch {
    // The arguments are what the model produced; a malformed call is forwarded as its raw text below.
  }
  return rawArguments;
}

export function functionCallOutputEvent(callId: string, output: string): object {
  return {
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: callId, output },
  };
}

/** Asks for the spoken reply without the forced tool, so the model reads the answer instead of calling again. */
export function spokenResponseEvent(): object {
  return { type: "response.create", response: { tool_choice: "none" } };
}

export function textInputEvents(itemId: string, text: string): object[] {
  return [
    {
      type: "conversation.item.create",
      item: {
        id: itemId,
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    },
    { type: "response.create" },
  ];
}

const UNPAIRED_PREFIX = "unpaired:";

/**
 * Pairs each forwarding call with the transcript of the participant turn it answers.
 *
 * The user item, its transcript and the function call arrive independently and in any order. A call takes the newest
 * user item no earlier call has taken, or waits for the next one to arrive; either way it then waits for that item's
 * transcript until it lands or is given up on.
 */
export class VoiceTurnQueue {
  #userItems: string[] = [];
  #pairedItems = new Set<string>();
  #transcripts = new Map<string, string | null>();
  #pending: { call: RealtimeFunctionCall; userItemId: string }[] = [];

  userItemAdded(itemId: string): void {
    if (this.#userItems.includes(itemId)) return;
    this.#userItems.push(itemId);
    const waiting = this.#pending.find((entry) =>
      entry.userItemId.startsWith(UNPAIRED_PREFIX) && !this.#transcripts.has(entry.userItemId));
    if (waiting) {
      waiting.userItemId = itemId;
      this.#pairedItems.add(itemId);
    }
  }

  transcriptCompleted(itemId: string, transcript: string): void {
    this.userItemAdded(itemId);
    this.#transcripts.set(itemId, transcript);
  }

  transcriptAbandoned(itemId: string): void {
    if (!this.#transcripts.has(itemId)) {
      this.#transcripts.set(itemId, null);
    }
  }

  functionCalled(call: RealtimeFunctionCall): void {
    let itemId: string | undefined;
    for (let index = this.#userItems.length - 1; index >= 0 && itemId === undefined; index -= 1) {
      if (!this.#pairedItems.has(this.#userItems[index])) itemId = this.#userItems[index];
    }
    if (itemId === undefined) {
      this.#pending.push({ call, userItemId: `${UNPAIRED_PREFIX}${call.callId}` });
      return;
    }
    this.#pairedItems.add(itemId);
    this.#pending.push({ call, userItemId: itemId });
  }

  /** What the first waiting call still needs: its user item's transcript, or the user item itself. */
  get awaitedItemId(): string | undefined {
    return this.#pending.find((entry) => !this.#transcripts.has(entry.userItemId))?.userItemId;
  }

  /** Releases, in order, every call whose transcript arrived or was abandoned. */
  take(): VoiceTurn[] {
    const ready: VoiceTurn[] = [];
    while (this.#pending.length > 0 && this.#transcripts.has(this.#pending[0].userItemId)) {
      const { call, userItemId } = this.#pending.shift()!;
      const transcript = this.#transcripts.get(userItemId) ?? null;
      ready.push(
        transcript === null ?
          { call, question: questionFromArguments(call.arguments), source: "paraphrase" } :
          { call, question: transcript, source: "transcript" },
      );
    }
    return ready;
  }
}
