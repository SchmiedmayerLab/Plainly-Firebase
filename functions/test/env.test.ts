//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import assert from "node:assert/strict";
import {afterEach, describe, it} from "node:test";
import {realtimeCredentials} from "../src/env";

const NAMES = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_REALTIME_API_KEY", "OPENAI_REALTIME_BASE_URL"];

describe("realtimeCredentials", () => {
  afterEach(() => {
    for (const name of NAMES) {
      delete process.env[name];
    }
  });

  it("shares the chat pair while no realtime key is set", () => {
    process.env.OPENAI_API_KEY = "chat-key";
    process.env.OPENAI_BASE_URL = "https://gateway/v1";
    process.env.OPENAI_REALTIME_API_KEY = " ";

    assert.deepEqual(realtimeCredentials(), {apiKey: "chat-key", baseUrl: "https://gateway/v1"});
  });

  it("uses the realtime pair once a realtime key is set", () => {
    process.env.OPENAI_API_KEY = "chat-key";
    process.env.OPENAI_BASE_URL = "https://gateway/v1";
    process.env.OPENAI_REALTIME_API_KEY = "voice-key";

    assert.throws(realtimeCredentials, /OPENAI_REALTIME_BASE_URL/);

    process.env.OPENAI_REALTIME_BASE_URL = "https://api.openai.com/v1";
    assert.deepEqual(realtimeCredentials(), {apiKey: "voice-key", baseUrl: "https://api.openai.com/v1"});
  });
});
