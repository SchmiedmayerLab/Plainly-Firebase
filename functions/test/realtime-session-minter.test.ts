//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {ClientSecretCreateParams} from "openai/resources/realtime/client-secrets";
import {createMockRealtimeClientSecrets} from "../src/services/realtime/mock-realtime-client-secrets";
import {
  ASK_PLAINLY_TOOL,
  realtimeSessionConfiguration,
  RealtimeSessionMinter,
} from "../src/services/realtime/realtime-session-minter";

describe("realtimeSessionConfiguration", () => {
  it("pins the session to the forwarding tool", () => {
    const configuration = realtimeSessionConfiguration({model: "gpt-realtime", instructions: "Be kind."});
    const session = realtimeSession(configuration);

    assert.equal(session.model, "gpt-realtime");
    assert.equal(session.instructions, "Be kind.");
    assert.deepEqual(session.tools, [ASK_PLAINLY_TOOL]);
    assert.equal(session.tool_choice, "required");
    assert.deepEqual(session.output_modalities, ["audio"]);
    assert.deepEqual(
      session.audio?.input?.turn_detection,
      {type: "semantic_vad", create_response: true, interrupt_response: false},
    );
    assert.equal(session.audio?.input?.transcription?.model, "gpt-4o-mini-transcribe");
    assert.equal(session.max_output_tokens, 2048);
    assert.equal(session.audio?.input?.transcription?.language, undefined);
    assert.equal(session.audio?.output?.voice, undefined);
    assert.equal(configuration.expires_after?.seconds, 120);
  });

  it("passes the participant's voice and language through", () => {
    const session = realtimeSession(realtimeSessionConfiguration({
      model: "gpt-realtime-mini",
      instructions: "Be kind.",
      voice: "cedar",
      language: "de",
    }));

    assert.equal(session.audio?.output?.voice, "cedar");
    assert.equal(session.audio?.input?.transcription?.language, "de");
  });
});

describe("RealtimeSessionMinter", () => {
  it("returns the minted secret together with the endpoint it belongs to", async () => {
    const minter = new RealtimeSessionMinter(createMockRealtimeClientSecrets(() => 1_000_000), "https://x/v1");

    const grant = await minter.mint({model: "gpt-realtime", instructions: "Be kind."});

    assert.match(grant.value, /^ek_mock_/);
    assert.equal(grant.expires_at, 1_120);
    assert.equal(grant.base_url, "https://x/v1");
    assert.match(grant.session.id, /^sess_mock_/);
    assert.equal(grant.session.type, "realtime");
    assert.deepEqual((grant.session as {tools?: unknown}).tools, [ASK_PLAINLY_TOOL]);
  });
});

function realtimeSession(configuration: ClientSecretCreateParams) {
  const session = configuration.session;
  assert.ok(session && session.type === "realtime");
  return session;
}
