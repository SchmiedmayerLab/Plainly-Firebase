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
import {createMockOpenAIClient, MockOpenAIClientOptions} from "./chat/mock-openai-client";
import {openAI} from "@genkit-ai/compat-oai/openai";
import {OpenAI} from "openai/client";

export interface ServiceOptions {
  studyId: string;
  openAIApiKey: string;
  openAIBaseUrl?: string;
  ragEnabled?: boolean;
  /** The behaviour the emulator should stand in for, named by one of `MOCK_SCENARIOS`. */
  mockScenario?: string;
}

/**
 * A path the deployed backend only reaches by failing, which the emulator can produce on demand.
 *
 * One at a time: each describes a whole run, so combining two would describe neither.
 */
const MOCK_SCENARIOS = {
  chatError: {rejectRequest: true},
  chatErrorAfterFirstChunk: {rejectStreamAfterFirstChunk: true},
  responseStreamingUnsupported: {rejectStreamingRequest: true},
  incrementalResponseState: {validateResponseState: true},
  responseToolCall: {returnFunctionCall: true},
  responseCitations: {citeRetrievedContext: true},
} as const satisfies Record<string, MockOpenAIClientOptions>;

const CUSTOM_OPENAI_PLUGIN_NAME = "customOpenAI";
const EMBEDDING_MODEL = "text-embedding-ada-002";

/**
 * The Genkit instance together with the embedder reference valid for it.
 *
 * The reference must be created from the plugin that is actually registered:
 * `openAI.embedder(...)` produces an `openai/...` reference, which no
 * `openAICompatible` plugin can resolve.
 */
export interface AIContext {
  ai: Genkit;
  embedder: EmbedderReference;
}

export function createAI(options: ServiceOptions): AIContext {
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
    return new ChatService(createMockOpenAIClient(mockResponse, mockScenarioOptions(options.mockScenario)));
  }
  // A separate unstreamed request handles gateways without Responses streaming;
  // SDK retries would only delay that fallback.
  const client = new OpenAI({
    baseURL: options.openAIBaseUrl,
    apiKey: options.openAIApiKey,
  });
  const responsesStreamingSupported = supportsResponsesStreaming();
  if (!options.ragEnabled) {
    return new ChatService(client, [], responsesStreamingSupported);
  }
  const {ai, embedder} = createAI(options);
  const contextStore = new FirestoreContextStore(options.studyId, ai, embedder);
  return new ChatService(
    client,
    [new AgenticContextChatInterceptor(contextStore, client)],
    responsesStreamingSupported,
  );
}

/**
 * Resolves a scenario name into the behaviour the mock should stand in for.
 *
 * An unknown name is an error rather than a default: a test that asked for a scenario the emulator does
 * not have would otherwise pass against ordinary behaviour and prove nothing.
 */
function mockScenarioOptions(scenario: string | undefined): MockOpenAIClientOptions {
  if (scenario === undefined) {
    return {};
  }
  if (!(scenario in MOCK_SCENARIOS)) {
    throw new Error(`Unknown Firebase mock scenario '${scenario}'.`);
  }
  return MOCK_SCENARIOS[scenario as keyof typeof MOCK_SCENARIOS];
}

/** Returns whether the configured endpoint should receive streamed Responses requests. */
export function supportsResponsesStreaming(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const configured = environment.OPENAI_RESPONSES_STREAMING_SUPPORTED?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  return true;
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
