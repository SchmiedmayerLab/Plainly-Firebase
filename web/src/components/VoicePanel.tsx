//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import { useState } from "react";
import { useVoice, type VoiceEntry } from "../hooks/useVoice";

const entryStyles: Record<VoiceEntry["kind"], { label: string; className: string }> = {
  user: { label: "Participant", className: "bg-blue-100 text-blue-900" },
  call: { label: "Tool call", className: "bg-yellow-50 text-yellow-900 text-xs font-mono" },
  answer: { label: "Plainly", className: "bg-green-100 text-green-900" },
  assistant: { label: "Spoken", className: "bg-purple-50 text-purple-900 italic" },
  note: { label: "Note", className: "bg-gray-100 text-gray-700 text-xs" },
};

export function VoicePanel() {
  const voice = useVoice();
  const [draft, setDraft] = useState("");
  const active = voice.status !== "idle" && voice.status !== "error";
  // Typing needs an open session; while it connects there is nothing to send the turn to yet.
  const canType = voice.status === "listening" || voice.status === "forwarding" || voice.status === "speaking";

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.trim()) return;
    voice.sendText(draft.trim());
    setDraft("");
  };

  return (
    <div className="border border-purple-200 rounded-lg p-4 flex flex-col bg-purple-50/10">
      <div className="border-b pb-2 mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Voice</h2>
          <span className="text-sm px-2 py-1 rounded inline-block bg-purple-100 text-purple-800">
            {voice.status}
          </span>
        </div>
        <button
          type="button"
          onClick={() => (active ? voice.stop() : void voice.start())}
          className={`px-4 py-2 rounded text-white ${active ? "bg-red-600 hover:bg-red-700" : "bg-purple-600 hover:bg-purple-700"}`}
        >
          {active ? "Stop" : "Start voice session"}
        </button>
      </div>

      {voice.error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded p-2 mb-3 text-sm">{voice.error}</div>
      )}

      <div className="flex-1 overflow-y-auto space-y-2 min-h-0 max-h-72 mb-3">
        {voice.entries.map((entry) => {
          const style = entryStyles[entry.kind];
          return (
            <div key={entry.id} className={`p-2 rounded ${style.className}`}>
              <div className="font-semibold text-xs mb-1">{style.label}</div>
              <div className="text-sm whitespace-pre-wrap">{entry.content}</div>
            </div>
          );
        })}
      </div>

      <form onSubmit={submit} className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={voice.hasMicrophone ? "Or type a turn instead of speaking" : "Type a turn"}
          className="flex-1 px-3 py-2 border border-gray-300 rounded text-sm"
          disabled={!canType}
        />
        <button
          type="submit"
          disabled={!canType || !draft.trim()}
          className="px-4 py-2 bg-purple-600 text-white rounded disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </div>
  );
}
