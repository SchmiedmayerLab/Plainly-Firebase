//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {ALLOWED_MODELS, parseResponseRequest} from "../src/services/chat/response-request";

// Restated rather than imported, so that flipping a model's support in the source is a deliberate
// two-sided change instead of one the test silently follows.
const SAMPLING_TOLERANT_MODELS = new Set([
  "gpt-4o",
  "claude-haiku-4-5",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "Llama-4",
]);

describe("parseResponseRequest", () => {
  it("accepts the Stanford test deployment model", () => {
    const request = {
      model: "gpt-5.4",
      input: "Hello",
      stream: false,
    };

    assert.deepEqual(parseResponseRequest(JSON.stringify(request)), {
      ...request,
      store: true,
    });
  });

  it("drops sampling controls a reasoning model would reject", () => {
    const request = {
      model: "gpt-5.5",
      input: "Hello",
      temperature: 0,
      top_p: 0.4,
      stream: false,
    };

    assert.deepEqual(parseResponseRequest(JSON.stringify(request)), {
      model: "gpt-5.5",
      input: "Hello",
      stream: false,
      store: true,
    });
  });

  it("keeps sampling controls for a model that accepts them", () => {
    const request = {
      model: "gpt-4o",
      input: "Hello",
      temperature: 0,
      stream: false,
    };

    assert.deepEqual(parseResponseRequest(JSON.stringify(request)), {
      ...request,
      store: true,
    });
  });

  it("drops sampling controls for the Claude generation that rejects them", () => {
    const request = {
      model: "claude-sonnet-5",
      input: "Hello",
      temperature: 0,
      top_p: 0.2,
      stream: false,
    };

    assert.deepEqual(parseResponseRequest(JSON.stringify(request)), {
      model: "claude-sonnet-5",
      input: "Hello",
      stream: false,
      store: true,
    });
  });

  it("answers the sampling question for every model it allows", () => {
    // A model reaches production through this allowlist, so this is the point at which its sampling
    // support has to be known. An entry added without one would otherwise inherit whatever the last
    // model happened to declare.
    for (const model of ALLOWED_MODELS) {
      const parsed = parseResponseRequest(JSON.stringify({
        model,
        input: "Hello",
        temperature: 0,
        stream: false,
      })) as Record<string, unknown>;
      assert.equal(
        "temperature" in parsed,
        SAMPLING_TOLERANT_MODELS.has(model),
        `${model} neither keeps nor drops sampling controls deliberately.`,
      );
    }
  });

  it("accepts the Responses request emitted by Plainly", () => {
    const request = {
      model: "gpt-5.5",
      instructions: "Answer clearly.",
      input: [{role: "user", content: "Hello"}],
      tools: [{
        type: "function",
        name: "get_resources",
        description: "Retrieve health records.",
        parameters: {type: "object", properties: {}},
        strict: false,
      }],
      tool_choice: "auto",
      reasoning: {summary: "auto"},
      stream: true,
    };

    assert.deepEqual(parseResponseRequest(JSON.stringify(request)), {
      ...request,
      store: true,
    });
  });

  for (const type of ["web_search_preview", "file_search", "mcp", "code_interpreter"]) {
    it(`rejects the server-executed ${type} tool`, () => {
      assert.throws(
        () => parseResponseRequest(JSON.stringify({
          model: "gpt-5.5",
          input: "Hello",
          tools: [{type}],
          stream: true,
        })),
        /Only named client-side function tools are supported/,
      );
    });
  }

  it("rejects conversation and background APIs", () => {
    assert.throws(
      () => parseResponseRequest(JSON.stringify({
        model: "gpt-5.5",
        input: "Hello",
        background: true,
      })),
      /Unsupported Responses API property 'background'/,
    );
    assert.throws(
      () => parseResponseRequest(JSON.stringify({
        model: "gpt-5.5",
        input: "Hello",
        conversation: "conversation-1",
      })),
      /Unsupported Responses API property 'conversation'/,
    );
  });

  it("accepts the bounded inline image shape emitted by Plainly", () => {
    const request = {
      model: "gpt-5.5",
      input: [{
        type: "message",
        role: "user",
        content: [{
          type: "input_image",
          image_url: "data:image/jpeg;base64,/9j/2Q==",
          detail: "auto",
        }],
      }],
    };

    assert.deepEqual(parseResponseRequest(JSON.stringify(request)), {
      ...request,
      store: true,
    });
  });

  it("rejects item references and participant uploads", () => {
    assert.throws(
      () => parseResponseRequest(JSON.stringify({
        model: "gpt-5.5",
        input: [{type: "item_reference", id: "item-1"}],
      })),
      /Unsupported Responses API input item 'item_reference'/,
    );
    assert.throws(
      () => parseResponseRequest(JSON.stringify({
        model: "gpt-5.5",
        input: [{
          type: "message",
          role: "user",
          content: [{type: "input_image", image_url: "https://example.com/image"}],
        }],
      })),
      /Only inline JPEG and PNG data URLs are supported/,
    );
    assert.throws(
      () => parseResponseRequest(JSON.stringify({
        model: "gpt-5.5",
        input: [{
          type: "message",
          role: "user",
          content: [{type: "input_file", file_data: "data:text/plain;base64,SGVsbG8="}],
        }],
      })),
      /Chat file uploads are not enabled/,
    );
  });

  it("rejects models and output budgets outside the Plainly policy", () => {
    assert.throws(
      () => parseResponseRequest(JSON.stringify({
        model: "unconfigured-model",
        input: "Hello",
      })),
      /model is not enabled for Plainly/,
    );
    assert.throws(
      () => parseResponseRequest(JSON.stringify({
        model: "gpt-5.5",
        input: "Hello",
        max_output_tokens: 100_000,
      })),
      /limited to 32768 output tokens/,
    );
  });

  it("validates stateful Responses properties", () => {
    assert.throws(
      () => parseResponseRequest(JSON.stringify({
        model: "gpt-5.5",
        input: "Hello",
        store: "true",
      })),
      /store property must be a Boolean/,
    );
    assert.throws(
      () => parseResponseRequest(JSON.stringify({
        model: "gpt-5.5",
        input: "Hello",
        store: false,
      })),
      /requires stored Responses API state/,
    );
    assert.throws(
      () => parseResponseRequest(JSON.stringify({
        model: "gpt-5.5",
        input: "Hello",
        previous_response_id: "",
      })),
      /previous response identifier is invalid/,
    );
  });

  it("accepts the long response identifiers a gateway returns", () => {
    // Stanford's gateway encodes routing state into the identifier, which is several hundred
    // characters long; rejecting it broke every turn after the first.
    const gatewayResponseId = `resp_${"A_b-9".repeat(160)}`;
    assert.ok(gatewayResponseId.length > 600);
    const parsed = parseResponseRequest(JSON.stringify({
      model: "gpt-5.5",
      input: "Hello",
      previous_response_id: gatewayResponseId,
    }));
    assert.equal(parsed.previous_response_id, gatewayResponseId);

    assert.throws(
      () => parseResponseRequest(JSON.stringify({
        model: "gpt-5.5",
        input: "Hello",
        previous_response_id: "r".repeat(4097),
      })),
      /previous response identifier is invalid/,
    );
  });
});
