import type { IncomingMessage, ServerResponse } from "node:http";

export type Handler = (ctx: { req: IncomingMessage; res: ServerResponse; params: string[]; body: any }) => unknown;
export type Route = [method: string, pattern: RegExp, handler: Handler];

// Returned by handlers that write the response themselves (SSE, audio).
export const STREAMING = Symbol("streaming");
