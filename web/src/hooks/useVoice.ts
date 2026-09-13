//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import { useCallback, useEffect, useRef, useState } from "react";
import type OpenAI from "openai";
import { signInAnonymously } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import {
  auth,
  createOpenAIClient,
  executeToolCall,
  functions,
  model,
  studyId,
  SYSTEM_PROMPT,
  tools,
} from "./useChat";
import { ResponseConversation } from "./responses";
import {
  DEFAULT_REALTIME_MODEL,
  functionCallOutputEvent,
  realtimeCallsUrl,
  spokenResponseEvent,
  textInputEvents,
  VoiceTurnQueue,
  type RealtimeFunctionCall,
  type RealtimeSessionGrant,
  type VoiceTurn,
} from "./realtime";

export type VoiceStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "forwarding"
  | "speaking"
  | "error";

export interface VoiceEntry {
  id: number;
  kind: "user" | "call" | "answer" | "assistant" | "note";
  content: string;
}

const VOICE_INSTRUCTIONS = `You are the voice of Plainly, a study assistant that helps participants understand their health records.
You never answer questions yourself. For every participant turn, call ask_plainly with what they said, wait for its answer, and read that answer back in a warm, calm voice.
Read the answer as it is. Do not add, shorten, or reinterpret it. Speak in the participant's language.`;

const VOICE_RESPONSE_HINT =
  "\n\nThe participant is talking to you by voice. Answer in plain spoken language, in at most 80 words, without markdown, lists, or citations.";

// A transcript normally lands within a second of the call; past this the model's own words are used.
const TRANSCRIPT_GRACE_MS = 4000;

interface RealtimeEvent {
  type: string;
  item_id?: string;
  item?: { id?: string; type?: string; role?: string; call_id?: string; name?: string; arguments?: string };
  transcript?: string;
  error?: { message?: string };
}

export function useVoice() {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [entries, setEntries] = useState<VoiceEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasMicrophone, setHasMicrophone] = useState(true);

  const connection = useRef<RTCPeerConnection | null>(null);
  const channel = useRef<RTCDataChannel | null>(null);
  const microphone = useRef<MediaStream | null>(null);
  const speaker = useRef<HTMLAudioElement | null>(null);
  const queue = useRef<VoiceTurnQueue | null>(null);
  const conversation = useRef<ResponseConversation | null>(null);
  const openai = useRef<OpenAI | null>(null);
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Forwarded turns run one after another: the Responses chain answers one question per generation.
  const forwarding = useRef<Promise<void>>(Promise.resolve());
  // Bumped by every start and stop, so work from an earlier session cannot touch a later one.
  const generation = useRef(0);
  const nextEntryId = useRef(0);
  queue.current ??= new VoiceTurnQueue();
  conversation.current ??= new ResponseConversation();
  openai.current ??= createOpenAIClient(true);

  const note = useCallback((kind: VoiceEntry["kind"], content: string) => {
    nextEntryId.current += 1;
    setEntries((current) => [...current, { id: nextEntryId.current, kind, content }]);
  }, []);

  const send = useCallback((event: object) => {
    // A channel that is still opening or already closing throws instead of sending.
    if (channel.current?.readyState === "open") channel.current.send(JSON.stringify(event));
  }, []);

  const stop = useCallback((finalStatus: VoiceStatus = "idle") => {
    generation.current += 1;
    if (graceTimer.current) {
      clearTimeout(graceTimer.current);
      graceTimer.current = null;
    }
    channel.current?.close();
    connection.current?.close();
    microphone.current?.getTracks().forEach((track) => track.stop());
    channel.current = null;
    connection.current = null;
    microphone.current = null;
    setStatus(finalStatus);
  }, []);

  const forward = useCallback(async (turn: VoiceTurn, session: number) => {
    if (session !== generation.current) return;
    setStatus("forwarding");
    note("user", turn.question);
    note("call", `${turn.call.name}(${turn.call.arguments}) → question from ${turn.source}`);
    let output: string;
    try {
      const result = await conversation.current!.run({
        request: { model, instructions: SYSTEM_PROMPT + VOICE_RESPONSE_HINT, tools },
        input: [{ role: "user", content: turn.question }],
        createResponse: async (request) => await openai.current!.responses.create(request),
        executeTool: executeToolCall,
      });
      note("answer", result.text);
      output = result.text;
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "Plainly did not answer.";
      note("note", `Chat function failed: ${message}`);
      output = "Plainly could not answer right now. Please try again.";
    }
    // The session may have ended while the chat was answering; nothing to say to it then.
    if (session !== generation.current) return;
    send(functionCallOutputEvent(turn.call.callId, output));
    send(spokenResponseEvent());
    setStatus("speaking");
  }, [note, send]);

  const release = useCallback(() => {
    // A turn belongs to the session it was heard in; one still queued when that session ends is dropped.
    const session = generation.current;
    for (const turn of queue.current!.take()) {
      forwarding.current = forwarding.current
        .then(() => forward(turn, session))
        .catch((failure: unknown) => console.error("voice turn failed", failure));
    }
  }, [forward]);

  // The grace timer re-arms through a ref: a callback cannot name itself, and the timer must see the latest one.
  const flushRef = useRef<() => void>(() => {});
  const flush = useCallback(() => {
    release();
    const awaited = queue.current!.awaitedItemId;
    if (awaited && !graceTimer.current) {
      graceTimer.current = setTimeout(() => {
        graceTimer.current = null;
        queue.current!.transcriptAbandoned(awaited);
        // Another call may be waiting on the next item; this arms its own grace period.
        flushRef.current();
      }, TRANSCRIPT_GRACE_MS);
    }
  }, [release]);
  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  const handle = useCallback((event: RealtimeEvent) => {
    console.debug("realtime event", event.type);
    switch (event.type) {
    case "input_audio_buffer.speech_started":
      setStatus("listening");
      break;
    case "input_audio_buffer.committed":
      if (event.item_id) queue.current!.userItemAdded(event.item_id);
      break;
    case "conversation.item.added":
    case "conversation.item.created":
      if (event.item?.role === "user" && event.item.id) queue.current!.userItemAdded(event.item.id);
      break;
    case "conversation.item.input_audio_transcription.completed":
      if (event.item_id) {
        // A turn of noise transcribes to nothing; the model's own words are the better question then.
        const transcript = event.transcript?.trim();
        if (transcript) {
          queue.current!.transcriptCompleted(event.item_id, transcript);
        } else {
          queue.current!.transcriptAbandoned(event.item_id);
        }
        if (graceTimer.current) {
          clearTimeout(graceTimer.current);
          graceTimer.current = null;
        }
        flush();
      }
      break;
    case "conversation.item.input_audio_transcription.failed":
      if (event.item_id) {
        queue.current!.transcriptAbandoned(event.item_id);
        if (graceTimer.current) {
          clearTimeout(graceTimer.current);
          graceTimer.current = null;
        }
        flush();
      }
      break;
    case "response.output_item.done":
      if (event.item?.type === "function_call" && event.item.call_id && event.item.name) {
        const call: RealtimeFunctionCall = {
          callId: event.item.call_id,
          name: event.item.name,
          arguments: event.item.arguments ?? "{}",
        };
        queue.current!.functionCalled(call);
        flush();
      }
      break;
    case "response.output_audio_transcript.done":
    case "response.audio_transcript.done":
      note("assistant", event.transcript ?? "");
      break;
    case "response.done":
      setStatus((current) => (current === "speaking" ? "listening" : current));
      break;
    case "error":
      // The server refused one event; the session goes on, and a dropped connection ends it on its own.
      note("note", `The realtime session refused an event: ${event.error?.message ?? "no reason given"}`);
      break;
    default:
      break;
    }
  }, [flush, note]);

  const start = useCallback(async () => {
    stop();
    const session = generation.current;
    setError(null);
    setEntries([]);
    queue.current = new VoiceTurnQueue();
    conversation.current!.reset();
    forwarding.current = Promise.resolve();
    setStatus("connecting");
    try {
      await signInAnonymously(auth);
      const mint = httpsCallable<string, string>(functions, `realtimeSession?studyId=${studyId}`);
      const grant = JSON.parse(
        (await mint(JSON.stringify({ model: DEFAULT_REALTIME_MODEL, instructions: VOICE_INSTRUCTIONS }))).data,
      ) as RealtimeSessionGrant;
      if (session !== generation.current) return;
      note("note", `Session ${grant.session.id} on ${grant.base_url}`);

      const peer = new RTCPeerConnection();
      connection.current = peer;
      peer.onconnectionstatechange = () => {
        // A disconnected call often recovers on its own; only a failed or closed one is over.
        if (["failed", "closed"].includes(peer.connectionState) && session === generation.current) {
          setError(`The call ${peer.connectionState}.`);
          stop("error");
        }
      };
      const audio = speaker.current ?? new Audio();
      audio.autoplay = true;
      speaker.current = audio;
      peer.ontrack = (track) => {
        audio.srcObject = track.streams[0];
      };
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Stopped while the permission prompt was up: the stream must not outlive the session it was asked for.
        if (session !== generation.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        microphone.current = stream;
        peer.addTrack(stream.getAudioTracks()[0], stream);
        setHasMicrophone(true);
      } catch {
        peer.addTransceiver("audio", { direction: "recvonly" });
        setHasMicrophone(false);
        note("note", "No microphone; type a turn below instead.");
      }
      const events = peer.createDataChannel("oai-events");
      channel.current = events;
      events.onmessage = (message) => handle(JSON.parse(message.data) as RealtimeEvent);
      events.onerror = (event) => console.error("realtime channel error", event);
      events.onopen = () => setStatus("listening");
      // The provider ends a session after an hour; the microphone must not stay open past that.
      events.onclose = () => {
        if (session === generation.current) stop();
      };

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (session !== generation.current) return;
      const answer = await fetch(realtimeCallsUrl(grant.base_url), {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${grant.value}`, "Content-Type": "application/sdp" },
      });
      if (!answer.ok) {
        throw new Error(`The realtime endpoint refused the call (${answer.status}).`);
      }
      if (session !== generation.current) return;
      await peer.setRemoteDescription({ type: "answer", sdp: await answer.text() });
    } catch (failure) {
      if (session !== generation.current) return;
      setError(failure instanceof Error ? failure.message : "Could not start the voice session.");
      stop("error");
    }
  }, [handle, note, stop]);

  const sendText = useCallback((text: string) => {
    const itemId = `msg_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
    queue.current!.transcriptCompleted(itemId, text);
    for (const event of textInputEvents(itemId, text)) send(event);
    setStatus("listening");
  }, [send]);

  useEffect(() => () => stop(), [stop]);

  // The microphone only listens on the participant's turn, so the assistant's own voice cannot start another one.
  useEffect(() => {
    microphone.current?.getAudioTracks().forEach((track) => {
      track.enabled = status === "listening";
    });
  }, [status]);

  return { status, entries, error, hasMicrophone, start, stop, sendText };
}
