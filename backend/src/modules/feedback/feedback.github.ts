// The GitHub side of the feedback outbox (doc 13 §3): an installation token
// from the GitHub App, the issue in the PRIVATE feedback repo, and the card in
// the team's project. Only api.github.com is called, through the egress proxy
// when one is set. The App is installed on the feedback repo only, so a wrong
// repo name cannot publish a report anywhere public; the repo is also checked
// to be private before the first issue.

import { createPrivateKey, createSign } from "node:crypto";
import { egressProxyFor, proxiedFetch } from "../../lib/egressProxy";
import { guardedFetch } from "../../lib/mcp/client";

export const GITHUB_HOSTS = ["api.github.com"] as const;
const API = "https://api.github.com";
const TIMEOUT_MS = 10_000;

export type GithubConfig = { appId: string; installationId: string; privateKey: string; repo: string; project: number | null };

export function githubConfig(env: NodeJS.ProcessEnv = process.env): GithubConfig | null {
    const appId = env.GITHUB_APP_ID?.trim();
    const installationId = env.GITHUB_APP_INSTALLATION_ID?.trim();
    const privateKey = env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
    const repo = env.GITHUB_FEEDBACK_REPO?.trim();
    if (!appId || !installationId || !privateKey || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
    const project = Number(env.GITHUB_FEEDBACK_PROJECT);
    return { appId, installationId, privateKey, repo, project: Number.isInteger(project) && project > 0 ? project : null };
}

const b64 = (v: Buffer | string) => Buffer.from(v).toString("base64url");

/** The App's own JWT (RS256, 9 minutes), used only to ask for an installation token. */
export function appJwt(cfg: Pick<GithubConfig, "appId" | "privateKey">, now = Date.now()): string {
    const head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const iat = Math.floor(now / 1000) - 30;
    const claims = b64(JSON.stringify({ iat, exp: iat + 9 * 60, iss: cfg.appId }));
    const sig = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(createPrivateKey(cfg.privateKey));
    return `${head}.${claims}.${b64(sig)}`;
}

export type GithubCall = (method: "GET" | "POST" | "PATCH", path: string, token: string, body?: unknown) => Promise<{ status: number; json: unknown }>;

/** The one outbound call: the proxy when set, else the guarded direct path. */
export const githubCall: GithubCall = async (method, path, token, body) => {
    const init = {
        method,
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "mike-feedback",
            ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    };
    const proxyUrl = egressProxyFor("GITHUB_EGRESS_PROXY_URL");
    const res = proxyUrl
        ? await proxiedFetch(`${API}${path}`, init, { proxyUrl, allowedHosts: GITHUB_HOSTS })
        : await guardedFetch(`${API}${path}`, init, { label: "GitHub API URL" });
    const text = await res.text();
    let json: unknown = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        json = null;
    }
    return { status: res.status, json };
};

let cached: { token: string; expires: number } | null = null;
let repoChecked: string | null = null;

export async function installationToken(cfg: GithubConfig, call: GithubCall = githubCall, now = Date.now()): Promise<string> {
    if (cached && cached.expires - now > 5 * 60_000) return cached.token;
    const r = await call("POST", `/app/installations/${cfg.installationId}/access_tokens`, appJwt(cfg, now));
    const j = r.json as { token?: string; expires_at?: string } | null;
    if (r.status !== 201 || !j?.token) throw new Error(`github token ${r.status}`);
    cached = { token: j.token, expires: j.expires_at ? Date.parse(j.expires_at) : now + 50 * 60_000 };
    return cached.token;
}

export function resetGithubCache() {
    cached = null;
    repoChecked = null;
}

export type IssueInput = { title: string; body: string; labels: string[] };
export type CreatedIssue = { number: number; nodeId: string };

/** Refuses to run against a repo that is not private. Throws a non-retryable-looking error name. */
async function assertPrivate(cfg: GithubConfig, token: string, call: GithubCall) {
    if (repoChecked === cfg.repo) return;
    const r = await call("GET", `/repos/${cfg.repo}`, token);
    const j = r.json as { private?: boolean } | null;
    if (r.status !== 200 || j?.private !== true) {
        const e = new Error("feedback repo is not private or not reachable");
        e.name = "FeedbackRepoNotPrivate";
        throw e;
    }
    repoChecked = cfg.repo;
}

export async function createIssue(cfg: GithubConfig, input: IssueInput, call: GithubCall = githubCall): Promise<CreatedIssue> {
    const token = await installationToken(cfg, call);
    await assertPrivate(cfg, token, call);
    const r = await call("POST", `/repos/${cfg.repo}/issues`, token, input);
    const j = r.json as { number?: number; node_id?: string } | null;
    if (r.status !== 201 || !j?.number || !j.node_id) throw new Error(`github issue ${r.status}`);
    return { number: j.number, nodeId: j.node_id };
}

/** Adds the issue to the org project (GraphQL). Best-effort: the issue is already filed. */
export async function addToProject(cfg: GithubConfig, issueNodeId: string, call: GithubCall = githubCall): Promise<boolean> {
    if (!cfg.project) return false;
    const token = await installationToken(cfg, call);
    const [org] = cfg.repo.split("/");
    const q = await call("POST", "/graphql", token, {
        query: "query($org:String!,$n:Int!){organization(login:$org){projectV2(number:$n){id}}}",
        variables: { org, n: cfg.project },
    });
    const projectId = (q.json as { data?: { organization?: { projectV2?: { id?: string } } } } | null)?.data?.organization?.projectV2?.id;
    if (!projectId) return false;
    const m = await call("POST", "/graphql", token, {
        query: "mutation($p:ID!,$c:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$c}){item{id}}}",
        variables: { p: projectId, c: issueNodeId },
    });
    return m.status === 200 && !(m.json as { errors?: unknown } | null)?.errors;
}
