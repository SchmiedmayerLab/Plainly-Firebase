//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {z} from "genkit";
import OpenAI from "openai";
import {
  FunctionTool,
  ResponseFunctionToolCall,
  ResponseInput,
} from "openai/resources/responses/responses";
import {VERBOSE_LOGGING} from "../../env";
import {ContextStore} from "../context/context-store";
import {ChatInterceptor} from "./chat-interceptor";
import {ResponseBody} from "./chat-service";
import {RetrievedDocumentFormatter} from "./retrieved-document-formatter";

const RAG_QUERY_PROMPT = `
You are a context retrieval assistant for SpineAI, a patient-facing spine health assistant.
Based on the full conversation, determine what information needs to be looked up in the
knowledge base to answer the active unresolved user request. The current input may be a
tool result rather than a new user message; in that case, continue serving the user request
that led to the tool call.

The knowledge base contains medical studies, clinical guidelines, and patient-education
material about spine conditions and treatment.

Before calling the tool, briefly reason (internally, not in your output) about:
- What the patient is actually asking beneath the surface wording.
- What clinical concept(s) this maps to — use precise clinical terminology, since the
  knowledge base is indexed on medical language, not patient phrasing. ("Will I be able to
  play with my grandkids again?" maps to "functional outcomes after lumbar fusion" or
  "return to activity after spinal decompression," not "grandkids play.")
- Whether the patient's known condition (if established earlier in the conversation) should
  be included in the query to narrow results, e.g. "cervical radiculopathy conservative
  management outcomes" rather than "neck nerve pain treatment."
- Whether the question concerns a treatment decision. If so, also search for the relevant
  conservative or non-operative management evidence, not only the surgical/procedural
  literature — patients should see both sides of the evidence landscape, not just whichever
  the surface wording implies.

The 'retrieve_context' tool accepts a single query per call. When more than one query is
needed, call it once per query — up to three separate tool calls — rather than combining
multiple queries into one call's query string. Use more than one query when the question
plausibly maps to more than one distinct clinical concept (for example, a
medication-interaction question about an NSAID and a kidney condition should retrieve
both the medication-safety guidance and the condition-specific guidance separately, not a
single blended query). Prefer queries likely to surface named guidelines or evidence
summaries with clear source/publication information over queries that would return
generic anatomy background, unless the patient specifically asked about anatomy.
`;

const RAG_RETRIEVAL_LIMIT = 10;

const RETRIEVE_CONTEXT_TOOL: FunctionTool = {
  type: "function",
  name: "retrieve_context",
  description:
    "Retrieve relevant context from the knowledge base using a search query.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query to find relevant context.",
      },
    },
    required: ["query"],
  },
  strict: false,
};

/**
 * Uses a non-streaming Responses API tool call to formulate retrieval queries,
 * then adds the retrieved evidence to the request's transient instructions.
 */
export class AgenticContextChatInterceptor implements ChatInterceptor {
  private readonly formatter = new RetrievedDocumentFormatter();

  constructor(
    private readonly contextStore: ContextStore,
    private readonly openai: OpenAI,
  ) {}

  async intercept(body: ResponseBody): Promise<ResponseBody> {
    // The client already decides this by way of `ragEnabled`, and is checked again here: a summary that
    // feeds the study report must be of the record it was given, never of retrieved literature, and that
    // is worth holding true even if a request says otherwise.
    if (!hasStudyChatTool(body)) {
      return body;
    }
    try {
      if (!hasCurrentInput(body.input)) {
        console.warn(
          "[AgenticRAG] Request has no current input; skipping context injection",
        );
        return body;
      }

      const queries = await this.determineQueries(body);
      if (queries.length === 0) {
        console.warn("[AgenticRAG] No queries generated, skipping context injection");
        return body;
      }

      if (VERBOSE_LOGGING) {
        console.log(`[AgenticRAG] Generated ${queries.length} retrieval query or queries`);
      }

      const docs = await Promise.all(
        queries.map((query) => this.contextStore.retrieve(query, RAG_RETRIEVAL_LIMIT)),
      );
      const ragDocs = docs
        .flat()
        .sort((lhs, rhs) => (lhs.distance ?? 1) - (rhs.distance ?? 1))
        .slice(0, RAG_RETRIEVAL_LIMIT);
      const ragContext = this.formatter.format(ragDocs);

      if (!ragContext) {
        console.log("[AgenticRAG] No relevant context found");
        return body;
      }

      const contextInstructions = `[Retrieved Context from Knowledge Base]:\n${ragContext}`;
      return {
        ...body,
        instructions: [body.instructions, contextInstructions]
          .filter((part): part is string => typeof part === "string" && part.length > 0)
          .join("\n\n"),
      };
    } catch (error) {
      console.error("[AgenticRAG] Error during context injection:", error);
      throw new Error(
        "The study knowledge base could not be retrieved.",
        {cause: error},
      );
    }
  }

  private async determineQueries(body: ResponseBody): Promise<string[]> {
    const response = await this.openai.responses.create({
      model: body.model,
      input: body.input,
      previous_response_id: body.previous_response_id,
      instructions: [
        RAG_QUERY_PROMPT,
        ...(body.instructions ?
          ["", `Original system instructions: """${body.instructions}"""`] :
          []),
      ].join("\n"),
      tools: [RETRIEVE_CONTEXT_TOOL],
      tool_choice: {type: "function", name: "retrieve_context"},
      store: false,
      stream: false,
    });

    const toolCalls = response.output.filter(
      (item): item is ResponseFunctionToolCall =>
        item.type === "function_call" && item.name === "retrieve_context",
    );

    if (toolCalls.length === 0) {
      throw new Error("The retrieval planner did not return a context query.");
    }

    try {
      const parsedArguments = z.object({query: z.string().trim().min(1).max(500)}).array()
        .parse(toolCalls.map((toolCall) => JSON.parse(toolCall.arguments)));
      return [...new Set(parsedArguments.map((arguments_) => arguments_.query))]
        .slice(0, 3);
    } catch (error) {
      console.error(
        "[AgenticRAG] Error parsing tool call arguments:",
        error,
      );
      throw new Error("The retrieval planner returned an invalid context query.", {
        cause: error,
      });
    }
  }
}

function hasStudyChatTool(body: ResponseBody): boolean {
  return body.tools?.some(
    (tool) => tool.type === "function" && tool.name === "get_resources",
  ) ?? false;
}

function hasCurrentInput(input: string | ResponseInput | undefined): boolean {
  if (typeof input === "string") {
    return input.trim().length > 0;
  }
  const latestInput = input?.at(-1);
  if (typeof latestInput !== "object" || latestInput === null) {
    return false;
  }
  return ("role" in latestInput && latestInput.role === "user") ||
    ("type" in latestInput && latestInput.type === "function_call_output");
}
