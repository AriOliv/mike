// Outbound calls to a few named public hosts through an egress proxy that
// filters by host name (staging cannot allow these hosts by IP). Used only by
// integrations that opt in with their own allowlist; guardedFetch (the
// anti-SSRF path for user-supplied URLs) is untouched and still serves every
// other call.
//
// The proxy is chosen per integration: `<NAME>_EGRESS_PROXY_URL`, else the
// shared `EGRESS_PROXY_URL`. With neither set the integration keeps its
// direct path. With one set, a host outside the integration's allowlist is
// refused before anything leaves the process; the proxy's own allowlist is
// the second lock on the final destination.

import { fetch as undiciFetch, ProxyAgent } from "undici";

export class EgressHostNotAllowedError extends Error {
    readonly code = "ERR_EGRESS_HOST_NOT_ALLOWED";
    constructor(host: string) {
        super(`Egress to ${host} is not allowed for this integration.`);
        this.name = "EgressHostNotAllowedError";
    }
}

/** The proxy URL for an integration, or null when it should go direct. */
export function egressProxyFor(envName: string, env: NodeJS.ProcessEnv = process.env): string | null {
    const raw = env[envName]?.trim() || env.EGRESS_PROXY_URL?.trim();
    if (!raw) return null;
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Egress proxy URL must be http(s).");
    return raw;
}

const agents = new Map<string, ProxyAgent>();
function agentFor(proxyUrl: string): ProxyAgent {
    let agent = agents.get(proxyUrl);
    if (!agent) agents.set(proxyUrl, (agent = new ProxyAgent(proxyUrl)));
    return agent;
}

/**
 * GET through the proxy, https only, exact host from `allowedHosts`, no
 * redirects followed (a redirect is a second destination nobody listed).
 */
export async function proxiedFetch(
    url: string,
    init: { headers?: Record<string, string>; signal?: AbortSignal },
    options: { proxyUrl: string; allowedHosts: readonly string[] },
): Promise<Response> {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.username || target.password || !options.allowedHosts.includes(target.hostname.toLowerCase())) {
        throw new EgressHostNotAllowedError(target.hostname);
    }
    return (await undiciFetch(target, {
        ...init,
        method: "GET",
        redirect: "manual",
        dispatcher: agentFor(options.proxyUrl),
    })) as unknown as Response;
}
