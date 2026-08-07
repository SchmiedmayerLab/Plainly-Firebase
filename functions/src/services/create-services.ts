//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {genkit} from "genkit";
import { openAICompatible } from "@genkit-ai/compat-oai";
import {ChatService} from "./chat/chat-service";
import {AgenticContextChatInterceptor} from "./chat/agentic-context-chat-interceptor";
import {ComposedChunkingStrategy} from "./chunking/composed-chunking-strategy";
import {DispatchingTextExtractor} from "./chunking/text-extraction/dispatching-text-extractor";
import {PDFTextExtractor} from "./chunking/text-extraction/pdf-text-extractor";
import {PlainTextExtractor} from "./chunking/text-extraction/plain-text-extractor";
import {ContextStore} from "./context/context-store";
import {FirestoreContextStore} from "./context/firestore-context-store";
import {GenkitEmbeddingService} from "./embedding/genkit-embedding-service";
import {IndexingService} from "./indexing/indexing-service";
import {DefaultIndexingService} from "./indexing/default-indexing-service";
import {SlidingWindowTextChunker} from "./chunking/text-chunking/sliding-window-text-chunker";
import {emulatorMockChatResponse} from "../env";
import {createMockOpenAIClient} from "./chat/mock-openai-client";
import { openAI } from "@genkit-ai/compat-oai/openai";

export interface ServiceOptions {
  studyId: string;
  openAIApiKey: string;
  openAIBaseUrl?: string;
  ragEnabled?: boolean;
}

function createAI(options: ServiceOptions) {
  if (options.openAIBaseUrl) {
    return genkit({plugins: [
      openAICompatible({name: "customOpenAI", baseURL: options.openAIBaseUrl, apiKey: options.openAIApiKey})
    ]});
  } else {
    return genkit({plugins: [openAI({apiKey: options.openAIApiKey})]});
  }
}

export function createContextStore(studyId: string): ContextStore {
  return new FirestoreContextStore(studyId, genkit({plugins: []}));
}

export function createChatService(
  options: ServiceOptions,
  mockResponse = emulatorMockChatResponse(),
): ChatService {
  if (mockResponse !== undefined) {
    return new ChatService(
      "plainly-emulator-key",
      [],
      undefined,
      createMockOpenAIClient(mockResponse),
    );
  }
  if (!options.ragEnabled) {
    return new ChatService(options.openAIApiKey, [], options.openAIBaseUrl);
  }
  const ai = createAI(options);
  const contextStore = new FirestoreContextStore(options.studyId, ai);
  return new ChatService(
    options.openAIApiKey,
    [new AgenticContextChatInterceptor(options.openAIApiKey, contextStore)],
    options.openAIBaseUrl,
  );
}

export function createIndexingService(options: ServiceOptions): IndexingService {
  const ai = createAI(options);
  const contextStore = new FirestoreContextStore(options.studyId, ai);
  const embeddingService = new GenkitEmbeddingService(ai);
  const plainTextExtractor = new PlainTextExtractor();
  const chunkingStrategy = new ComposedChunkingStrategy(
    new DispatchingTextExtractor({
      ".pdf": new PDFTextExtractor(),
      ".txt": plainTextExtractor,
      ".md": plainTextExtractor,
    }),
    new SlidingWindowTextChunker(),
  );
  return new DefaultIndexingService(
    chunkingStrategy,
    embeddingService,
    contextStore,
  );
}
