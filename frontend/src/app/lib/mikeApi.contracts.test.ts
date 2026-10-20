// The fork's CLM endpoints (pipeline, acervo, terms, dossier, preview,
// radar). Kept apart from mikeApi.test.ts so upstream syncs never conflict on
// it; same harness: a stubbed fetch and assertions on route, method and body.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/lib/errorReporting", () => ({
    trackPendingRequest: () => () => {},
    markErrorHandled: vi.fn(),
    reportApiFailure: vi.fn(),
    reportNetworkFailure: vi.fn(),
}));

import {
    askAcervo,
    createObligation,
    deleteObligation,
    extractContractTerms,
    fetchAuthedObjectUrl,
    getContractTerms,
    getDocumentPreview,
    getCardActivity,
    assignRequest,
    createRequest,
    decideRequestTriage,
    deliverRequest,
    getRequest,
    getRequestRole,
    inviteRequestParticipant,
    listRequests,
    postRequestMessage,
    revokeRequestParticipant,
    getDossier,
    getIntegrationStatus,
    getObligations,
    getPipeline,
    updateObligation,
    updatePipelineCard,
} from "./mikeApi";

const fetchMock = vi.fn();

const jsonResponse = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
        ...init,
    });

const lastFetchCall = () => {
    const call = fetchMock.mock.calls.at(-1);
    if (!call) throw new Error("fetch was not called");
    return { url: call[0] as string, init: (call[1] ?? {}) as RequestInit };
};

const jsonBody = () => JSON.parse(lastFetchCall().init.body as string);

beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe("pipeline", () => {
    it("reads the board and the integration status", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ lanes: [], cards: [], by_lane: {} }));
        await getPipeline();
        expect(lastFetchCall().url).toMatch(/\/pipeline$/);

        fetchMock.mockResolvedValue(jsonResponse({ notion: { enabled: false } }));
        await getIntegrationStatus();
        expect(lastFetchCall().url).toMatch(/\/integrations\/status$/);
    });

    it("PATCHes a card's lane and task fields", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ id: "p1" }));
        await updatePipelineCard("p1", { lane: "revisao", status: "bloqueado" });
        const { url, init } = lastFetchCall();
        expect(url).toMatch(/\/pipeline\/p1$/);
        expect(init.method).toBe("PATCH");
        expect(jsonBody()).toEqual({ lane: "revisao", status: "bloqueado" });
    });
});

describe("acervo and contract analysis", () => {
    it("POSTs the question to the acervo", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ answer: "", found: false, sources: [], searched: 0 }));
        await askAcervo("foro?");
        expect(lastFetchCall().url).toMatch(/\/acervo$/);
        expect(lastFetchCall().init.method).toBe("POST");
        expect(jsonBody()).toEqual({ question: "foro?" });
    });

    it("reads and extracts a contract's terms", async () => {
        fetchMock.mockResolvedValue(jsonResponse(null));
        await expect(getContractTerms("p1")).resolves.toBeNull();
        expect(lastFetchCall().url).toMatch(/\/projects\/p1\/terms$/);

        fetchMock.mockResolvedValue(jsonResponse({ project_id: "p1" }));
        await extractContractTerms("p1");
        expect(lastFetchCall().url).toMatch(/\/projects\/p1\/terms\/extract$/);
        expect(lastFetchCall().init.method).toBe("POST");
    });

    it("reads a card's activity with a limit", async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));
        await expect(getCardActivity("p1")).resolves.toEqual([]);
        expect(lastFetchCall().url).toMatch(/\/projects\/p1\/activity\?limit=50$/);
        fetchMock.mockResolvedValue(jsonResponse([]));
        await getCardActivity("p1", 5);
        expect(lastFetchCall().url).toMatch(/limit=5$/);
    });

    it("reads a project's dossier", async () => {
        fetchMock.mockResolvedValue(jsonResponse(null));
        await expect(getDossier("p1")).resolves.toBeNull();
        expect(lastFetchCall().url).toMatch(/\/projects\/p1\/dossier$/);
    });

    it("prefixes the preview file URL with the API base, or returns null", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ document_id: "d1", filename: "c.pdf", inline: true, url: "/projects/p1/preview/file" }),
        );
        const preview = await getDocumentPreview("p1");
        expect(preview?.url).toMatch(/.+\/projects\/p1\/preview\/file$/);
        expect(preview?.url).not.toBe("/projects/p1/preview/file");

        fetchMock.mockResolvedValue(jsonResponse(null));
        await expect(getDocumentPreview("p1")).resolves.toBeNull();
    });

    it("turns a protected file into an object URL, and raises on failure", async () => {
        const createObjectURL = vi.fn(() => "blob:preview");
        vi.stubGlobal("URL", Object.assign(URL, { createObjectURL }));
        fetchMock.mockResolvedValue(new Response("pdf-bytes", { status: 200 }));
        await expect(fetchAuthedObjectUrl("/api/projects/p1/preview/file")).resolves.toBe("blob:preview");
        expect(lastFetchCall().init.cache).toBe("no-store");

        fetchMock.mockResolvedValue(jsonResponse({ detail: "nope" }, { status: 404 }));
        await expect(fetchAuthedObjectUrl("/api/projects/p1/preview/file")).rejects.toMatchObject({
            status: 404,
        });
    });
});

describe("radar", () => {
    it("lists obligations with only the filters given", async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));
        await getObligations();
        expect(lastFetchCall().url).toMatch(/\/obligations$/);

        fetchMock.mockResolvedValue(jsonResponse([]));
        await getObligations({ from: "2026-10-01", to: "2026-12-31", includeDone: true });
        const query = new URL(lastFetchCall().url, "http://x").searchParams;
        expect(Object.fromEntries(query)).toEqual({
            from: "2026-10-01",
            to: "2026-12-31",
            include_done: "true",
        });
    });

    it("creates, updates and deletes an obligation", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ id: "o1" }, { status: 201 }));
        await createObligation({ title: "Aviso", due_date: "2026-12-01" });
        expect(lastFetchCall().url).toMatch(/\/obligations$/);
        expect(lastFetchCall().init.method).toBe("POST");
        expect(jsonBody()).toEqual({ title: "Aviso", due_date: "2026-12-01" });

        fetchMock.mockResolvedValue(jsonResponse({ id: "o1" }));
        await updateObligation("o1", { done: true });
        expect(lastFetchCall().url).toMatch(/\/obligations\/o1$/);
        expect(lastFetchCall().init.method).toBe("PATCH");
        expect(jsonBody()).toEqual({ done: true });

        fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
        await deleteObligation("o1");
        expect(lastFetchCall().url).toMatch(/\/obligations\/o1$/);
        expect(lastFetchCall().init.method).toBe("DELETE");
    });
});

describe("requests to the legal team", () => {
    it("reads the caller's role, the queue, their own list and one request", async () => {
        fetchMock.mockImplementation(async () => jsonResponse({}));
        await getRequestRole();
        expect(lastFetchCall().url).toMatch(/\/requests\/me$/);
        await listRequests();
        expect(lastFetchCall().url).toMatch(/\/requests$/);
        await listRequests({ mine: true });
        expect(lastFetchCall().url).toMatch(/\/requests\?mine=1$/);
        await getRequest("r1");
        expect(lastFetchCall().url).toMatch(/\/requests\/r1$/);
    });

    it("POSTs a new request and each of the team's moves", async () => {
        fetchMock.mockImplementation(async () => jsonResponse({}));
        await createRequest({ kind: "nda", counterparty: "Polaris" });
        expect(lastFetchCall().url).toMatch(/\/requests$/);
        expect(lastFetchCall().init.method).toBe("POST");
        expect(jsonBody()).toEqual({ kind: "nda", counterparty: "Polaris" });

        await assignRequest("r1", "u2");
        expect(lastFetchCall().url).toMatch(/\/requests\/r1\/assign$/);
        expect(jsonBody()).toEqual({ assignee_id: "u2" });

        await decideRequestTriage("r1", { decision: "edited", kind: "parecer" });
        expect(lastFetchCall().url).toMatch(/\/requests\/r1\/triage$/);
        expect(jsonBody()).toEqual({ decision: "edited", kind: "parecer" });

        await postRequestMessage("r1", "Tem a minuta?", "question");
        expect(jsonBody()).toEqual({ body: "Tem a minuta?", kind: "question" });
        await postRequestMessage("r1", "Segue");
        expect(jsonBody()).toEqual({ body: "Segue", kind: "note" });
        expect(lastFetchCall().url).toMatch(/\/requests\/r1\/messages$/);

        await deliverRequest("r1", { message: "ok", document_ids: ["d1"] });
        expect(lastFetchCall().url).toMatch(/\/requests\/r1\/deliver$/);

        await inviteRequestParticipant("r1", { email: "x@y.z", label: "Escritório X" });
        expect(lastFetchCall().url).toMatch(/\/requests\/r1\/participants$/);
        expect(jsonBody()).toEqual({ email: "x@y.z", label: "Escritório X" });

        await revokeRequestParticipant("r1", "p1");
        expect(lastFetchCall().url).toMatch(/\/requests\/r1\/participants\/p1$/);
        expect(lastFetchCall().init.method).toBe("DELETE");
    });
});
