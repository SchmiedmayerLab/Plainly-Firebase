//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {extractText, getDocumentProxy, getMeta} from "unpdf";
import {readFile} from "node:fs/promises";
import {DocumentMetadata} from "./document-metadata";
import {ExtractionResult, TextExtractor} from "./text-extractor";

/**
 * Maps the PDF Info dictionary's standard keys to {@link DocumentMetadata}
 * fields. pdf.js exposes these by name on `info`; anything outside this set
 * and outside `info.Custom` is pdf.js-internal (e.g. `PDFFormatVersion`,
 * `IsLinearized`) and must not be copied through.
 */
const STANDARD_INFO_KEYS: {key: string; field: keyof DocumentMetadata}[] = [
  {key: "Title", field: "title"},
  {key: "Author", field: "author"},
  {key: "Subject", field: "subject"},
  {key: "Keywords", field: "keywords"},
  {key: "Creator", field: "creator"},
  {key: "Producer", field: "producer"},
];

/** Extracts text and Info-dictionary metadata from PDF files using unpdf. */
export class PDFTextExtractor implements TextExtractor {
  async extract(filePath: string): Promise<ExtractionResult> {
    const buffer = await readFile(filePath);
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const [{text}, meta] = await Promise.all([
      extractText(pdf, {mergePages: true}),
      getMeta(pdf, {parseDates: true}),
    ]);

    return {
      segments: [this.clean(text)],
      metadata: this.extractMetadata(meta.info),
    };
  }

  private extractMetadata(info: Record<string, unknown>): DocumentMetadata | undefined {
    const metadata: DocumentMetadata = {};

    for (const {key, field} of STANDARD_INFO_KEYS) {
      const value = info[key];
      if (typeof value === "string" && value.trim()) {
        metadata[field] = value;
      }
    }

    const creationDate = this.toIsoString(info.CreationDate);
    if (creationDate) metadata.creationDate = creationDate;
    const modDate = this.toIsoString(info.ModDate);
    if (modDate) metadata.modDate = modDate;

    // Genuinely custom Info dict entries (e.g. a publisher's own "Publisher"
    // key) are nested by pdf.js under `info.Custom`, not at the top level.
    const custom = info.Custom;
    if (custom && typeof custom === "object") {
      for (const [key, value] of Object.entries(custom as Record<string, unknown>)) {
        if (value === undefined || value === null || value === "") continue;
        metadata[this.lowerFirst(key)] = value;
      }
    }

    const year = this.deriveYear(metadata.year, info.CreationDate);
    if (year !== undefined) metadata.year = year;
    else delete metadata.year;

    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  /** An explicit custom "year"/"Year" value wins; otherwise derive from CreationDate. */
  private deriveYear(explicit: unknown, creationDate: unknown): number | undefined {
    if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
    if (typeof explicit === "string" && /^\d{4}$/.test(explicit)) return Number(explicit);
    if (creationDate instanceof Date && !isNaN(creationDate.getTime())) {
      return creationDate.getFullYear();
    }
    return undefined;
  }

  private toIsoString(value: unknown): string | undefined {
    return value instanceof Date && !isNaN(value.getTime()) ? value.toISOString() : undefined;
  }

  private lowerFirst(key: string): string {
    return key.length > 0 ? key[0].toLowerCase() + key.slice(1) : key;
  }

  private clean(raw: string): string {
    return raw
      .normalize("NFKC")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/([a-zA-Z])-\s*\n\s*([a-zA-Z])/g, "$1$2")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
}
