"use client";

import { ContractsPortfolioView } from "@/app/components/contracts/ContractsPortfolioView";
import type { PortfolioLoad } from "@/app/lib/contractsPortfolio";
import { loadAllContractFichas } from "@/app/lib/contractPortfolioLoad";

// Every contract the person can open (GET /contracts/fichas, all pages),
// nearest notice deadline first.
const loadPortfolio = async (): Promise<PortfolioLoad> => ({ status: "ok", rows: await loadAllContractFichas() });

export default function ContratosPage() {
    return <ContractsPortfolioView load={loadPortfolio} />;
}
