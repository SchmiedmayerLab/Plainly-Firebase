//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {access, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {PDFDocument, PDFHexString, PDFName} from "pdf-lib";

/** Checks whether a file exists at the given path. */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Capitalizes the first letter of a key string to match PDF Info dictionary conventions. */
function capitalizeFirst(key: string): string {
  return key.length > 0 ? key[0].toUpperCase() + key.slice(1) : key;
}

/** Parses RFC 4180 CSV string into records mapped by header names. */
function parseCsv(csvText: string): Record<string, string>[] {
  const rows: string[][] = [];
  let currentCell = "";
  let currentRow: string[] = [];
  let insideQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];
    const nextChar = csvText[i + 1];

    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        currentCell += '"';
        i++;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (char === "," && !insideQuotes) {
      currentRow.push(currentCell);
      currentCell = "";
    } else if ((char === "\r" || char === "\n") && !insideQuotes) {
      if (char === "\r" && nextChar === "\n") i++;
      currentRow.push(currentCell);
      currentCell = "";
      if (currentRow.length > 1 || currentRow[0] !== "") {
        rows.push(currentRow);
      }
      currentRow = [];
    } else {
      currentCell += char;
    }
  }

  if (currentCell !== "" || currentRow.length > 0) {
    currentRow.push(currentCell);
    rows.push(currentRow);
  }

  if (rows.length === 0) return [];

  const [headers, ...dataRows] = rows;
  return dataRows.map((row) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header.trim()] = row[index]?.trim() ?? "";
    });
    return record;
  });
}

/** Reads metadata fields from a parsed CSV row and writes them into the target PDF file. */
async function applyMetadata(filePath: string, record: Record<string, string>): Promise<void> {
  if (!(await fileExists(filePath))) {
    throw new Error(`File does not exist: ${filePath}`);
  }

  const buffer = await readFile(filePath);
  const pdfDoc = await PDFDocument.load(buffer, {ignoreEncryption: true});

  // Standard metadata fields
  if (record.title) pdfDoc.setTitle(record.title);
  if (record.author) pdfDoc.setAuthor(record.author);
  if (record.subject) pdfDoc.setSubject(record.subject);
  if (record.creator) pdfDoc.setCreator(record.creator);
  if (record.producer) pdfDoc.setProducer(record.producer);

  if (record.keywords) {
    const keywordsList = record.keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    pdfDoc.setKeywords(keywordsList);
  }

  if (record.creationDate) {
    const date = new Date(record.creationDate);
    if (!isNaN(date.getTime())) pdfDoc.setCreationDate(date);
  }

  if (record.modDate) {
    const date = new Date(record.modDate);
    if (!isNaN(date.getTime())) pdfDoc.setModificationDate(date);
  }

  // Access the lower-level Info dictionary for non-standard fields (publisher, year, custom metadata)
  const infoDict = (pdfDoc as unknown as {getInfoDict: () => {set: (key: PDFName, val: PDFHexString) => void}}).getInfoDict();

  if (record.publisher) {
    infoDict.set(PDFName.of("Publisher"), PDFHexString.fromText(record.publisher));
  }

  if (record.year) {
    infoDict.set(PDFName.of("Year"), PDFHexString.fromText(record.year));
  }

  if (record.customMetadata) {
    try {
      const customObj = JSON.parse(record.customMetadata);
      if (customObj && typeof customObj === "object") {
        for (const [key, val] of Object.entries(customObj)) {
          if (val !== undefined && val !== null && val !== "") {
            const pdfKey = capitalizeFirst(key);
            infoDict.set(PDFName.of(pdfKey), PDFHexString.fromText(String(val)));
          }
        }
      }
    } catch {
      // Ignore invalid JSON string
    }
  }

  const pdfBytes = await pdfDoc.save();
  await writeFile(filePath, pdfBytes);
}

async function main() {
  const [directory, csvPath] = process.argv.slice(2);
  if (!directory || !csvPath) {
    console.error("Usage: tsx scripts/apply-pdf-metadata.ts <directory> <input.csv>");
    process.exit(1);
  }

  if (!(await fileExists(csvPath))) {
    console.error(`CSV file does not exist: ${csvPath}`);
    process.exit(1);
  }

  const csvContent = await readFile(csvPath, "utf8");
  const records = parseCsv(csvContent);

  let successCount = 0;
  let missingCount = 0;
  let errorCount = 0;

  for (const record of records) {
    const filename = record.filename;
    if (!filename) continue;

    const filePath = join(directory, filename);

    if (!(await fileExists(filePath))) {
      console.warn(`[MISSING] File not found: "${filename}"`);
      missingCount++;
      continue;
    }

    try {
      await applyMetadata(filePath, record);
      successCount++;
    } catch (error) {
      errorCount++;
      console.error(`[ERROR] Failed to update metadata for "${filename}":`, error);
    }
  }

  console.log(`\nProcessed ${records.length} record(s):`);
  console.log(`  - Successfully updated: ${successCount}`);
  console.log(`  - Missing files skipped: ${missingCount}`);
  console.log(`  - Errors: ${errorCount}`);
}

main();