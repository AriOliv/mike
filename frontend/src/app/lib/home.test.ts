import { describe, expect, it } from "vitest";
import {
    brDate,
    contracts,
    filterReviews,
    greeting,
    isMine,
    noticeHint,
    personName,
    pickContracts,
    reviewChip,
    summarySentences,
    whenLabel,
} from "./home";
import type { HomeReview } from "./mikeApi";

const TODAY = new Date(2026, 9, 20);

function review(overrides: Partial<HomeReview>): HomeReview {
    return {
        id: "r",
        project_id: "p",
        project_name: "Contrato",
        counterparty: null,
        lane: null,
        document_id: "d",
        filename: null,
        status: "ready",
        step: null,
        aligned: 0,
        needs_review: 0,
        deviates: 0,
        summary: null,
        error: null,
        assignee_email: null,
        playbook_id: null,
        playbook_run_id: null,
        watched_folder_id: null,
        requester_name: null,
        deadline: null,
        notice_deadline: null,
        notice_days: null,
        term_end: null,
        ficha: null,
        suggested_assignee: null,
        updated_at: "2026-10-20T10:00:00Z",
        ...overrides,
    };
}

const g = (reviewed: number, failed = 0, notices_closing = 0, ready = 0) => ({
    reviewed,
    failed,
    notices_closing,
    ready,
});

describe("greeting", () => {
    it("teaches the next step when nothing was reviewed yet", () => {
        expect(greeting({ since: null, greeting: g(0), reviews: [] })).toEqual({
            lead: "Ainda não revisei nenhum contrato.",
            detail: expect.stringContaining("Envie contratos"),
        });
    });

    it("counts what is new since the last visit, with what needs the person", () => {
        expect(greeting({ since: "x", greeting: g(10, 1, 2, 3), reviews: [review({})] })).toEqual({
            lead: "Revisei 10 contratos para você desde sua última visita.",
            detail: "2 avisos prévios fecham em até 30 dias, 3 contratos esperam sua revisão, 1 falhou e precisa de outra tentativa.",
        });
        expect(greeting({ since: null, greeting: g(1, 2, 1, 1), reviews: [review({})] })).toEqual({
            lead: "Revisei 1 contrato para você até agora.",
            detail: "1 aviso prévio fecha em até 30 dias, 1 contrato espera sua revisão, 2 falharam e precisam de outra tentativa.",
        });
    });

    it("says nothing is new, with or without pending work", () => {
        expect(greeting({ since: "x", greeting: g(0), reviews: [review({})] })).toEqual({
            lead: "Nada novo desde sua última visita.",
            detail: null,
        });
        expect(greeting({ since: "x", greeting: g(0, 0, 0, 2), reviews: [review({})] }).detail).toBe(
            "2 contratos esperam sua revisão.",
        );
    });

    it("pluralizes contracts", () => {
        expect(contracts(1)).toBe("1 contrato");
        expect(contracts(0)).toBe("0 contratos");
    });
});

describe("reviewChip", () => {
    it("shows the agent's step while it works, and every other state", () => {
        expect(reviewChip({ status: "queued", step: null })).toEqual({ status: "a_fazer", label: "Na fila" });
        expect(reviewChip({ status: "running", step: "ficha" })).toEqual({
            status: "rodando",
            label: "Preenchendo a Ficha…",
        });
        expect(reviewChip({ status: "running", step: "playbook" }).label).toBe("Comparando com o playbook…");
        expect(reviewChip({ status: "running", step: null }).label).toBe("Lendo o contrato…");
        expect(reviewChip({ status: "ready", step: null })).toEqual({ status: "pronto" });
        expect(reviewChip({ status: "done", step: null })).toEqual({ status: "concluido", label: "Revisado" });
        expect(reviewChip({ status: "failed", step: null })).toEqual({ status: "erro" });
    });
});

describe("filterReviews", () => {
    const rows = [
        review({ id: "done", status: "done", assignee_email: "duda@x.com", updated_at: "2026-10-20T12:00:00Z" }),
        review({ id: "ready-old", status: "ready", updated_at: "2026-10-18T00:00:00Z", watched_folder_id: "f1" }),
        review({
            id: "ready-new",
            status: "ready",
            assignee_email: "duda@x.com",
            notice_deadline: "2026-11-01",
            filename: "NDA Polaris.docx",
        }),
        review({ id: "running", status: "running", notice_deadline: "2027-06-01", counterparty: "Trópico" }),
        review({ id: "failed", status: "failed", notice_deadline: "2026-01-01" }),
        review({ id: "queued", status: "queued" }),
    ];
    const ids = (opts: Parameters<typeof filterReviews>[1]) => filterReviews(rows, opts, TODAY).map((r) => r.id);

    it("puts ready first, then running, queued, failed and done, newest first", () => {
        expect(ids({ tab: "todas", filter: null, me: null })).toEqual([
            "ready-new",
            "ready-old",
            "running",
            "queued",
            "failed",
            "done",
        ]);
    });

    it("keeps only mine on the Minhas tab, and nothing without an identity", () => {
        expect(ids({ tab: "minhas", filter: null, me: "Duda@X.com" })).toEqual(["ready-new", "done"]);
        expect(ids({ tab: "minhas", filter: null, me: null })).toEqual([]);
    });

    it("applies each counter filter", () => {
        expect(ids({ tab: "todas", filter: "prontos", me: null })).toEqual(["ready-new", "ready-old"]);
        expect(ids({ tab: "todas", filter: "meus", me: "duda@x.com" })).toEqual(["ready-new"]);
        expect(ids({ tab: "todas", filter: "meus", me: null })).toEqual([]);
        expect(ids({ tab: "todas", filter: "avisos", me: null })).toEqual(["ready-new"]);
        expect(ids({ tab: "todas", filter: "pastas", me: null })).toEqual(["ready-old"]);
    });

    it("searches file, card, counterparty and person", () => {
        expect(ids({ tab: "todas", filter: null, me: null, query: "polaris" })).toEqual(["ready-new"]);
        expect(ids({ tab: "todas", filter: null, me: null, query: "TRÓPICO" })).toEqual(["running"]);
        expect(ids({ tab: "todas", filter: null, me: null, query: "  " })).toHaveLength(6);
    });

    it("defaults today to the clock", () => {
        expect(filterReviews(rows, { tab: "todas", filter: null, me: null })).toHaveLength(6);
    });
});

describe("formatting", () => {
    it("formats dates and people", () => {
        expect(brDate("2026-10-20T10:00:00Z")).toBe("20/10/2026");
        expect(personName("duda@avenia.io")).toBe("duda");
        expect(personName(null)).toBeNull();
    });
});

describe("greeting without new reviews", () => {
    it("says what is running now, teaches on a first visit, and otherwise reports nothing new", () => {
        const running = [review({ status: "running" }), review({ id: "q", status: "queued" })];
        expect(greeting({ since: "x", greeting: g(0), reviews: running }).lead).toBe("Estou revisando 2 contratos agora.");
        expect(greeting({ since: null, greeting: g(0), reviews: [review({})] }).lead).toBe(
            "Conecte uma pasta ou envie contratos e eu reviso cada um.",
        );
    });
});

describe("noticeHint and whenLabel", () => {
    const deadline = (days_left: number) => ({
        project_id: "p",
        project_name: "x",
        counterparty: null,
        notice_deadline: "2026-11-01",
        notice_days: null,
        term_end: null,
        auto_renewal: null,
        days_left,
    });
    const counters = (n: number) => ({ ready: 0, mine: 0, notices_30d: n, folders: 0 });

    it("names the nearest deadline only when one closes within 30 days", () => {
        expect(noticeHint({ counters: counters(1), deadlines: [deadline(0)] })).toBe("o mais próximo hoje");
        expect(noticeHint({ counters: counters(1), deadlines: [deadline(1)] })).toBe("o mais próximo amanhã");
        expect(noticeHint({ counters: counters(2), deadlines: [deadline(12)] })).toBe("o mais próximo em 12 dias");
        expect(noticeHint({ counters: counters(0), deadlines: [deadline(60)] })).toBeUndefined();
        expect(noticeHint({ counters: counters(1), deadlines: [] })).toBeUndefined();
        expect(whenLabel(-1)).toBe("hoje");
    });
});

describe("isMine and summarySentences", () => {
    it("compares e-mails without case", () => {
        expect(isMine({ assignee_email: "Duda@X.com" }, "duda@x.COM")).toBe(true);
        expect(isMine({ assignee_email: null }, "duda@x.com")).toBe(false);
        expect(isMine({ assignee_email: "duda@x.com" }, null)).toBe(false);
    });

    it("splits a summary into sentences and finds the clause each cites", () => {
        expect(
            summarySentences(
                "Vigência perpétua (cl. 9). Foro em Manaus, Cláusula 12.1! Sem citação aqui",
            ),
        ).toEqual([
            { text: "Vigência perpétua (cl. 9).", clause: "9" },
            { text: "Foro em Manaus, Cláusula 12.1!", clause: "12.1" },
            { text: "Sem citação aqui", clause: null },
        ]);
        expect(summarySentences("   ")).toEqual([]);
        expect(summarySentences("")).toEqual([]);
    });
});

describe("pickContracts", () => {
    it("keeps PDF and DOCX within the limits and says why the rest was left out", () => {
        const many = Array.from({ length: 21 }, (_, i) => ({ name: `c${i}.pdf`, size: 10 }));
        const result = pickContracts([
            { name: "Contrato.DOCX", size: 10 },
            { name: "antigo.doc", size: 10 },
            { name: "grande.pdf", size: 26 * 1024 * 1024 },
            ...many,
        ]);
        expect(result.accepted).toHaveLength(20);
        expect(result.accepted[0]).toBe(0);
        expect(result.rejected).toEqual([
            "antigo.doc: só PDF ou DOCX",
            "grande.pdf: maior que 25 MB",
            "c19.pdf: até 20 arquivos por envio",
            "c20.pdf: até 20 arquivos por envio",
        ]);
    });
});
