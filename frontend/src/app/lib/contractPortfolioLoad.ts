// Loads the whole contract portfolio for /contratos. The endpoint pages (at
// most 100 rows a request), so a single call would cut the list short without
// saying so; this follows next_offset until the last page.

import { listContractFichas, type ContractPortfolioRow } from "./mikeApi";

const PAGE = 100;
/** A safety stop: 50 pages is 5,000 contracts, far beyond a legal team's base. */
const MAX_PAGES = 50;

export async function loadAllContractFichas(): Promise<ContractPortfolioRow[]> {
    const rows: ContractPortfolioRow[] = [];
    let offset: number | null = 0;
    for (let page = 0; offset !== null && page < MAX_PAGES; page++) {
        const result = await listContractFichas({ sort: "aviso", limit: PAGE, offset });
        rows.push(...result.rows);
        offset = result.next_offset;
    }
    return rows;
}
