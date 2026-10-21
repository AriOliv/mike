/**
 * The sidebar's navigation, in the Legal team's words.
 *
 * `main` is the Legal workstation (docs/product/05 §1): Início · Pedidos ·
 * Esteira · Contratos · Prazos · Radar regulatório · Perguntar. Each item is
 * listed here only once its page exists, so the preview never links to a
 * 404: a feature adds its own line in the same change that adds the route.
 * `more` keeps the platform's other tools one click away under "Mais".
 * "Contratos" (/contratos) is the portfolio, one row per contract with the
 * Ficha's columns.
 */

export type NavIconKey =
    | "chat"
    | "ide"
    | "folder"
    | "library"
    | "tabular"
    | "workflow"
    | "playbook";

export type NavItem = {
    href: string;
    label: string;
    icon: NavIconKey;
    /** Active only on the exact path, not on the pages under it. */
    exact?: boolean;
};

export const NAV_MAIN: readonly NavItem[] = [
    { href: "/pipeline", label: "Esteira", icon: "folder" },
    { href: "/contratos", label: "Contratos", icon: "tabular" },
    { href: "/radar", label: "Prazos", icon: "workflow" },
    { href: "/acervo", label: "Perguntar", icon: "library" },
];

/**
 * The platform's other tools. The generic grid (/tabular-reviews) and the IDE
 * are left out on purpose: next to "Contratos" the grid reads as the
 * portfolio, and the IDE means nothing to the Legal team. Both routes still
 * work for whoever has the link.
 */
export const NAV_MORE: readonly NavItem[] = [
    { href: "/playbooks", label: "Playbooks", icon: "playbook" },
    { href: "/library", label: "Biblioteca", icon: "library" },
    { href: "/workflows", label: "Workflows", icon: "workflow" },
    { href: "/projects", label: "Projetos", icon: "folder", exact: true },
    { href: "/assistant", label: "Assistente", icon: "chat", exact: true },
];

/** Whether `item` is the page the user is on. */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
    if (item.exact) return pathname === item.href;
    return pathname === item.href || pathname.startsWith(item.href + "/");
}

/** Who the caller is to the Legal team, as GET /requests/me answers it. */
export type NavRole = "head" | "team" | "requester";

/** The only pages someone outside the Legal team works in (docs/product/05 §1). */
const REQUESTER_HREFS: readonly string[] = ["/inicio", "/pedidos"];

/**
 * The menu for `role`. Whoever only asks the Legal team for things sees
 * Início and their Pedidos, with no "Mais" and no project lists: the team's
 * workstation is not theirs. An unknown role (still loading, or a server
 * without the requests module) gets the whole menu, as before.
 */
export function navForRole(role: NavRole | null): {
    main: readonly NavItem[];
    more: readonly NavItem[];
    workLists: boolean;
} {
    if (role !== "requester") return { main: NAV_MAIN, more: NAV_MORE, workLists: true };
    return {
        main: NAV_MAIN.filter((item) => REQUESTER_HREFS.includes(item.href)),
        more: [],
        workLists: false,
    };
}
