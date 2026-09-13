//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {randomUUID} from "node:crypto";
import {ClientSecretCreateResponse} from "openai/resources/realtime/client-secrets";
import {RealtimeClientSecrets} from "./realtime-session-minter";

/** Mints a secret nothing accepts, so the emulator can exercise the callable without a provider. */
export function createMockRealtimeClientSecrets(now: () => number = Date.now): RealtimeClientSecrets {
  return {
    create: async (body) => ({
      value: `ek_mock_${randomUUID()}`,
      expires_at: Math.floor(now() / 1000) + (body.expires_after?.seconds ?? 600),
      session: {
        id: `sess_mock_${randomUUID()}`,
        object: "realtime.session",
        ...body.session,
        type: "realtime",
      } as ClientSecretCreateResponse["session"],
    }),
  };
}
