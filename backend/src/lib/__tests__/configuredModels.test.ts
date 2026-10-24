import { afterEach, describe, expect, it, vi } from "vitest";

import { completeWithProvider } from "../llm/providers";
import { getConfiguredModel, resetModelRegistryCache } from "../llm/registry";
import type { ConfiguredModel } from "../llm/types";

const originalConfig = process.env.MIKE_MODEL_CONFIG_JSON;

function configure(
    maxTokensField?: ConfiguredModel["maxTokensField"],
    extra: Record<string, unknown> = {},
) {
    process.env.MIKE_MODEL_CONFIG_JSON = JSON.stringify({
        models: [
            {
                id: "custom-model",
                provider: "openai-compatible",
                location: "cloud",
                apiModel: "upstream-model",
                baseUrl: "https://models.example.test/v1",
                ...(maxTokensField ? { maxTokensField } : {}),
                ...extra,
            },
        ],
    });
    resetModelRegistryCache();
}

function requestHeaders(fetchMock: ReturnType<typeof vi.fn>): Headers {
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    return new Headers(init.headers);
}

function completionResponse(): Response {
    return new Response(
        JSON.stringify({
            choices: [
                {
                    message: { role: "assistant", content: "Done" },
                    finish_reason: "stop",
                },
            ],
        }),
        {
            status: 200,
            headers: { "Content-Type": "application/json" },
        },
    );
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>) {
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("configured OpenAI-compatible models", () => {
    afterEach(() => {
        if (originalConfig === undefined) {
            delete process.env.MIKE_MODEL_CONFIG_JSON;
        } else {
            process.env.MIKE_MODEL_CONFIG_JSON = originalConfig;
        }
        resetModelRegistryCache();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it("uses max_tokens by default", async () => {
        configure();
        const fetchMock = vi.fn().mockResolvedValue(completionResponse());
        vi.stubGlobal("fetch", fetchMock);

        await completeWithProvider({
            model: "custom-model",
            user: "Complete this",
            maxTokens: 321,
        });

        expect(requestBody(fetchMock)).toMatchObject({
            model: "upstream-model",
            max_tokens: 321,
        });
        expect(requestBody(fetchMock)).not.toHaveProperty(
            "max_completion_tokens",
        );
    });

    it("can send max_completion_tokens instead", async () => {
        configure("max_completion_tokens");
        const fetchMock = vi.fn().mockResolvedValue(completionResponse());
        vi.stubGlobal("fetch", fetchMock);

        await completeWithProvider({
            model: "custom-model",
            user: "Complete this",
            maxTokens: 321,
        });

        expect(requestBody(fetchMock)).toMatchObject({
            model: "upstream-model",
            max_completion_tokens: 321,
        });
        expect(requestBody(fetchMock)).not.toHaveProperty("max_tokens");
    });

    it("sends the declared headers on every call (LiteLLM redaction)", async () => {
        configure(undefined, {
            headers: { "x-litellm-enable-message-redaction": "true" },
        });
        const fetchMock = vi.fn().mockResolvedValue(completionResponse());
        vi.stubGlobal("fetch", fetchMock);

        await completeWithProvider({ model: "custom-model", user: "Complete this" });

        expect(
            requestHeaders(fetchMock).get("x-litellm-enable-message-redaction"),
        ).toBe("true");
    });

    it("sends no extra header when none is declared", async () => {
        configure();
        const fetchMock = vi.fn().mockResolvedValue(completionResponse());
        vi.stubGlobal("fetch", fetchMock);

        await completeWithProvider({ model: "custom-model", user: "Complete this" });

        expect(
            requestHeaders(fetchMock).has("x-litellm-enable-message-redaction"),
        ).toBe(false);
    });

    it.each([
        ["an auth header", { Authorization: "Bearer x" }],
        ["a header injection", { "x-a": "1\r\nx-b: 2" }],
        ["a non-string value", { "x-a": true }],
        ["a list", ["x-a"]],
    ])("drops a model whose headers carry %s", (_label, headers) => {
        configure(undefined, { headers });
        expect(getConfiguredModel("custom-model")).toBeNull();
    });
});
