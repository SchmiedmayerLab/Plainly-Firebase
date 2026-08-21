//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {ResponseBody} from "./chat-service";

/** Transforms a Responses API body before it reaches the underlying ChatService. */
export interface ChatInterceptor {
  intercept(body: ResponseBody): Promise<ResponseBody>;
}
