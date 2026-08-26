//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {
  Response,
  ResponseOutputItem,
  ResponseOutputText,
  ResponseStreamEvent,
  ResponseTextDeltaEvent,
  ResponseTextDoneEvent,
} from "openai/resources/responses/responses";
import {
  CITATION_START,
  CITATION_STOP,
  MAX_MARKER_LENGTH,
  extractCitations,
  leavesGap,
} from "./citation-marker";
import {CitationSource} from "./citation-source";
import {OutputTransform} from "./output-transform";

type Annotation = ResponseOutputText["annotations"][number];

/** What one streamed content part has produced so far. */
interface PartState {
  /** Text withheld because it may yet turn out to be the start of a marker. */
  pending: string;
  /** How much rendered text has been forwarded, which is what an annotation's index counts. */
  renderedLength: number;
  annotationCount: number;
  citedFiles: Set<string>;
  /** A marker was dropped at the very end of the last delta, so its gap may still need closing. */
  droppedAtEnd: boolean;
  /** The last character forwarded, which is what closing that gap is decided against. */
  tail: string;
}

/** One span of model output as a reader should see it, with the citations it announced. */
interface RenderedText {
  text: string;
  annotations: Annotation[];
}

/**
 * Turns the citation markers the model was asked to write into Responses API annotations.
 *
 * The marker itself never reaches the client. In its place goes the reference number a reader can
 * follow — `[1]`, `[2]`, … — and the citation it carried is attached to the message as an
 * annotation pointing at that number, so a client can show which source the claim rested on and
 * where in the answer it was used.
 */
export class CitationOutputTransform implements OutputTransform {
  private readonly parts = new Map<string, PartState>();
  /** The number a reader sees for each document, by the order the answer first cites it. */
  private readonly referenceNumbers = new Map<string, number>();
  private hasCited = false;

  constructor(private readonly sources: Map<string, CitationSource>) {}

  handleEvent(event: ResponseStreamEvent): ResponseStreamEvent[] {
    switch (event.type) {
    case "response.output_text.delta":
      return this.rewriteDelta(event);
    case "response.output_text.done":
      // Anything still held back has to be released here. A client builds what it shows from the
      // deltas alone, so a tail left in the buffer would simply go missing from the answer.
      return [
        ...this.flushPending(event),
        {...event, text: this.render(event.text, 0).text},
      ];
    case "response.content_part.added":
    case "response.content_part.done":
      return [
        event.part.type === "output_text" ?
          {...event, part: this.rewriteTextPart(event.part)} :
          event,
      ];
    case "response.output_item.added":
    case "response.output_item.done":
      return [{...event, item: this.rewriteOutputItem(event.item)}];
    case "response.created":
    case "response.in_progress":
    case "response.completed":
    case "response.incomplete":
    case "response.failed":
    case "response.queued":
      return [{...event, response: this.transformResponse(event.response)}];
    default:
      return [event];
    }
  }

  transformResponse(response: Response): Response {
    const output = response.output.map((item) => this.rewriteOutputItem(item));
    this.warnIfUncited(response.status);
    if (output.every((item, index) => item === response.output[index])) {
      return response;
    }
    return {...response, output, output_text: outputText(output)};
  }

  /**
   * Says so when an answer built on retrieved evidence cited none of it.
   *
   * A model that ignores the marker syntax produces exactly what a model with nothing worth citing
   * produces — an answer and no sources. Only the model varies, and Plainly serves several, so
   * without this the difference is invisible in production.
   */
  private warnIfUncited(status: Response["status"]): void {
    if (this.hasCited || status !== "completed" || this.sources.size === 0) {
      return;
    }
    this.hasCited = true;
    console.warn(
      `[Citations] A completed answer cited none of the ${this.sources.size} retrieved sources; ` +
      "the model may not be following the citation syntax.",
    );
  }

  /**
   * Streams the delta on with reference numbers in place of its markers, then announces the
   * citations those numbers stand for.
   *
   * A marker can straddle two deltas, so a trailing fragment that might be the start of one is held
   * back until the next delta completes it — or until it grows past the length any marker can have,
   * at which point it was prose after all.
   */
  private rewriteDelta(event: ResponseTextDeltaEvent, isFinal = false): ResponseStreamEvent[] {
    const key = `${event.item_id}:${event.content_index}`;
    const state = this.parts.get(key) ?? newPartState();
    this.parts.set(key, state);

    const buffered = state.pending + event.delta;
    const boundary = isFinal ? buffered.length : markerBoundary(buffered);
    state.pending = buffered.slice(boundary);

    const {text, annotations} = this.render(
      buffered.slice(0, boundary),
      state.renderedLength,
      state,
    );
    state.renderedLength += text.length;

    const events: ResponseStreamEvent[] = [];
    if (text.length > 0) {
      events.push({...event, delta: text});
    }
    for (const annotation of annotations) {
      events.push({
        type: "response.output_text.annotation.added",
        annotation,
        annotation_index: state.annotationCount++,
        content_index: event.content_index,
        item_id: event.item_id,
        output_index: event.output_index,
        // Re-stamped by ChatService, which numbers everything it forwards.
        sequence_number: event.sequence_number,
      });
    }
    return events;
  }

  /** Releases whatever the buffer was still waiting on, once no more text is coming. */
  private flushPending(event: ResponseTextDoneEvent): ResponseStreamEvent[] {
    const state = this.parts.get(`${event.item_id}:${event.content_index}`);
    if (!state?.pending) {
      return [];
    }
    const pending = state.pending;
    state.pending = "";
    return this.rewriteDelta({
      type: "response.output_text.delta",
      delta: pending,
      item_id: event.item_id,
      output_index: event.output_index,
      content_index: event.content_index,
      logprobs: [],
      sequence_number: event.sequence_number,
    }, true);
  }

  /**
   * Rewrites a complete piece of output text.
   *
   * Text without a marker is returned untouched, annotations and all: a `url_citation` the provider
   * itself produced is provenance too, and replacing the array would throw it away.
   */
  private rewriteTextPart(part: ResponseOutputText): ResponseOutputText {
    const {text, annotations} = this.render(part.text, 0, newPartState());
    if (text === part.text) {
      return part;
    }
    return {...part, text, annotations: [...part.annotations, ...annotations]};
  }

  private rewriteOutputItem(item: ResponseOutputItem): ResponseOutputItem {
    if (item.type !== "message") {
      return item;
    }
    const content = item.content.map((part) =>
      part.type === "output_text" ? this.rewriteTextPart(part) : part);
    return content.every((part, index) => part === item.content[index]) ?
      item :
      {...item, content};
  }

  /**
   * Renders one span of raw model output: markers out, reference numbers in.
   *
   * A `state` makes this the streaming case, where citations are announced as they are found and
   * one document is announced only once. Without it nothing is announced, which is what re-deriving
   * a text whose deltas were already forwarded needs.
   */
  private render(raw: string, offset: number, state?: PartState): RenderedText {
    const {text, citations} = extractCitations(raw);
    const annotations: Annotation[] = [];
    let out = "";
    let readIndex = 0;
    let dropped = state?.droppedAtEnd ?? false;

    const append = (chunk: string) => {
      if (chunk === "") {
        return;
      }
      out += dropped && leavesGap(out || (state?.tail ?? ""), chunk) ? chunk.slice(1) : chunk;
      dropped = false;
    };

    for (const citation of citations) {
      append(text.slice(readIndex, citation.index));
      readIndex = citation.index;

      const source = this.sources.get(citation.sourceId);
      if (!source) {
        // A marker the model carried over from an earlier turn, which `previous_response_id` keeps
        // in its view of the conversation. Dropping it costs a citation; honouring it would credit
        // the claim to whichever document happens to hold that identifier now.
        console.warn(`[Citations] Ignoring a marker for unknown source '${citation.sourceId}'`);
        dropped = true;
        continue;
      }

      this.hasCited = true;
      const index = offset + out.length;
      append(`[${this.referenceNumber(source)}]`);
      // At most one annotation per document: the model cites a chunk, but the reference a reader
      // sees describes the document, so two chunks of one PDF would render as the same row twice.
      // The number itself is repeated, since every place the claim was used should carry it.
      if (state && !state.citedFiles.has(source.file)) {
        state.citedFiles.add(source.file);
        annotations.push({
          type: "file_citation",
          file_id: source.file,
          filename: source.title,
          index,
        });
      }
    }
    append(text.slice(readIndex));

    if (state) {
      state.droppedAtEnd = dropped;
      state.tail = out.slice(-1) || state.tail;
    }
    return {text: out, annotations};
  }

  /**
   * The reference number for one document, assigned when the answer first cites it.
   *
   * Kept for the whole response rather than per content part, so the streamed deltas and the
   * finished response — which is rewritten again on every `response.*` event — agree on it.
   */
  private referenceNumber(source: CitationSource): number {
    const assigned = this.referenceNumbers.get(source.file);
    if (assigned !== undefined) {
      return assigned;
    }
    const next = this.referenceNumbers.size + 1;
    this.referenceNumbers.set(source.file, next);
    return next;
  }
}

function newPartState(): PartState {
  return {
    pending: "",
    renderedLength: 0,
    annotationCount: 0,
    citedFiles: new Set(),
    droppedAtEnd: false,
    tail: "",
  };
}

/** How much of the buffer is safe to forward, i.e. cannot be the beginning of an unfinished marker. */
function markerBoundary(buffered: string): number {
  const start = buffered.lastIndexOf(CITATION_START);
  if (start < 0 || buffered.includes(CITATION_STOP, start)) {
    return buffered.length;
  }
  return buffered.length - start > MAX_MARKER_LENGTH ? buffered.length : start;
}

function outputText(output: ResponseOutputItem[]): string {
  return output
    .flatMap((item) => item.type === "message" ? item.content : [])
    .flatMap((content) => content.type === "output_text" ? [content.text] : [])
    .join("");
}
