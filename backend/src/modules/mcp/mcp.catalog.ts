// Every tool the server publishes, gathered from the facades of the modules
// that own them (doc 09 §5). Adding a module's tools is one line here.

import { REQUEST_TOOLS } from "../requests/requests.service";
import { whoAmITool } from "./mcp.whoami";
import type { AnyMcpTool } from "./mcp.types";

let cached: readonly AnyMcpTool[] | null = null;

/** The phase 1 catalog: read tools only. */
export function readTools(): readonly AnyMcpTool[] {
    cached ??= [whoAmITool(() => readTools()), ...REQUEST_TOOLS].filter((t) => t.access === "read");
    return cached;
}
