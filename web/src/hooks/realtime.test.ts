//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  functionCallOutputEvent,
  questionFromArguments,
  realtimeCallsUrl,
  spokenResponseEvent,
  textInputEvents,
  VoiceTurnQueue,
} from "./realtime.ts";

const call = { callId: "call-1", name: "ask_plainly", arguments: JSON.stringify({ question: "paraphrase" }) };

describe("VoiceTurnQueue", () => {
  it("waits for the transcript of the latest user item", () => {
    const queue = new VoiceTurnQueue();
    queue.userItemAdded("item-1");
    queue.functionCalled(call);

    assert.deepEqual(queue.take(), []);
    assert.equal(queue.awaitedItemId, "item-1");
    queue.transcriptCompleted("item-1", "What does my MRI say?");
    assert.deepEqual(queue.take(), [{ call, question: "What does my MRI say?", source: "transcript" }]);
  });

  it("releases a call whose transcript arrived first", () => {
    const queue = new VoiceTurnQueue();
    queue.transcriptCompleted("item-1", "Hello");
    queue.functionCalled(call);

    assert.deepEqual(queue.take(), [{ call, question: "Hello", source: "transcript" }]);
  });

  it("falls back to the paraphrase when the transcript is abandoned", () => {
    const queue = new VoiceTurnQueue();
    queue.userItemAdded("item-1");
    queue.functionCalled(call);
    queue.transcriptAbandoned("item-1");

    assert.deepEqual(queue.take(), [{ call, question: "paraphrase", source: "paraphrase" }]);
  });

  it("does not release a call twice when its transcript arrives after it was abandoned", () => {
    const queue = new VoiceTurnQueue();
    queue.userItemAdded("item-1");
    queue.functionCalled(call);
    queue.transcriptAbandoned("item-1");
    assert.equal(queue.take().length, 1);

    queue.transcriptCompleted("item-1", "late");
    assert.deepEqual(queue.take(), []);
  });

  it("pairs a call that came before its user item with that item, not with an earlier turn", () => {
    const queue = new VoiceTurnQueue();
    queue.transcriptCompleted("item-1", "First question");
    queue.functionCalled(call);
    assert.equal(queue.take().length, 1);

    const second = { ...call, callId: "call-2" };
    queue.functionCalled(second);
    assert.deepEqual(queue.take(), []);
    queue.userItemAdded("item-2");
    assert.equal(queue.awaitedItemId, "item-2");
    queue.transcriptCompleted("item-2", "Second question");
    assert.deepEqual(queue.take(), [{ call: second, question: "Second question", source: "transcript" }]);
  });

  it("falls back to the paraphrase when no user item arrives for a call", () => {
    const queue = new VoiceTurnQueue();
    queue.functionCalled(call);
    assert.deepEqual(queue.take(), []);

    const awaited = queue.awaitedItemId;
    assert.ok(awaited);
    queue.transcriptAbandoned(awaited);
    assert.deepEqual(queue.take(), [{ call, question: "paraphrase", source: "paraphrase" }]);
  });

  it("keeps calls in order across turns", () => {
    const queue = new VoiceTurnQueue();
    queue.userItemAdded("item-1");
    queue.functionCalled(call);
    queue.userItemAdded("item-2");
    queue.functionCalled({ ...call, callId: "call-2" });
    queue.transcriptCompleted("item-2", "Second");
    assert.deepEqual(queue.take(), []);

    queue.transcriptCompleted("item-1", "First");
    assert.deepEqual(queue.take().map((turn) => turn.question), ["First", "Second"]);
  });
});

describe("realtime helpers", () => {
  it("reads the question out of the call arguments", () => {
    assert.equal(questionFromArguments(JSON.stringify({ question: "Hi" })), "Hi");
    assert.equal(questionFromArguments("not json"), "not json");
    assert.equal(questionFromArguments(JSON.stringify({ other: 1 })), JSON.stringify({ other: 1 }));
  });

  it("builds the endpoint and the events the session expects", () => {
    assert.equal(realtimeCallsUrl("https://api.openai.com/v1/"), "https://api.openai.com/v1/realtime/calls");
    assert.deepEqual(functionCallOutputEvent("call-1", "answer"), {
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: "call-1", output: "answer" },
    });
    assert.deepEqual(spokenResponseEvent(), { type: "response.create", response: { tool_choice: "none" } });
    const [create, respond] = textInputEvents("msg-1", "Hi");
    assert.equal((create as { item: { id: string } }).item.id, "msg-1");
    assert.deepEqual(respond, { type: "response.create" });
  });
});
