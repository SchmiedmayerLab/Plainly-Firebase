//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  handlePDFUpload,
  PDFUploadServices,
  UploadedObject,
} from "../src/functions/on-pdf-uploaded";

interface Recorder {
  services: PDFUploadServices;
  downloads: {bucket: string; name: string; destination: string}[];
  indexed: {path: string; name: string}[];
  options: {studyId: string; openAIBaseUrl?: string}[];
}

function recordingServices(
  overrides: Partial<PDFUploadServices> = {},
): Recorder {
  const downloads: Recorder["downloads"] = [];
  const indexed: Recorder["indexed"] = [];
  const options: Recorder["options"] = [];

  const services: PDFUploadServices = {
    downloadObject: async (bucket, name, destination) => {
      downloads.push({bucket, name, destination});
    },
    createIndexingService: ((serviceOptions: {
      studyId: string;
      openAIBaseUrl?: string;
    }) => {
      options.push(serviceOptions);
      return {
        index: async (path: string, name: string) => {
          indexed.push({path, name});
          return {chunks: 1};
        },
      };
    }) as unknown as PDFUploadServices["createIndexingService"],
    openAIApiKey: () => "test-key",
    openAIBaseUrl: () => "https://gateway.example.com/v1",
    ...overrides,
  };

  return {services, downloads, indexed, options};
}

const pdf: UploadedObject = {
  name: "studies/spineAI/rag_files/handbook.pdf",
  bucket: "plainly.firebasestorage.app",
  contentType: "application/pdf",
};

describe("PDF upload handler", () => {
  it("indexes a supported file uploaded to a study", async () => {
    const recorder = recordingServices();

    await handlePDFUpload(pdf, recorder.services);

    assert.equal(recorder.downloads.length, 1);
    assert.equal(recorder.downloads[0].bucket, pdf.bucket);
    assert.equal(recorder.downloads[0].name, pdf.name);
    assert.equal(recorder.indexed.length, 1);
    assert.equal(recorder.indexed[0].name, pdf.name);
    assert.equal(recorder.options[0].studyId, "spineAI");
  });

  it("passes the configured endpoint to the indexing service", async () => {
    const recorder = recordingServices();

    await handlePDFUpload(pdf, recorder.services);

    assert.equal(
      recorder.options[0].openAIBaseUrl,
      "https://gateway.example.com/v1",
    );
  });

  it("ignores an object outside a study's uploads", async () => {
    const recorder = recordingServices();

    await handlePDFUpload({...pdf, name: "scratch/notes.pdf"}, recorder.services);

    assert.equal(recorder.downloads.length, 0);
    assert.equal(recorder.indexed.length, 0);
  });

  it("ignores a file type the extractors cannot read", async () => {
    const recorder = recordingServices();

    await handlePDFUpload({...pdf, contentType: "image/png"}, recorder.services);

    assert.equal(recorder.downloads.length, 0);
    assert.equal(recorder.indexed.length, 0);
  });

  it("surfaces a failure so the upload is retried", async () => {
    const recorder = recordingServices({
      downloadObject: async () => {
        throw new Error("bucket unavailable");
      },
    });

    await assert.rejects(
      handlePDFUpload(pdf, recorder.services),
      /bucket unavailable/,
    );
    assert.equal(recorder.indexed.length, 0);
  });
});
