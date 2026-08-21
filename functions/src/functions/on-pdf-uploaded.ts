//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {onObjectFinalized} from "firebase-functions/v2/storage";
import {unlink} from "node:fs/promises";
import {extname, join} from "node:path";
import {tmpdir} from "node:os";
import {randomUUID} from "node:crypto";
import {getStorage} from "firebase-admin/storage";
import {
  Secrets,
  SERVICE_ACCOUNT,
  STORAGE_BUCKET,
  STORAGE_FILE_PATH_PATTERN,
  STORAGE_REGION,
} from "../env";
import {createIndexingService} from "../services/create-services";

const SUPPORTED_CONTENT_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
]);

export interface UploadedObject {
  name: string;
  bucket: string;
  contentType?: string;
}

export interface PDFUploadServices {
  downloadObject(
    bucket: string,
    name: string,
    destination: string,
  ): Promise<void>;
  createIndexingService: typeof createIndexingService;
  openAIApiKey: () => string;
  openAIBaseUrl: () => string | undefined;
}

export const onPDFUploaded = onObjectFinalized(
  {
    bucket: STORAGE_BUCKET,
    region: STORAGE_REGION,
    secrets: [Secrets.OPENAI_API_KEY, Secrets.OPENAI_BASE_URL],
    serviceAccount: SERVICE_ACCOUNT,
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async (event) => handlePDFUpload(event.data),
);

export async function handlePDFUpload(
  object: UploadedObject,
  services: PDFUploadServices = {
    downloadObject: async (bucket, name, destination) => {
      await getStorage().bucket(bucket).file(name).download({destination});
    },
    createIndexingService,
    openAIApiKey: () => Secrets.OPENAI_API_KEY.value(),
    openAIBaseUrl: () => Secrets.OPENAI_BASE_URL.value(),
  },
): Promise<void> {
  const match = object.name.match(STORAGE_FILE_PATH_PATTERN);
  const studyId = match?.groups?.studyId;
  const fileName = match?.groups?.fileName;

  if (!match || !studyId || !fileName) {
    console.log(`[Storage] Skipping unmatched path: ${object.name}`);
    return;
  }

  if (!SUPPORTED_CONTENT_TYPES.has(object.contentType ?? "")) {
    console.log(
      `[Storage] Skipping unsupported content type: ${object.name} (${object.contentType})`,
    );
    return;
  }

  console.log(`[Storage] Processing ${fileName} for study ${studyId}`);

  let tempFilePath: string | undefined;
  try {
    const ext = extname(object.name);
    tempFilePath = join(tmpdir(), `${randomUUID()}${ext}`);
    await services.downloadObject(object.bucket, object.name, tempFilePath);

    const indexingService = services.createIndexingService({
      studyId,
      openAIApiKey: services.openAIApiKey(),
      openAIBaseUrl: services.openAIBaseUrl(),
    });

    const result = await indexingService.index(tempFilePath, object.name);
    console.log(`[Storage] Indexing complete for ${object.name}:`, result);
  } catch (error) {
    console.error(`[Storage] Error processing ${object.name}:`, error);
    throw error;
  } finally {
    if (tempFilePath) {
      await unlink(tempFilePath).catch(() => {
        return;
      });
    }
  }
}
