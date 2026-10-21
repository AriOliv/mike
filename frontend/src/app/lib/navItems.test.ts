import { describe, expect, it } from "vitest";
import { NAV_MAIN, NAV_MORE, isNavItemActive } from "./navItems";

describe("navItems", () => {
    it("lists the Legal workstation first, in Portuguese", () => {
        expect(NAV_MAIN.map((item) => item.label)).toEqual([
            "Esteira",
            "Prazos",
            "Perguntar",
        ]);
    });

    it("keeps the platform's other tools under Mais", () => {
        expect(NAV_MORE.map((item) => item.label)).toEqual([
            "Playbooks",
            "Revisão em grade",
            "Biblioteca",
            "Workflows",
            "Projetos",
            "Assistente",
            "IDE",
        ]);
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
});
