// Service-account auth for the Google APIs this app talks to (Drive, Calendar).
//
// A signed JWT exchanged for an access token, done with node's crypto rather
// than pulling in the Google SDK for a handful of REST calls. Tokens are cached
// per scope, since each API asks for its own.
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

export const SCOPES = {
    drive: "https://www.googleapis.com/auth/drive",
    calendar: "https://www.googleapis.com/auth/calendar",
} as const;

type ServiceAccount = { client_email: string; private_key: string };

let cachedKey: ServiceAccount | null = null;
const tokens = new Map<string, { value: string; expiresAt: number }>();

export function serviceAccountConfigured(): boolean {
    return !!process.env.GOOGLE_SERVICE_ACCOUNT_FILE?.trim();
}

export function serviceAccount(): ServiceAccount {
    if (cachedKey) return cachedKey;
    const path = process.env.GOOGLE_SERVICE_ACCOUNT_FILE!.trim();
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ServiceAccount;
    if (!parsed.client_email || !parsed.private_key) {
        throw new Error("service account file is missing client_email/private_key");
    }
    cachedKey = parsed;
    return parsed;
}

const b64url = (input: Buffer | string) =>
    Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function googleAccessToken(scope: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const cached = tokens.get(scope);
    if (cached && cached.expiresAt - 60 > now) return cached.value;

    const { client_email, private_key } = serviceAccount();
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(
        JSON.stringify({ iss: client_email, scope, aud: TOKEN_URL, iat: now, exp: now + 3600 }),
    );
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    const assertion = `${header}.${claims}.${b64url(signer.sign(private_key))}`;

    const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion,
        }),
    });
    if (!response.ok) {
        throw new Error(
            `google token: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`,
        );
    }
    const json = (await response.json()) as { access_token: string; expires_in: number };
    tokens.set(scope, { value: json.access_token, expiresAt: now + json.expires_in });
    return json.access_token;
}

/** Authenticated JSON request against a Google API. */
export async function googleApi(
    scope: string,
    url: string,
    init: RequestInit = {},
): Promise<Record<string, unknown>> {
    const token = await googleAccessToken(scope);
    const response = await fetch(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
        throw new Error(
            `google ${init.method ?? "GET"} ${url}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`,
        );
    }
    return response.status === 204 ? {} : ((await response.json()) as Record<string, unknown>);
}
