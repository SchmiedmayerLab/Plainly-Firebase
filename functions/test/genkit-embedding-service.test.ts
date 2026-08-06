//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {Genkit} from "genkit";
import {GenkitEmbeddingService} from "../src/services/embedding/genkit-embedding-service";

describe("GenkitEmbeddingService", () => {
  it("preserves result order while limiting provider concurrency", async () => {
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const ai = {
      embed: async ({content}: {content: string}) => {
        activeRequests += 1;
        maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
        await new Promise<void>((resolve) => setImmediate(resolve));
        activeRequests -= 1;
        return [{embedding: [Number(content)]}];
      },
    } as unknown as Genkit;
    const service = new GenkitEmbeddingService(ai);

    const result = await service.embedBatch(["1", "2", "3", "4", "5", "6", "7"]);

    assert.deepEqual(result, [[1], [2], [3], [4], [5], [6], [7]]);
    assert.equal(maximumActiveRequests, 5);
  });
});
