import { describeError } from "@/app/lib/userFacingError";

/**
 * The warning shown on a document tab when accepting or rejecting an edit
 * fails. It says what happened (the server's own words when it has them, like
 * the contract being changed by someone else at the same moment) and that the
 * edit went back to how it was, so the person knows nothing was saved.
 */
export function editFailureMessage(error: unknown, verb: "accept" | "reject", count = 1): string {
    const what =
        verb === "accept"
            ? count > 1 ? "algumas das aceitações" : "a aceitação"
            : count > 1 ? "algumas das recusas" : "a recusa";
    const { message } = describeError(error, { lang: "pt" });
    return `Não consegui salvar ${what}: ${message} A edição voltou ao que era.`;
}
