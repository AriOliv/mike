// Every tool the server publishes, gathered from the facades of the modules
// that own them (doc 09 §5). Adding a module's tools is one line here.

import { CNPJ_TOOLS } from "../cnpj/cnpj.service";
import { CONTRACT_REVIEW_TOOLS } from "../contract-review/contractReview.service";
import { CONTRACT_TOOLS } from "../contracts/contracts.service";
import { DASHBOARD_TOOLS } from "../dashboard/dashboard.service";
import { AGENT_TOOLS } from "../legal-agent/legalAgent.service";
import { REGULATORY_TOOLS } from "../regulatory/regulatory.service";
import { TABULAR_TOOLS } from "../tabular/tabular.service";
import { whoAmITool } from "./mcp.whoami";
import type { AnyMcpTool } from "./mcp.types";

/**
 * Writes the server offers, by name. A module may export write tools (with
 * their confirm.preview) before they are switched on here; each one enters
 * the catalog deliberately, in its own reviewed change (doc 09 §6).
 */
export const WRITE_TOOLS_ENABLED: ReadonlySet<string> = new Set<string>([]);

let cached: readonly AnyMcpTool[] | null = null;

/** Every tool the server publishes: the reads, and the writes switched on above. */
export function catalogTools(): readonly AnyMcpTool[] {
    cached ??= [
        whoAmITool(() => catalogTools()),
        ...CONTRACT_REVIEW_TOOLS,
        ...CONTRACT_TOOLS,
        ...CNPJ_TOOLS,
        ...REGULATORY_TOOLS,
        ...TABULAR_TOOLS,
        ...DASHBOARD_TOOLS,
        // Structural fit to McpTool (the legal-agent module declares its own context subset).
        ...(AGENT_TOOLS as unknown as AnyMcpTool[]),
    ].filter((t) => t.access === "read" || (WRITE_TOOLS_ENABLED.has(t.name) && !!t.confirm));
    return cached;
}
