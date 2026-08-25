//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {Response, ResponseStreamEvent} from "openai/resources/responses/responses";
import {
  CITATION_DELIMITER,
  CITATION_START,
  CITATION_STOP,
} from "../src/services/chat/citation-marker";
import {CitationOutputTransform} from "../src/services/chat/citation-output-transform";
import {CitationSource} from "../src/services/chat/citation-source";

const cite = (sourceId: string) =>
  CITATION_START + "cite" + CITATION_DELIMITER + sourceId + CITATION_STOP;

const GUIDELINE: CitationSource = {
  id: "sguidelinec1",
  file: "guideline.pdf",
  title: "Smith et al. (2021) — Lumbar Fusion Guideline · NASS",
};
// A second chunk of the same document: the model can cite either, but a reader has one source.
const GUIDELINE_OTHER_CHUNK: CitationSource = {...GUIDELINE, id: "sguidelinec9"};
const TRIAL: CitationSource = {
  id: "strialc0",
  file: "trial.pdf",
  title: "Doe (2019) — Conservative Management Trial",
};

function transform(...sources: CitationSource[]): CitationOutputTransform {
  return new CitationOutputTransform(new Map(sources.map((source) => [source.id, source])));
}

function delta(text: string, sequenceNumber = 0): ResponseStreamEvent {
  return {
    type: "response.output_text.delta",
    delta: text,
    item_id: "msg-1",
    output_index: 0,
    content_index: 0,
    logprobs: [],
    sequence_number: sequenceNumber,
  };
}

function stream(
  subject: CitationOutputTransform,
  deltas: string[],
): {text: string; annotations: unknown[]} {
  const events = deltas.flatMap((part, index) => subject.handleEvent(delta(part, index)));
  return {
    text: events
      .filter((event) => event.type === "response.output_text.delta")
      .map((event) => event.delta)
      .join(""),
    annotations: events
      .filter((event) => event.type === "response.output_text.annotation.added")
      .map((event) => event.annotation),
  };
}

function message(text: string, annotations: unknown[] = []): Response {
  return {
    id: "resp-1",
    object: "response",
    created_at: 0,
    status: "completed",
    model: "test-model",
    output: [{
      id: "msg-1",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{type: "output_text", text, annotations}],
    }],
    output_text: text,
  } as unknown as Response;
}

function messageAnnotations(response: Response): unknown[] {
  const item = response.output[0];
  assert.equal(item.type, "message");
  const content = item.type === "message" ? item.content[0] : undefined;
  return content?.type === "output_text" ? content.annotations : [];
}

function messageText(response: Response): string {
  const item = response.output[0];
  const content = item.type === "message" ? item.content[0] : undefined;
  return content?.type === "output_text" ? content.text : "";
}

describe("CitationOutputTransform streaming", () => {
  it("passes text without a marker through untouched", () => {
    const result = stream(transform(GUIDELINE), ["Fusion ", "improves ", "function."]);
    assert.equal(result.text, "Fusion improves function.");
    assert.deepEqual(result.annotations, []);
  });

  it("strips a marker and announces the citation it carried", () => {
    const result = stream(transform(GUIDELINE), [`Fusion helps.${cite(GUIDELINE.id)} Rest too.`]);

    assert.equal(result.text, "Fusion helps. Rest too.");
    assert.deepEqual(result.annotations, [{
      type: "file_citation",
      file_id: "guideline.pdf",
      filename: GUIDELINE.title,
      index: 13,
    }]);
  });

  it("holds back a marker that arrives across several deltas", () => {
    const marker = cite(GUIDELINE.id);
    const result = stream(transform(GUIDELINE), [
      "Fusion helps.",
      marker.slice(0, 3),
      marker.slice(3, 9),
      marker.slice(9),
      " Rest too.",
    ]);

    // The reader never sees a fragment of a marker, even mid-stream.
    assert.equal(result.text, "Fusion helps. Rest too.");
    assert.equal(result.annotations.length, 1);
    assert.deepEqual(result.annotations, [{
      type: "file_citation",
      file_id: "guideline.pdf",
      filename: GUIDELINE.title,
      index: 13,
    }]);
  });

  it("counts the index in cleaned text across deltas", () => {
    const result = stream(transform(GUIDELINE, TRIAL), [
      `One.${cite(TRIAL.id)}`,
      ` Two.${cite(GUIDELINE.id)}`,
    ]);

    assert.equal(result.text, "One. Two.");
    assert.deepEqual(
      result.annotations.map((annotation) => (annotation as {index: number}).index),
      [4, 9],
    );
  });

  it("cites one document once, however many of its chunks the model marks", () => {
    const result = stream(transform(GUIDELINE, GUIDELINE_OTHER_CHUNK, TRIAL), [
      `One.${cite(GUIDELINE.id)} Two.${cite(GUIDELINE_OTHER_CHUNK.id)} Three.${cite(TRIAL.id)}`,
    ]);

    assert.deepEqual(
      result.annotations.map((annotation) => (annotation as {file_id: string}).file_id),
      ["guideline.pdf", "trial.pdf"],
    );
  });

  it("drops a marker for a source this request never issued", (context) => {
    context.mock.method(console, "warn", () => undefined);
    const result = stream(transform(GUIDELINE), [`Fusion helps.${cite("sstalec3")} Rest too.`]);

    // Stripped from the text, but never resolved to whichever document holds that slot now.
    assert.equal(result.text, "Fusion helps. Rest too.");
    assert.deepEqual(result.annotations, []);
  });

  it("gives up on a start character the model never terminates", () => {
    const runOn = `${CITATION_START}${"x".repeat(200)}`;
    const result = stream(transform(GUIDELINE), [runOn]);

    // Held back forever, the rest of the answer would never reach the reader.
    assert.equal(result.text, "x".repeat(200));
    assert.deepEqual(result.annotations, []);
  });

  it("numbers the annotations it injects within the content part", () => {
    const subject = transform(GUIDELINE, TRIAL);
    const events = subject.handleEvent(
      delta(`One.${cite(GUIDELINE.id)} Two.${cite(TRIAL.id)}`),
    );
    const added = events.filter((event) => event.type === "response.output_text.annotation.added");
    assert.deepEqual(added.map((event) => event.annotation_index), [0, 1]);
  });

  it("puts the annotations on the finished message item, where a client reads them", () => {
    const subject = transform(GUIDELINE);
    const [event] = subject.handleEvent({
      type: "response.output_item.done",
      output_index: 0,
      sequence_number: 0,
      item: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: `Fusion helps.${cite(GUIDELINE.id)}`,
          annotations: [],
        }],
      },
    });

    assert.equal(event.type, "response.output_item.done");
    const item = event.type === "response.output_item.done" ? event.item : undefined;
    const content = item?.type === "message" ? item.content[0] : undefined;
    assert.equal(content?.type === "output_text" ? content.text : "", "Fusion helps.");
    assert.equal(content?.type === "output_text" ? content.annotations.length : 0, 1);
  });
});

describe("CitationOutputTransform.transformResponse", () => {
  it("rewrites a completed response the same way the stream was rewritten", () => {
    const result = transform(GUIDELINE)
      .transformResponse(message(`Fusion helps.${cite(GUIDELINE.id)}`));

    assert.equal(messageText(result), "Fusion helps.");
    assert.equal(result.output_text, "Fusion helps.");
    assert.deepEqual(messageAnnotations(result), [{
      type: "file_citation",
      file_id: "guideline.pdf",
      filename: GUIDELINE.title,
      index: 13,
    }]);
  });

  it("leaves a response the model did not mark exactly as it was", () => {
    const untouched = message("Fusion helps.");
    assert.equal(transform(GUIDELINE).transformResponse(untouched), untouched);
  });

  it("keeps annotations the provider produced itself", () => {
    const provided = {
      type: "url_citation",
      url: "https://example.com/evidence",
      title: "Evidence",
      start_index: 0,
      end_index: 5,
    };
    const result = transform(GUIDELINE)
      .transformResponse(message(`Fusion helps.${cite(GUIDELINE.id)}`, [provided]));

    // A url_citation is provenance too; the file citation is added alongside it, not over it.
    assert.equal(messageAnnotations(result).length, 2);
    assert.deepEqual(messageAnnotations(result)[0], provided);
  });
});

describe("citation markers carried over from an earlier turn", () => {
  it("never credits a claim to a document that took the identifier's place", (context) => {
    context.mock.method(console, "warn", () => undefined);
    // The second round trip retrieved a different set, so the first call's marker names nothing.
    const secondRoundTrip = transform(TRIAL);
    const result = stream(secondRoundTrip, [`Fusion helps.${cite(GUIDELINE.id)}`]);

    assert.equal(result.text, "Fusion helps.");
    assert.deepEqual(result.annotations, []);
  });

  it("still cites a document that is retrieved again", () => {
    const secondRoundTrip = transform(TRIAL, GUIDELINE);
    const result = stream(secondRoundTrip, [`Fusion helps.${cite(GUIDELINE.id)}`]);

    assert.deepEqual(
      result.annotations.map((annotation) => (annotation as {file_id: string}).file_id),
      ["guideline.pdf"],
    );
  });
});

describe("CitationOutputTransform flushing", () => {
  it("releases text held back when the stream ends without completing a marker", () => {
    const subject = transform(GUIDELINE);
    const streamed = subject.handleEvent(delta(`See ${CITATION_START} the figure`));
    const flushed = subject.handleEvent({
      type: "response.output_text.done",
      text: `See ${CITATION_START} the figure`,
      item_id: "msg-1",
      output_index: 0,
      content_index: 0,
      logprobs: [],
      sequence_number: 1,
    });

    const text = [...streamed, ...flushed]
      .filter((event) => event.type === "response.output_text.delta")
      .map((event) => event.delta)
      .join("");
    // The reader gets the whole sentence, minus the character that was never part of a marker.
    assert.equal(text, "See  the figure");
  });
});

describe("CitationOutputTransform reporting", () => {
  it("says so when an answer built on evidence cited none of it", (context) => {
    const warnings: string[] = [];
    context.mock.method(console, "warn", (message: string) => {
      warnings.push(message);
    });

    transform(GUIDELINE).transformResponse(message("Fusion helps."));

    // Plainly serves several models, and one that ignores the syntax looks exactly like one with
    // nothing to cite. Without this line the difference never shows up in production.
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /cited none of the 1 retrieved sources/);
  });

  it("stays quiet when the answer did cite something", (context) => {
    const warnings: string[] = [];
    context.mock.method(console, "warn", (message: string) => {
      warnings.push(message);
    });

    transform(GUIDELINE).transformResponse(message(`Fusion helps.${cite(GUIDELINE.id)}`));

    assert.deepEqual(warnings, []);
  });

  it("stays quiet for a response that is still being built", (context) => {
    const warnings: string[] = [];
    context.mock.method(console, "warn", (message: string) => {
      warnings.push(message);
    });

    const subject = transform(GUIDELINE);
    subject.handleEvent({
      type: "response.created",
      response: {...message(""), status: "in_progress", output: []},
      sequence_number: 0,
    });

    assert.deepEqual(warnings, []);
  });
});
