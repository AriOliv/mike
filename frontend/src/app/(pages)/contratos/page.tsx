"use client";

import { ContractsPortfolioView } from "@/app/components/contracts/ContractsPortfolioView";
import type { PortfolioLoad } from "@/app/lib/contractsPortfolio";

// The list endpoint (GET /contracts/fichas) lands with the Ficha. Until then
// the page answers "unavailable" and teaches the next step; the PR that adds
// the endpoint swaps this loader for mikeApi.listContractFichas().
const loadPortfolio = async (): Promise<PortfolioLoad> => ({ status: "unavailable" });

export default function ContratosPage() {
    return <ContractsPortfolioView load={loadPortfolio} />;
}
