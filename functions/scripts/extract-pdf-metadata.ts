//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {readdir, writeFile} from "node:fs/promises";
import {extname, join} from "node:path";
import {DocumentMetadata} from "../src/services/chunking/text-extraction/document-metadata";
import {PDFTextExtractor} from "../src/services/chunking/text-extraction/pdf-text-extractor";

/** The fields surfaced in the RAG chunk header, see RetrievedDocumentFormatter. */
const FEATURED_COLUMNS: (keyof DocumentMetadata)[] = ["title", "author", "publisher", "year"];

const STANDARD_COLUMNS: (keyof DocumentMetadata)[] = [
  "subject",
  "keywords",
  "creator",
  "producer",
  "creationDate",
  "modDate",
  "url",
];

const KNOWN_COLUMNS = [...FEATURED_COLUMNS, ...STANDARD_COLUMNS];

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toRow(filename: string, metadata: DocumentMetadata | undefined): string {
  const featured = FEATURED_COLUMNS.map((key) => csvCell(metadata?.[key]));
  const standard = STANDARD_COLUMNS.map((key) => csvCell(metadata?.[key]));
  const custom = Object.fromEntries(
    Object.entries(metadata ?? {}).filter(([key]) => !KNOWN_COLUMNS.includes(key as keyof DocumentMetadata)),
  );
  const customJson = Object.keys(custom).length > 0 ? JSON.stringify(custom) : "";
  return [csvCell(filename), ...featured, ...standard, csvCell(customJson)].join(",");
}

async function main() {
  const [directory, outputPath] = process.argv.slice(2);
  if (!directory) {
    console.error("Usage: tsx scripts/extract-pdf-metadata.ts <directory> [output.csv]");
    process.exit(1);
  }

  const entries = await readdir(directory, {withFileTypes: true});
  const pdfFiles = entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".pdf")
    .map((entry) => entry.name)
    .sort();

  const extractor = new PDFTextExtractor();
  const rows: string[] = [["filename", ...FEATURED_COLUMNS, ...STANDARD_COLUMNS, "customMetadata"].join(",")];

  for (const filename of pdfFiles) {
    try {
      const {metadata} = await extractor.extract(join(directory, filename));
      rows.push(toRow(filename, metadata));
    } catch (error) {
      console.error(`Failed to extract metadata from "${filename}":`, error);
      rows.push(toRow(filename, undefined));
    }
  }

  const csv = rows.join("\n") + "\n";
  if (outputPath) {
    await writeFile(outputPath, csv, "utf8");
    console.log(`Wrote metadata for ${pdfFiles.length} file(s) to ${outputPath}`);
  } else {
    process.stdout.write(csv);
  }
}

main();
