//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {embedderRef, EmbedderReference, Genkit, genkit} from "genkit";
import {
  compatOaiModelRef,
  defineCompatOpenAIEmbedder,
  defineCompatOpenAIModel,
  openAICompatible,
} from "@genkit-ai/compat-oai";
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
import {openAI} from "@genkit-ai/compat-oai/openai";
import {OpenAI} from "openai/client";

export interface ServiceOptions {
  studyId: string;
  openAIApiKey: string;
  openAIBaseUrl?: string;
  ragEnabled?: boolean;
  mockChatError?: boolean;
  mockChatErrorAfterChunk?: boolean;
}

const CUSTOM_OPENAI_PLUGIN_NAME = "customOpenAI";
const EMBEDDING_MODEL = "text-embedding-ada-002";

/**
 * The Genkit instance together with the embedder reference valid for it.
 *
 * The reference must be created from the plugin that is actually registered:
 * `openAI.embedder(...)` produces an `openai/...` reference, which no
 * `openAICompatible` plugin can resolve.
 */
interface AIContext {
  ai: Genkit;
  embedder: EmbedderReference;
}

function createAI(options: ServiceOptions): AIContext {
  if (!options.openAIBaseUrl) {
    return {
      ai: genkit({plugins: [openAI({apiKey: options.openAIApiKey})]}),
      embedder: openAI.embedder(EMBEDDING_MODEL),
    };
  }

  const pluginOptions = {
    name: CUSTOM_OPENAI_PLUGIN_NAME,
    baseURL: options.openAIBaseUrl,
    apiKey: options.openAIApiKey,
  };
  return {
    // `openAICompatible` only resolves models out of the box, so embedders need
    // an explicit resolver — otherwise every `embed`/`retrieve` call throws.
    ai: genkit({plugins: [openAICompatible({
      ...pluginOptions,
      resolver: (client, actionType, actionName) =>
        actionType === "embedder" ?
          defineCompatOpenAIEmbedder({name: actionName, client, pluginOptions}) :
          defineCompatOpenAIModel({
            name: actionName,
            client,
            pluginOptions,
            modelRef: compatOaiModelRef({name: actionName, namespace: CUSTOM_OPENAI_PLUGIN_NAME}),
          }),
    })]}),
    embedder: embedderRef({name: `${CUSTOM_OPENAI_PLUGIN_NAME}/${EMBEDDING_MODEL}`}),
  };
}

export function createContextStore(studyId: string): ContextStore {
  return new FirestoreContextStore(
    studyId,
    genkit({plugins: []}),
    openAI.embedder(EMBEDDING_MODEL),
  );
}

export function createChatService(
  options: ServiceOptions,
  mockResponse = emulatorMockChatResponse(),
): ChatService {
  if (mockResponse !== undefined) {
    return new ChatService(
      createMockOpenAIClient(mockResponse, {
        rejectRequest: options.mockChatError,
        rejectStreamAfterFirstChunk: options.mockChatErrorAfterChunk,
      }),
    );
  }
  const client = new OpenAI({ baseURL: options.openAIBaseUrl, apiKey: options.openAIApiKey });
  if (!options.ragEnabled) {
    return new ChatService(client);
  }
  const {ai, embedder} = createAI(options);
  const contextStore = new FirestoreContextStore(options.studyId, ai, embedder);
  return new ChatService(
    client,
    [new AgenticContextChatInterceptor(contextStore, client)],
  );
}

export function createIndexingService(options: ServiceOptions): IndexingService {
  const {ai, embedder} = createAI(options);
  const contextStore = new FirestoreContextStore(options.studyId, ai, embedder);
  const embeddingService = new GenkitEmbeddingService(ai, embedder);
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
