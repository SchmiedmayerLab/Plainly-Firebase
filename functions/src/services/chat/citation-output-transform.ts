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
  ParsedCitation,
  extractCitations,
} from "./citation-marker";
import {CitationSource} from "./citation-source";
import {OutputTransform} from "./output-transform";

type Annotation = ResponseOutputText["annotations"][number];

/** What one streamed content part has produced so far. */
interface PartState {
  /** Text withheld because it may yet turn out to be the start of a marker. */
  pending: string;
  /** How much cleaned text has been forwarded, which is what an annotation's index counts. */
  cleanLength: number;
  annotationCount: number;
  citedFiles: Set<string>;
}

/**
 * Turns the citation markers the model was asked to write into Responses API annotations.
 *
 * The markers never reach the client: they are stripped from the streamed text, and the citation
 * each one carried is attached to the message instead, where a client can show it as a source.
 */
export class CitationOutputTransform implements OutputTransform {
  private readonly parts = new Map<string, PartState>();
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
        {...event, text: extractCitations(event.text).text},
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
   * Streams the delta on without its markers, then announces the citations it carried.
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

    const {text, citations} = extractCitations(buffered.slice(0, boundary));
    const annotations = this.resolveAnnotations(citations, state, state.cleanLength);
    state.cleanLength += text.length;

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
    const {text, citations} = extractCitations(part.text);
    if (text === part.text) {
      return part;
    }
    const annotations = this.resolveAnnotations(citations, newPartState(), 0);
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
   * Resolves parsed markers to annotations, at most one per document.
   *
   * The model cites a chunk, but the reference a reader sees describes the document, so two chunks
   * of one PDF would render as the same row twice.
   */
  private resolveAnnotations(
    citations: ParsedCitation[],
    state: PartState,
    offset: number,
  ): Annotation[] {
    const annotations: Annotation[] = [];
    for (const citation of citations) {
      const source = this.sources.get(citation.sourceId);
      if (!source) {
        // A marker the model carried over from an earlier turn, which `previous_response_id` keeps
        // in its view of the conversation. Dropping it costs a citation; honouring it would credit
        // the claim to whichever document happens to hold that identifier now.
        console.warn(`[Citations] Ignoring a marker for unknown source '${citation.sourceId}'`);
        continue;
      }
      if (state.citedFiles.has(source.file)) {
        continue;
      }
      state.citedFiles.add(source.file);
      this.hasCited = true;
      annotations.push({
        type: "file_citation",
        file_id: source.file,
        filename: source.title,
        index: offset + citation.index,
      });
    }
    return annotations;
  }
}

function newPartState(): PartState {
  return {pending: "", cleanLength: 0, annotationCount: 0, citedFiles: new Set()};
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
