"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { FileText } from "lucide-react";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { EmptyState } from "@/app/components/ui/empty-state";
import { pillButtonUIClassName } from "@/shared/ui/PillButtonUI.styles";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import {
    SkeletonLine,
    TableBody,
    TableCell,
    TableEmptyState,
    TableHeaderCell,
    TableHeaderRow,
    TableRow,
    TableScrollArea,
} from "@/app/components/shared/TablePrimitive";
import { describeError } from "@/app/lib/userFacingError";
import {
    brDate,
    daysUntil,
    fichaProgress,
    sortPortfolio,
    type PortfolioLoad,
    type PortfolioSort,
} from "@/app/lib/contractsPortfolio";
import { cn } from "@/app/lib/utils";

const COLUMNS = [
    { label: "Contrato", width: "w-72" },
    { label: "Tipo", width: "w-32" },
    { label: "Vencimento", width: "w-28" },
    { label: "Aviso até", width: "w-36" },
    { label: "Ficha", width: "w-40" },
] as const;

/**
 * Contratos: the portfolio, one row per contract with the Ficha's columns,
 * soonest notice first. `load` is injected so the page can ship before the
 * list endpoint does; an "unavailable" answer teaches the next step instead
 * of showing an empty table.
 */
export function ContractsPortfolioView({
    load,
    today = new Date(),
}: {
    load: () => Promise<PortfolioLoad>;
    today?: Date;
}) {
    const [result, setResult] = useState<PortfolioLoad | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    const [sort, setSort] = useState<PortfolioSort>("aviso");

    useEffect(() => {
        let cancelled = false;
        setError(null);
        load()
            .then((next) => !cancelled && setResult(next))
            .catch(
                (e) =>
                    !cancelled &&
                    setError(describeError(e, { lang: "pt", action: "carregar os contratos" }).message),
            );
        return () => {
            cancelled = true;
        };
    }, [load, attempt]);

    const rows = useMemo(
        () => (result?.status === "ok" ? sortPortfolio(result.rows, sort) : []),
        [result, sort],
    );

    return (
        <div className="flex h-full flex-col">
            <PageHeader>Contratos</PageHeader>
            <div className="mx-3 mt-1 flex flex-wrap items-center gap-2 md:mx-6.5">
                <TabPillButtonUI active={sort === "aviso"} onClick={() => setSort("aviso")}>
                    Aviso mais próximo
                </TabPillButtonUI>
                <TabPillButtonUI active={sort === "nome"} onClick={() => setSort("nome")}>
                    Nome
                </TabPillButtonUI>
            </div>
            <TableScrollArea
                className="mt-3"
                header={
                    <TableHeaderRow className="pl-3">
                        {COLUMNS.map((c) => (
                            <TableHeaderCell key={c.label} className={c.width}>
                                {c.label}
                            </TableHeaderCell>
                        ))}
                    </TableHeaderRow>
                }
            >
                <TableBody>
                    {error ? (
                        <TableEmptyState>
                            <EmptyState
                                tone="error"
                                title="Não consegui carregar os contratos"
                                description={error}
                                action={
                                    <PillButtonUI tone="white" onClick={() => setAttempt((n) => n + 1)}>
                                        Tentar de novo
                                    </PillButtonUI>
                                }
                            />
                        </TableEmptyState>
                    ) : result === null ? (
                        [0, 1, 2, 3].map((i) => (
                            <TableRow key={i} interactive={false} className="h-11 pl-3">
                                {COLUMNS.map((c) => (
                                    <TableCell key={c.label} className={c.width}>
                                        <SkeletonLine className="w-3/4" />
                                    </TableCell>
                                ))}
                            </TableRow>
                        ))
                    ) : result.status === "unavailable" ? (
                        <TableEmptyState>
                            <EmptyState
                                icon={<FileText />}
                                title="A carteira está chegando"
                                description="Cada contrato vigente vai virar uma linha com os campos da Ficha e a data limite do aviso. Enquanto isso, os contratos que eu revisei estão no Início."
                                action={
                                    <Link href="/inicio" className={pillButtonUIClassName({ tone: "white" })}>
                                        Ir para o Início
                                    </Link>
                                }
                            />
                        </TableEmptyState>
                    ) : rows.length === 0 ? (
                        <TableEmptyState>
                            <EmptyState
                                icon={<FileText />}
                                title="Nenhum contrato ainda"
                                description="Envie contratos ou conecte uma pasta no Início. Cada um vira uma linha aqui, com a Ficha preenchida e a data limite do aviso."
                                action={
                                    <Link href="/inicio" className={pillButtonUIClassName({ tone: "white" })}>
                                        Enviar contratos
                                    </Link>
                                }
                            />
                        </TableEmptyState>
                    ) : (
                        rows.map((row) => {
                            const left = row.notice_deadline ? daysUntil(row.notice_deadline, today) : null;
                            return (
                                <TableRow key={row.project_id} className="h-11 pl-3">
                                    <TableCell className="w-72 pr-3">
                                        <Link
                                            href={`/projects/${row.project_id}/review`}
                                            className="block break-words text-gray-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                                        >
                                            {row.name}
                                        </Link>
                                        <span className="block break-words text-[11px] text-gray-500">
                                            {row.counterparty ?? "Contraparte não informada"}
                                        </span>
                                    </TableCell>
                                    <TableCell className="w-32">{row.contract_type ?? "—"}</TableCell>
                                    <TableCell className="w-28">{brDate(row.term_end)}</TableCell>
                                    <TableCell
                                        className={cn(
                                            "w-36",
                                            left !== null && left < 0 && "text-red-700",
                                            left !== null && left >= 0 && left <= 30 && "text-amber-700",
                                        )}
                                    >
                                        {row.notice_deadline ? (
                                            <>
                                                {brDate(row.notice_deadline)}
                                                <span className="block text-[11px]">
                                                    {left! < 0
                                                        ? "janela de aviso passou"
                                                        : left === 0
                                                          ? "último dia"
                                                          : left === 1
                                                            ? "falta 1 dia"
                                                            : `faltam ${left} dias`}
                                                </span>
                                            </>
                                        ) : (
                                            "—"
                                        )}
                                    </TableCell>
                                    <TableCell className="w-40 text-gray-700">{fichaProgress(row)}</TableCell>
                                </TableRow>
                            );
                        })
                    )}
                </TableBody>
            </TableScrollArea>
        </div>
    );
}
