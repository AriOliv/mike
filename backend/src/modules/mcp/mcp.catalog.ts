// Every tool the server publishes, gathered from the facades of the modules
// that own them (doc 09 §5). Adding a module's tools is one line here.

import { CONTRACT_REVIEW_TOOLS } from "../contract-review/contractReview.service";
import { CONTRACT_TOOLS } from "../contracts/contracts.service";
import { DASHBOARD_TOOLS } from "../dashboard/dashboard.service";
import { REGULATORY_TOOLS } from "../regulatory/regulatory.service";
import { whoAmITool } from "./mcp.whoami";
import type { AnyMcpTool } from "./mcp.types";

let cached: readonly AnyMcpTool[] | null = null;

/** The phase 1 catalog: read tools only. */
export function readTools(): readonly AnyMcpTool[] {
    cached ??= [
        whoAmITool(() => readTools()),
        ...CONTRACT_REVIEW_TOOLS,
        ...CONTRACT_TOOLS,
        ...REGULATORY_TOOLS,
        ...DASHBOARD_TOOLS,
    ].filter(
        (t) => t.access === "read",
    );
    return cached;
}
