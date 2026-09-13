//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {parseRealtimeSessionRequest} from "../src/services/realtime/realtime-session-request";

describe("parseRealtimeSessionRequest", () => {
  it("accepts the fields a client may choose", () => {
    const request = parseRealtimeSessionRequest(JSON.stringify({
      model: "gpt-realtime-mini",
      instructions: "Be brief.",
      voice: "marin",
      language: "en",
    }));

    assert.deepEqual(request, {
      model: "gpt-realtime-mini",
      instructions: "Be brief.",
      voice: "marin",
      language: "en",
    });
  });

  it("drops a transcription language the model does not support", () => {
    const request = parseRealtimeSessionRequest(
      JSON.stringify({model: "gpt-realtime", instructions: "Hi", language: "zz"}),
    );

    assert.equal(request.language, undefined);
  });

  it("leaves optional fields unset", () => {
    const request = parseRealtimeSessionRequest(JSON.stringify({model: "gpt-realtime", instructions: "Hi"}));

    assert.equal(request.voice, undefined);
    assert.equal(request.language, undefined);
  });

  it("rejects requests that are not JSON objects", () => {
    assert.throws(() => parseRealtimeSessionRequest({model: "gpt-realtime"}), /JSON string/);
    assert.throws(() => parseRealtimeSessionRequest("[]"), /must be an object/);
    assert.throws(() => parseRealtimeSessionRequest("x".repeat(70_000)), /too large/);
  });

  it("rejects anything outside the allowlists", () => {
    const valid = {model: "gpt-realtime", instructions: "Hi"};
    assert.throws(() => parseRealtimeSessionRequest(JSON.stringify({...valid, tools: []})), /Unsupported/);
    assert.throws(() => parseRealtimeSessionRequest(JSON.stringify({...valid, model: "gpt-5.5"})), /not enabled/);
    assert.throws(() => parseRealtimeSessionRequest(JSON.stringify({model: "gpt-realtime"})), /missing/);
    assert.throws(() => parseRealtimeSessionRequest(JSON.stringify({...valid, instructions: " "})), /missing/);
    assert.throws(
      () => parseRealtimeSessionRequest(JSON.stringify({...valid, instructions: "x".repeat(32_001)})),
      /limited/,
    );
    assert.throws(() => parseRealtimeSessionRequest(JSON.stringify({...valid, voice: "hal"})), /voice/);
    assert.throws(() => parseRealtimeSessionRequest(JSON.stringify({...valid, language: "english"})), /ISO 639-1/);
  });
});
