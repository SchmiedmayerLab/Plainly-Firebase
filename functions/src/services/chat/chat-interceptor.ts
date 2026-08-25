//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {ResponseBody} from "./chat-service";
import {OutputTransform} from "./output-transform";

/** A request on its way to the underlying ChatService, with whatever the answer will need. */
export interface InterceptedRequest {
  body: ResponseBody;
  /**
   * Undoes on the response whatever the request asked the model to do.
   *
   * Omitted by an interceptor that only shapes the request.
   */
  outputTransform?: OutputTransform;
}

/** Transforms a Responses API body before it reaches the underlying ChatService. */
export interface ChatInterceptor {
  intercept(body: ResponseBody): Promise<InterceptedRequest>;
}
