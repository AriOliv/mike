// RASCUNHO — backend/src/routes/feedback.ts. Não executado/compilado.
// POST /feedback — grava o feedback e abre uma issue no fork (GitHub App com
// issues:write). Em prévia (FEEDBACK_PR_NUMBER), comenta também no PR.
// Registrar em app.ts: app.use("/feedback", feedbackRouter) — só se
// process.env.FEEDBACK_ENABLED === "true".
import { Router } from "express";
import { z } from "zod";
import { createAppAuth } from "@octokit/auth-app"; // dependência nova
import { readFileSync } from "node:fs";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { checkProjectAccess } from "../lib/access";

export const feedbackRouter = Router();

const Body = z.object({
    kind: z.enum(["bug", "sugestao", "duvida", "elogio"]),
    message: z.string().trim().min(3).max(5000),
    route: z.string().max(500).optional(),
    project_id: z.string().uuid().optional(),
    viewport: z.string().max(40).optional(),
    screenshot_path: z.string().max(500).optional(),
});

const KIND_LABEL: Record<z.infer<typeof Body>["kind"], string> = {
    bug: "Bug",
    sugestao: "Sugestão",
    duvida: "Dúvida",
    elogio: "Elogio",
};

async function githubToken(): Promise<string | null> {
    const appId = process.env.FEEDBACK_GITHUB_APP_ID;
    const keyFile = process.env.FEEDBACK_GITHUB_APP_KEY_FILE;
    const installationId = process.env.FEEDBACK_GITHUB_INSTALLATION_ID;
    if (!appId || !keyFile || !installationId) return null;
    const auth = createAppAuth({
        appId,
        privateKey: readFileSync(keyFile, "utf8"),
        installationId: Number(installationId),
    });
    const { token } = await auth({ type: "installation" });
    return token;
}

async function gh(token: string, path: string, body: unknown) {
    const res = await fetch(`https://api.github.com${path}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`github ${path} ${res.status}`);
    return res.json() as Promise<{ html_url: string; number: number }>;
}

feedbackRouter.post("/", requireAuth, async (req, res) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ detail: "invalid feedback" });
    const fb = parsed.data;
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();

    // Só referencia o card se o usuário tem acesso a ele (não vaza id alheio na issue).
    let projectId: string | null = null;
    if (fb.project_id) {
        const access = await checkProjectAccess(fb.project_id, userId, userEmail, db);
        if (access.ok) projectId = fb.project_id;
    }

    const env = process.env.APP_ENV ?? "unknown";
    const sha = process.env.BUILD_SHA ?? "";
    const { data: row, error } = await db
        .from("feedback")
        .insert({
            user_id: userId,
            user_email: userEmail ?? null,
            kind: fb.kind,
            message: fb.message,
            route: fb.route ?? null,
            project_id: projectId,
            env_label: env,
            build_sha: sha,
            user_agent: req.get("user-agent")?.slice(0, 300) ?? null,
            viewport: fb.viewport ?? null,
            screenshot_path: fb.screenshot_path ?? null,
        })
        .select("id")
        .single();
    if (error || !row) return void res.status(500).json({ detail: "could not save feedback" });

    // Issue no GitHub: best-effort. Falha não perde o feedback (já está no banco).
    try {
        const token = await githubToken();
        const repo = process.env.FEEDBACK_GITHUB_REPO; // "AriOliv/mike"
        if (token && repo) {
            const title = `[${KIND_LABEL[fb.kind]}] ${fb.message.split("\n")[0].slice(0, 80)}`;
            const body = [
                fb.message,
                "",
                "---",
                `- Ambiente: \`${env}\` · build \`${sha.slice(0, 7)}\``,
                `- Tela: \`${fb.route ?? "?"}\`${projectId ? ` · card \`${projectId}\`` : ""}`,
                `- Quem: ${userEmail ?? userId}`,
                `- Feedback id: \`${row.id}\``,
            ].join("\n");
            const issue = await gh(token, `/repos/${repo}/issues`, {
                title,
                body,
                labels: ["feedback", `feedback:${fb.kind}`, `env:${env}`],
            });
            const pr = process.env.FEEDBACK_PR_NUMBER;
            if (pr) {
                await gh(token, `/repos/${repo}/issues/${pr}/comments`, {
                    body: `Feedback do Legal nesta prévia: ${issue.html_url}`,
                });
            }
            await db
                .from("feedback")
                .update({ github_issue_url: issue.html_url, github_issue_number: issue.number })
                .eq("id", row.id);
        }
    } catch (err) {
        console.warn("[feedback] github issue failed", (err as Error).message);
    }

    res.status(201).json({ id: row.id });
});
