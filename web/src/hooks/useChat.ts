//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import { useMemo, useRef, useState } from "react";
import OpenAI from "openai";
import type { FunctionTool } from "openai/resources/responses/responses";
import { initializeApp } from "firebase/app";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";
import { connectAuthEmulator, initializeAuth, signInAnonymously } from "firebase/auth";
import {
  ResponseConversation,
  resolveResponseModel,
  type ToolCall,
} from "./responses";

export interface RagContextInfo {
  context: string;
  contextLength: number;
  enabled: boolean;
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

const app = initializeApp({
  apiKey: "A00000000000000000000000000000000000000",
  appId: "1:123456789012:ios:1234567890123456789012",
  messagingSenderId: "GCM_SENDER_ID",
  projectId: "som-rit-phi-lit-ai-dev",
});

const auth = initializeAuth(app, {});
connectAuthEmulator(auth, "http://localhost:9099");

const functions = getFunctions(app);
connectFunctionsEmulator(functions, "localhost", 5001);

const model = resolveResponseModel(import.meta.env.VITE_LLM_MODEL);

function urlString(url: string | Request | URL): string {
  return url instanceof Request ? url.url : url.toString();
}

function requestBody(init?: RequestInit): string {
  if (typeof init?.body !== "string") {
    throw new Error("The Firebase Responses request body is missing.");
  }
  return init.body;
}

const createOpenAIClient = (ragEnabled: boolean) => {
  const customFetch = async (
    url: string | Request | URL,
    init?: RequestInit
  ): Promise<Response> => {
    if (urlString(url).includes("/v1/responses")) {
      await signInAnonymously(auth);
      const studyId =
        import.meta.env.VITE_STUDY_ID || "edu.stanford.plainly.spineAI";
      const name =
        `chat?studyId=${studyId}&ragEnabled=${ragEnabled}`
      const body = requestBody(init);
      const callable = httpsCallable<string, string, string>(functions, name);
      const parsedBody = JSON.parse(body) as { stream?: boolean };

      if (!parsedBody.stream) {
        const result = await callable(body);
        return new Response(result.data, {
          headers: { "Content-Type": "application/json" },
        });
      }

      const {stream, data} = await callable.stream(body);
      const responseStream = new ReadableStream({
        start: async (controller) => {
          try {
            for await (const chunk of stream) {
              controller.enqueue(new TextEncoder().encode(chunk));
            }
            const result = await data;
            if (result) {
              controller.enqueue(new TextEncoder().encode(result));
            }
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        }
      });

      return new Response(responseStream, {
        headers: {
          "Content-Type": "text/event-stream",
        },
      });
    }
    return fetch(url, init);
  };

  return new OpenAI({
    apiKey: "dummy",
    dangerouslyAllowBrowser: true,
    fetch: customFetch,
  });
};

// Mock responses for FHIR resource tool calls
const MOCK_RESPONSES: Record<string, string> = {
  "Procedure-Appendectomy-05-25-2014":
    "This is the summary of the requested Procedure-Appendectomy-05-25-2014:\n\nAppendectomy Procedure\nPatient underwent an appendectomy on May 25, 2014. The procedure was completed successfully with no complications. Recovery was uneventful.",
  "Observation-ThyroxineT4-09-04-2014":
    "This is the summary of the requested Observation-ThyroxineT4-09-04-2014:\n\nThyroxine (T4) Lab Result\nThyroxine (T4) level was 1.2 ng/dL, within the normal range of 0.8 to 1.8 ng/dL as of September 4, 2014.",
  "Observation-TSH-09-04-2014":
    "This is the summary of the requested Observation-TSH-09-04-2014:\n\nTSH Lab Result\nThyroid Stimulating Hormone (TSH) level was 2.5 mIU/L, within the normal range of 0.4 to 4.0 mIU/L as of September 4, 2014.",
  "Procedure-ACLrepair-06-09-2021":
    "This is the summary of the requested Procedure-ACLrepair-06-09-2021:\n\nACL Repair Procedure\nCandace Salinas underwent a completed ACL repair procedure on June 9, 2021.",
  "Observation-Totalcholesterol-10-18-2023":
    "This is the summary of the requested Observation-Totalcholesterol-10-18-2023:\n\nCholesterol Test Result\nTotal cholesterol level is 184 mg/dL, within the normal range of 120 to 220 mg/dL, as of October 18, 2023.",
  "Observation-BloodGlucose-10-18-2023":
    "This is the summary of the requested Observation-BloodGlucose-10-18-2023:\n\nBlood Glucose Observation\nBlood glucose level measured at 60 mg/dL, which is below the normal reference range of 61-100 mg/dL, as of October 18, 2023.",
  "Procedure-UltrasoundAbdomen-10-18-2023":
    "This is the summary of the requested Procedure-UltrasoundAbdomen-10-18-2023:\n\nUltrasound Abdomen Procedure\nCompleted ultrasound scan of the lower abdomen performed on 2023-10-18 by Dr. Altick Kelly, a gynecologist.",
  "Observation-CBCpanelBloodbyAutomatedcount-10-18-2023":
    "This is the summary of the requested Observation-CBCpanelBloodbyAutomatedcount-10-18-2023:\n\nCBC Panel Results\nCBC panel shows leukocytes at 111 (10*3/uL), erythrocytes at 222 (10*6/uL), platelets at 333 (10*3/uL), and hemoglobin at 444 g/dL, within the reference range of 400 to 500 g/dL.",
  "Observation-RespiratoryRate-10-18-2023":
    "This is the summary of the requested Observation-RespiratoryRate-10-18-2023:\n\nRespiratory Rate Observation\nRespiratory rate recorded as 22 breaths per minute on October 18, 2023, during encounter 129837645.",
  "Observation-BPbloodpressure-10-18-2023":
    "This is the summary of the requested Observation-BPbloodpressure-10-18-2023:\n\nBlood Pressure Observation\nBlood pressure recorded as 110/70 mmHg on October 18, 2023, during encounter 129837645.",
  "Observation-Weight-10-18-2023":
    "This is the summary of the requested Observation-Weight-10-18-2023:\n\nWeight Observation\nPatient's weight recorded as 155 lbs on October 18, 2023.",
  "Observation-Height-10-18-2023":
    "This is the summary of the requested Observation-Height-10-18-2023:\n\nHeight Observation\nHeight recorded as 164 cm on October 18, 2023.",
  "Observation-LDLcholesterol-10-18-2023":
    "This is the summary of the requested Observation-LDLcholesterol-10-18-2023:\n\nLDL Cholesterol Test Result\nLDL cholesterol level is 113.3 mg/dL, within the normal range of 50 to 178 mg/dL, as of October 18, 2023.",
  "Observation-CholesterolHDL-02-18-2024":
    "This is the summary of the requested Observation-CholesterolHDL-02-18-2024:\n\nCholesterol HDL Test Result\nHDL cholesterol level is 95.5 mg/dL, which is above the normal range of 35 to 59 mg/dL. Test status is final as of February 18, 2024.",
  "Observation-Triglycerides-02-18-2024":
    "This is the summary of the requested Observation-Triglycerides-02-18-2024:\n\nTriglycerides Lab Result\nTriglycerides level is 86 mg/dL, within the normal range of 10 to 250 mg/dL, as of February 18, 2024.",
  "Observation-BMIbodymassindex-02-18-2024":
    "This is the summary of the requested Observation-BMIbodymassindex-02-18-2024:\n\nBMI Observation\nYour BMI is 26.2 kg/m^2 as of February 18, 2024.",
  "Observation-Temperature-02-18-2024":
    "This is the summary of the requested Observation-Temperature-02-18-2024:\n\nTemperature Observation\nThe patient's temperature was recorded as 37.6°C on February 18, 2024, during an encounter. The observation status is final.",
  "Observation-Pulse-02-18-2024":
    "This is the summary of the requested Observation-Pulse-02-18-2024:\n\nPulse Observation\nPulse rate recorded as 77 beats per minute on February 18, 2024.",
};

const SYSTEM_PROMPT = `You are an LLM-powered health assistant for patients. You help patients understand their health records, medical history, and answer health-related questions based on their FHIR data.

When a user asks about their health information, use the get_resources tool to retrieve the relevant FHIR resources. Then, explain the information in simple, patient-friendly language.

Be empathetic, clear, and helpful. If you don't have enough information to answer a question, say so honestly.`;

const tools: FunctionTool[] = [
  {
    type: "function",
    name: "get_resources",
    description:
      "Call this function to request the relevant FHIR health records based on the user's question and conversation context using their FHIR resource identifiers.",
    parameters: {
      type: "object",
      properties: {
        resourceCategories: {
          type: "array",
          description: "Pass in one or more identifiers that you want to access.",
          items: {
            type: "string",
            enum: [
              "Procedure-Appendectomy-05-25-2014",
              "Observation-ThyroxineT4-09-04-2014",
              "Observation-TSH-09-04-2014",
              "Procedure-ACLrepair-06-09-2021",
              "Observation-Totalcholesterol-10-18-2023",
              "Observation-BloodGlucose-10-18-2023",
              "Procedure-UltrasoundAbdomen-10-18-2023",
              "Observation-CBCpanelBloodbyAutomatedcount-10-18-2023",
              "Observation-RespiratoryRate-10-18-2023",
              "Observation-BPbloodpressure-10-18-2023",
              "Observation-Weight-10-18-2023",
              "Observation-Height-10-18-2023",
              "Observation-LDLcholesterol-10-18-2023",
              "Observation-CholesterolHDL-02-18-2024",
              "Observation-Triglycerides-02-18-2024",
              "Observation-BMIbodymassindex-02-18-2024",
              "Observation-Temperature-02-18-2024",
              "Observation-Pulse-02-18-2024",
            ],
          },
        },
      },
      required: ["resourceCategories"],
    },
    strict: false,
  },
];

const executeToolCall = (toolCall: ToolCall): string => {
  const { name, arguments: argsStr } = toolCall;
  const args = JSON.parse(argsStr || "{}");

  if (name === "get_resources") {
    const { resourceCategories } = args as { resourceCategories?: unknown };
    if (!Array.isArray(resourceCategories)) return "No resources requested.";

    return (resourceCategories as string[])
      .map(
        (category) =>
          MOCK_RESPONSES[category] || `No data available for ${category}`
      )
      .join("\n\n");
  }

  return "Unknown tool";
};

interface UseChatOptions {
  ragEnabled?: boolean;
}

export function useChat(options: UseChatOptions = {}) {
  const { ragEnabled = true } = options;

  const openai = useMemo(() => createOpenAIClient(ragEnabled), [ragEnabled]);
  const conversation = useRef(new ResponseConversation());

  const [messages, setMessages] = useState<Message[]>([]);
  const [currentResponse, setCurrentResponse] = useState("");
  const [ragContext, setRagContext] = useState<RagContextInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const reset = () => {
    conversation.current.reset();
    setMessages([]);
    setCurrentResponse("");
    setRagContext(null);
    setIsLoading(false);
  };

  const sendMessage = async (content: string) => {
    if (!content.trim() || isLoading) return;

    setIsLoading(true);
    setCurrentResponse("");
    setRagContext(null);

    const userQuery = content;

    let currentMessages: Message[] = [
      ...messages,
      { role: "user", content: userQuery },
    ];
    setMessages(currentMessages);

    let responseIndex = currentMessages.length;

    try {
      const result = await conversation.current.run({
        request: {
          model,
          instructions: SYSTEM_PROMPT,
          tools,
        },
        input: [{ role: "user", content: userQuery }],
        createResponse: async (request) =>
          await openai.responses.create(request),
        executeTool: executeToolCall,
        onEvent: (event) => {
          const customEvent = event as unknown as Partial<RagContextInfo> & {
            type?: string;
          };
          if (
            customEvent.type === "rag_context" &&
            typeof customEvent.context === "string" &&
            typeof customEvent.contextLength === "number" &&
            typeof customEvent.enabled === "boolean"
          ) {
            setRagContext({
              context: customEvent.context,
              contextLength: customEvent.contextLength,
              enabled: customEvent.enabled,
            });
            return true;
          }
          return false;
        },
        onText: setCurrentResponse,
        onToolRound: ({ text, toolCalls }) => {
          setCurrentResponse("");
          const toolResults: Message[] = toolCalls.map(({ call, output }) => {
            return {
              tool_call_id: call.id,
              role: "tool" as const,
              content: output,
            };
          });

          currentMessages = [
            ...currentMessages,
            {
              role: "assistant",
              content: text,
              tool_calls: toolCalls.map(({ call }) => call),
            },
            ...toolResults,
          ];
          setMessages(currentMessages);

          responseIndex = currentMessages.length;
          setCurrentResponse("");
        },
      });

      currentMessages = [
        ...currentMessages,
        { role: "assistant", content: result.text },
      ];
      setCurrentResponse("");
      setMessages(currentMessages);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to get response";

      setMessages((prev) => {
        const updated = [...prev];
        updated[responseIndex] = {
          role: "assistant",
          content: `Error: ${message}`,
        };
        return updated;
      });
    }

    setIsLoading(false);
    setCurrentResponse("");
  };

  return {
    messages,
    setMessages,
    currentResponse,
    ragContext,
    isLoading,
    sendMessage,
    reset,
  };
}
