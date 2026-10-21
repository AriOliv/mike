import { describe, expect, it } from "vitest";
import { NAV_MAIN, NAV_MORE, isNavItemActive, navForRole } from "./navItems";

describe("navItems", () => {
    it("lists the Legal workstation first, in Portuguese", () => {
        expect(NAV_MAIN.map((item) => item.label)).toEqual([
            "Esteira",
            "Contratos",
            "Prazos",
            "Perguntar",
        ]);
    });

    it("keeps the platform's other tools under Mais", () => {
        expect(NAV_MORE.map((item) => item.label)).toEqual([
            "Playbooks",
            "Biblioteca",
            "Workflows",
            "Projetos",
            "Assistente",
        ]);
    });

    it("keeps the generic grid and the IDE out of the Legal's menu", () => {
        const hrefs = [...NAV_MAIN, ...NAV_MORE].map((item) => item.href);
        expect(hrefs).not.toContain("/tabular-reviews");
        expect(hrefs).not.toContain("/ide");
    });

    it("never lists a route twice", () => {
        const hrefs = [...NAV_MAIN, ...NAV_MORE].map((item) => item.href);
        expect(new Set(hrefs).size).toBe(hrefs.length);
    });

    it("marks an item active on its page and the pages under it", () => {
        const esteira = NAV_MAIN[0];
        expect(isNavItemActive(esteira, "/pipeline")).toBe(true);
        expect(isNavItemActive(esteira, "/pipeline/abc")).toBe(true);
        expect(isNavItemActive(esteira, "/pipeline-old")).toBe(false);
    });

    it("marks an exact item active only on its own path", () => {
        const projetos = NAV_MORE.find((item) => item.href === "/projects")!;
        expect(isNavItemActive(projetos, "/projects")).toBe(true);
        expect(isNavItemActive(projetos, "/projects/1/review")).toBe(false);
    });

    it("gives the Legal team, and an unknown role, the whole menu", () => {
        for (const role of ["head", "team", null] as const) {
            expect(navForRole(role)).toEqual({ main: NAV_MAIN, more: NAV_MORE, workLists: true });
        }
    });

    it("shows someone who only asks the Legal team just Início and Pedidos", () => {
        const nav = navForRole("requester");
        expect(nav.main.every((item) => ["/inicio", "/pedidos"].includes(item.href))).toBe(true);
        expect(nav.main.map((item) => item.href)).not.toContain("/pipeline");
        expect(nav.more).toEqual([]);
        expect(nav.workLists).toBe(false);
    });
});
