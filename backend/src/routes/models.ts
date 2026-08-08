import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { authHeaders } from "../lib/llm/ollama";
import { customBaseUrl, customAuthHeaders } from "../lib/llm/custom";

export const modelsRouter = Router();

// Live list of locally installed Ollama models, shaped like the frontend's
// ModelOption. Returns [] when Ollama is unreachable so the app still works.
modelsRouter.get("/ollama", requireAuth, async (_req, res) => {
    const base = (
        process.env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434/v1"
    ).replace(/\/$/, "");
    try {
        const r = await fetch(`${base}/models`, { headers: authHeaders() });
        if (!r.ok) return void res.json({ models: [] });
        const data = (await r.json()) as { data?: { id: string }[] };
        const models = (data.data ?? []).map((m) => ({
            id: `ollama/${m.id}`,
            label: `${m.id} (local)`,
            group: "Local",
        }));
        res.json({ models });
    } catch {
        res.json({ models: [] });
    }
});

// Live list of models from the configured remote OpenAI-compatible endpoint,
// shaped like the frontend's ModelOption. Returns [] when no endpoint is
// configured or it is unreachable, so the app still works.
modelsRouter.get("/custom", requireAuth, async (_req, res) => {
    const base = customBaseUrl();
    if (!base) return void res.json({ models: [] });
    try {
        const r = await fetch(`${base}/models`, { headers: customAuthHeaders() });
        if (!r.ok) return void res.json({ models: [] });
        const data = (await r.json()) as { data?: { id: string }[] };
        const models = (data.data ?? []).map((m) => ({
            id: `custom/${m.id}`,
            label: m.id,
            group: "Custom",
        }));
        res.json({ models });
    } catch {
        res.json({ models: [] });
    }
});
