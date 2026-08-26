//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

/**
 * OpenAI's documented citation markers, from
 * https://developers.openai.com/api/docs/guides/citation-formatting.
 *
 * Private-use-area characters, so a marker can never collide with prose the model writes, and a
 * stray one is unambiguously ours rather than something the reader was meant to see. Spelled by
 * code point because the characters themselves are invisible in an editor.
 */
export const CITATION_START = String.fromCharCode(0xe200);
export const CITATION_DELIMITER = String.fromCharCode(0xe202);
export const CITATION_STOP = String.fromCharCode(0xe201);

/** The one citation family Plainly issues; the guide allows others over the same syntax. */
const CITATION_FAMILY = "cite";

/** The guide's own constraint on source identifiers, which also keeps them safe to embed in a prompt. */
const SOURCE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const MARKER_PATTERN = new RegExp(
  `${CITATION_START}([^${CITATION_DELIMITER}${CITATION_STOP}]*)` +
  `${CITATION_DELIMITER}([\\s\\S]*?)${CITATION_STOP}`,
  "g",
);

/** A control character outside a well-formed marker, which must never reach a reader. */
const STRAY_MARKER_CHARACTER = new RegExp(
  `[${CITATION_START}${CITATION_DELIMITER}${CITATION_STOP}]`,
  "g",
);

/**
 * The longest a marker is worth waiting for before a lone start character is treated as prose.
 *
 * Only relevant while streaming: without a bound, a start character the model never terminates
 * would hold the rest of the answer back forever.
 */
export const MAX_MARKER_LENGTH = 128;

export interface ParsedCitation {
  sourceId: string;
  /** The guide's optional third segment, e.g. a line range. Plainly cites whole chunks and ignores it. */
  locator?: string;
  /** Offset into the *cleaned* text at which the marker stood. */
  index: number;
}

export interface ExtractedCitations {
  text: string;
  citations: ParsedCitation[];
}

/**
 * Splits citation markers out of model output, returning the text a reader should see and where
 * each citation pointed.
 *
 * A marker whose family or source identifier is malformed is dropped rather than passed through:
 * it carries no usable provenance, and control characters in a chat bubble are worse than nothing.
 */
export function extractCitations(raw: string): ExtractedCitations {
  const citations: ParsedCitation[] = [];
  let text = "";
  let readIndex = 0;
  let dropped = false;

  const append = (chunk: string) => {
    if (chunk === "") {
      return;
    }
    text += dropped && leavesGap(text, chunk) ? chunk.slice(1) : chunk;
    dropped = false;
  };

  MARKER_PATTERN.lastIndex = 0;
  for (let match = MARKER_PATTERN.exec(raw); match !== null; match = MARKER_PATTERN.exec(raw)) {
    append(stripStrayMarkerCharacters(raw.slice(readIndex, match.index)));
    readIndex = MARKER_PATTERN.lastIndex;

    const [, family, body] = match;
    const [sourceId, locator] = body.split(CITATION_DELIMITER);
    if (family !== CITATION_FAMILY || !SOURCE_ID_PATTERN.test(sourceId ?? "")) {
      // Nothing takes this marker's place, so the space it stood in has to close up behind it.
      dropped = true;
      continue;
    }
    citations.push({
      sourceId,
      ...(locator ? {locator} : {}),
      index: text.length,
    });
  }

  append(stripStrayMarkerCharacters(raw.slice(readIndex)));
  return {text, citations};
}

/** Removes every citation control character, for text that must not carry a marker at all. */
export function stripStrayMarkerCharacters(value: string): string {
  return value.replace(STRAY_MARKER_CHARACTER, "");
}

/**
 * Whether a marker removed between these two halves would leave a gap a reader can see.
 *
 * The model writes its markers between words, so removing one without putting anything in its
 * place leaves the whitespace from both sides behind — the double space in the answer text. Only
 * a marker that leaves nothing needs this: one replaced by a reference number fills its own gap.
 */
export function leavesGap(before: string, after: string): boolean {
  return /\s$/.test(before) && /^\s/.test(after);
}
