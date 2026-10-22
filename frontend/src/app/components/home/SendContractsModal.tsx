"use client";

import { useEffect, useRef, useState } from "react";
import { FileUp } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { ModalTextInput } from "@/app/components/modals/ModalTextInput";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import { ModalFieldLabel } from "@/app/components/modals/ModalFieldLabel";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import { SEND_LIMITS, pickContracts } from "@/app/lib/home";
import {
    createProject,
    createWatchedFolder,
    deleteProject,
    listPlaybooks,
    listWatchedFolders,
    requestContractReview,
    uploadProjectDocuments,
    watchProject,
    type Playbook,
    type WatchedFolder,
} from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
import { showToast } from "@/app/components/ui/toast";

const NEW_FOLDER = "__nova__";
const NO_PLAYBOOK = "__nenhum__";

/** "Contrato Polaris (assinado).pdf" → "Contrato Polaris (assinado)". */
export function cardName(filename: string): string {
    return filename.replace(/\.[^.]+$/, "").trim() || filename;
}

/**
 * Batch upload into a watched folder: each file becomes a contract card in
 * the folder and is reviewed right away against the folder's playbook. One
 * failed file never stops the others, and a card whose upload failed is
 * removed rather than left empty on the board.
 */
export function SendContractsModal({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
    const { activeOrganization } = useWorkspace();
    const [folders, setFolders] = useState<WatchedFolder[] | null>(null);
    const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
    const [folderId, setFolderId] = useState<string>(NEW_FOLDER);
    const [folderName, setFolderName] = useState("Contratos recebidos");
    const [playbookId, setPlaybookId] = useState<string>(NO_PLAYBOOK);
    const [files, setFiles] = useState<File[]>([]);
    const [rejected, setRejected] = useState<string[]>([]);
    const [busy, setBusy] = useState<string | null>(null);
    const input = useRef<HTMLInputElement>(null);

    useEffect(() => {
        listWatchedFolders()
            .then((list) => {
                setFolders(list);
                if (list[0]) setFolderId(list[0].id);
            })
            .catch(() => setFolders([]));
        listPlaybooks(activeOrganization?.id ?? null)
            .then((list) => {
                setPlaybooks(list);
                if (list[0]) setPlaybookId(list[0].id);
            })
            .catch(() => setPlaybooks([]));
    }, [activeOrganization?.id]);

    function choose(list: File[]) {
        const { accepted, rejected: reasons } = pickContracts(list);
        setFiles(accepted.map((index) => list[index]));
        setRejected(reasons);
    }

    /** One file → one reviewed card. Returns false when it could not be sent. */
    async function sendOne(file: File, folder: WatchedFolder): Promise<boolean> {
        let projectId: string | null = null;
        try {
            projectId = (await createProject(cardName(file.name), undefined, undefined, activeOrganization?.id)).id;
            const [outcome] = await uploadProjectDocuments(projectId, [{ file }]);
            if (outcome?.status !== "completed") throw new Error("upload_failed");
            await watchProject(folder.id, projectId);
            await requestContractReview(projectId);
            return true;
        } catch {
            if (projectId) await deleteProject(projectId).catch(() => undefined);
            return false;
        }
    }

    async function send() {
        if (files.length === 0) return;
        let folder = folders?.find((f) => f.id === folderId) ?? null;
        try {
            if (!folder) {
                setBusy("Criando a pasta…");
                folder = await createWatchedFolder({
                    name: folderName.trim() || "Contratos recebidos",
                    source: "upload",
                    playbook_id: playbookId === NO_PLAYBOOK ? null : playbookId,
                    org_id: activeOrganization?.id ?? null,
                });
            }
        } catch (e) {
            notifyError(e, { lang: "pt", action: "criar a pasta monitorada" });
            setBusy(null);
            return;
        }
        const failed: string[] = [];
        for (const [index, file] of files.entries()) {
            setBusy(`Enviando ${index + 1} de ${files.length}…`);
            if (!(await sendOne(file, folder))) failed.push(file.name);
        }
        setBusy(null);
        const sent = files.length - failed.length;
        if (failed.length)
            showToast({
                tone: sent ? "info" : "error",
                title: sent ? `Recebi ${sent} de ${files.length} contratos` : "Não consegui enviar os contratos",
                message: `Não foram: ${failed.join(", ")}. Tente esses de novo.`,
                durationMs: null,
            });
        else
            showToast({
                tone: "success",
                message: `Recebi ${sent} ${sent === 1 ? "contrato" : "contratos"}. Estou revisando.`,
            });
        if (sent) onSent();
        else setFiles(files.filter((f) => failed.includes(f.name)));
    }

    const folderOptions = [
        ...(folders ?? []).map((f) => ({ value: f.id, label: f.name, suffix: f.contracts ? `${f.contracts}` : undefined })),
        { value: NEW_FOLDER, label: "Nova pasta monitorada" },
    ];
    const playbookOptions = [
        ...playbooks.map((p) => ({ value: p.id, label: p.name })),
        { value: NO_PLAYBOOK, label: "Só a Ficha, sem playbook" },
    ];

    return (
        <Modal
            open
            onClose={busy ? () => {} : onClose}
            size="md"
            breadcrumbs={["Enviar contratos"]}
            footerStatus={busy ?? (files.length ? `${files.length} ${files.length === 1 ? "arquivo" : "arquivos"}` : null)}
            primaryAction={{
                label: files.length > 1 ? `Enviar e revisar ${files.length}` : "Enviar e revisar",
                onClick: () => void send(),
                disabled: files.length === 0 || !!busy,
            }}
            cancelAction={{ label: "Cancelar", disabled: !!busy, onClick: onClose }}
        >
            <div className="space-y-4">
                <p className="text-xs text-gray-500">
                    Cada arquivo vira um contrato na pasta. Eu leio a Ficha, comparo com o playbook e aviso quando
                    estiver pronto para você revisar.
                </p>
                <div>
                    <ModalFieldLabel htmlFor="send-folder">Pasta</ModalFieldLabel>
                    <ModalSelect
                        id="send-folder"
                        value={folderId}
                        options={folderOptions}
                        onChange={setFolderId}
                        disabled={folders === null || !!busy}
                    />
                </div>
                {folderId === NEW_FOLDER ? (
                    <>
                        <div>
                            <ModalFieldLabel htmlFor="send-folder-name">Nome da pasta</ModalFieldLabel>
                            <ModalTextInput
                                id="send-folder-name"
                                value={folderName}
                                onChange={(e) => setFolderName(e.target.value)}
                                disabled={!!busy}
                            />
                        </div>
                        <div>
                            <ModalFieldLabel htmlFor="send-playbook">Revisar com o playbook</ModalFieldLabel>
                            <ModalSelect
                                id="send-playbook"
                                value={playbookId}
                                options={playbookOptions}
                                onChange={setPlaybookId}
                                disabled={!!busy}
                            />
                        </div>
                    </>
                ) : null}
                <div>
                    <input
                        ref={input}
                        type="file"
                        multiple
                        accept={SEND_LIMITS.accept}
                        className="sr-only"
                        aria-label="Escolher contratos"
                        onChange={(e) => choose(Array.from(e.target.files ?? []))}
                    />
                    <button
                        type="button"
                        disabled={!!busy}
                        onClick={() => input.current?.click()}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                            e.preventDefault();
                            choose(Array.from(e.dataTransfer.files));
                        }}
                        className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-gray-300 px-4 py-6 text-xs text-gray-500 hover:bg-app-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                    >
                        <FileUp aria-hidden="true" className="h-5 w-5" />
                        <span className="break-all">
                            {files.length
                                ? files.map((f) => f.name).join(", ")
                                : "Arraste os contratos aqui, ou clique para escolher"}
                        </span>
                        <span className="text-[11px] text-gray-400">
                            PDF ou DOCX · até {SEND_LIMITS.maxFiles} arquivos · até 25 MB cada
                        </span>
                    </button>
                    {rejected.length ? (
                        <ul role="alert" className="mt-2 space-y-0.5 text-[11px] text-amber-700">
                            {rejected.map((reason) => (
                                <li key={reason} className="break-all">
                                    Fora do envio: {reason}
                                </li>
                            ))}
                        </ul>
                    ) : null}
                </div>
            </div>
        </Modal>
    );
}
