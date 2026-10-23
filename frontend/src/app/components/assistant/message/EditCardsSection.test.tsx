import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditCardsSection } from "./EditCardsSection";

const { resolveDocumentEdit } = vi.hoisted(() => ({
    resolveDocumentEdit: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", async (original) => ({
    ...(await original<typeof import("@/app/lib/mikeApi")>()),
    resolveDocumentEdit,
}));

const annotation = {
    edit_id: "edit-1",
    document_id: "document-1",
    version_id: "version-1",
    change_id: "change-1",
    deleted_text: "old text",
    inserted_text: "new text",
    status: "pending" as const,
};

describe("EditCardsSection", () => {
    beforeEach(() => {
        resolveDocumentEdit.mockReset();
    });

    it("pushes the bulk View action to the right edge", () => {
        render(
            <EditCardsSection
                pending={[{ annotation, filename: "agreement.docx" }]}
                filenameByDocId={
                    new Map([["document-1", "agreement.docx"]])
                }
                cards={[
                    <div key="one">First change</div>,
                    <div key="two">Second change</div>,
                ]}
                resolvedCount={0}
                onViewClick={vi.fn()}
            />,
        );

        const view = screen.getByRole("button", { name: "View" });
        expect(view).toHaveClass("ml-auto");
        expect(view.parentElement).toHaveClass("w-full");
    });

    it.each([
        ["accept", "Accept all", "Accepting all..."],
        ["reject", "Reject all", "Rejecting all..."],
    ] as const)(
        "shows the %s-all action while the bulk request is pending",
        async (verb, idleLabel, busyLabel) => {
            let finish!: (value: unknown) => void;
            resolveDocumentEdit.mockReturnValueOnce(
                new Promise((resolve) => {
                    finish = resolve;
                }),
            );
            const onResolved = vi.fn();

            render(
                <EditCardsSection
                    pending={[{ annotation, filename: "agreement.docx" }]}
                    filenameByDocId={
                        new Map([["document-1", "agreement.docx"]])
                    }
                    cards={[
                        <div key="one">First change</div>,
                        <div key="two">Second change</div>,
                    ]}
                    resolvedCount={0}
                    onResolved={onResolved}
                />,
            );

            fireEvent.click(
                screen.getByRole("button", { name: idleLabel }),
            );
            expect(
                screen.getByRole("button", { name: busyLabel }),
            ).toBeDisabled();
            expect(
                screen.getByRole("button", {
                    name: verb === "accept" ? "Reject all" : "Accept all",
                }),
            ).toBeDisabled();

            finish({
                status: verb === "accept" ? "accepted" : "rejected",
                version_id: "version-2",
                download_url: null,
            });

            await waitFor(() => expect(onResolved).toHaveBeenCalledOnce());
            expect(
                screen.getByRole("button", { name: idleLabel }),
            ).toBeEnabled();
        },
    );

    it("says in Portuguese, with the server's reason, when a bulk accept loses the race", async () => {
        resolveDocumentEdit.mockRejectedValueOnce(
            Object.assign(new Error("O contrato foi alterado por outra pessoa ao mesmo tempo. Sua decisão não foi gravada; tente de novo."), {
                status: 409,
                code: "document_busy",
            }),
        );
        vi.spyOn(console, "error").mockImplementation(() => {});
        const onError = vi.fn();
        render(
            <EditCardsSection
                pending={[{ annotation, filename: "agreement.docx" }]}
                filenameByDocId={new Map([["document-1", "agreement.docx"]])}
                cards={[<div key="one">First change</div>, <div key="two">Second change</div>]}
                resolvedCount={0}
                onViewClick={vi.fn()}
                onError={onError}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: "Accept all" }));
        await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
        const { message } = onError.mock.calls[0][0];
        expect(message).toMatch(/^Não consegui salvar a aceitação: O contrato foi alterado por outra pessoa/);
        expect(message).not.toMatch(/Couldn't|reverted/);
    });
});
