// Every tool the server publishes, gathered from the facades of the modules
// that own them (doc 09 §5). Adding a module's tools is one line here.

import { whoAmITool } from "./mcp.whoami";
import type { AnyMcpTool } from "./mcp.types";

let cached: readonly AnyMcpTool[] | null = null;

/** The phase 1 catalog: read tools only. */
export function readTools(): readonly AnyMcpTool[] {
    cached ??= [whoAmITool(() => readTools())].filter((t) => t.access === "read");
    return cached;
}
