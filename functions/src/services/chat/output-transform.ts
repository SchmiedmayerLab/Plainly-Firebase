//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {Response, ResponseStreamEvent} from "openai/resources/responses/responses";

/**
 * Rewrites the model output produced under one intercepted request.
 *
 * A `ChatInterceptor` shapes the request, but what it asks the model to do — such as marking where
 * a claim came from — has to be undone again on the way back, before the client sees it. A
 * transform is created per request, because it carries that request's own state.
 */
export interface OutputTransform {
  /** Streaming: rewrite one upstream event into the events to forward, which may be none or several. */
  handleEvent(event: ResponseStreamEvent): ResponseStreamEvent[];
  /** Non-streaming: rewrite a completed response. */
  transformResponse(response: Response): Response;
}
