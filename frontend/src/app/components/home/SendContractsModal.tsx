"use client";

import { useEffect, useRef, useState } from "react";
import { FileUp } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { ModalTextInput } from "@/app/components/modals/ModalTextInput";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import { ModalFieldLabel } from "@/app/components/modals/ModalFieldLabel";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import {
    createProject,
    createWatchedFolder,
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
const ACCEPT = ".pdf,.docx,.doc";

/** "Contrato Polaris (assinado).pdf" → "Contrato Polaris (assinado)". */
export function cardName(filename: string): string {
    return filename.replace(/\.[^.]+$/, "").trim() || filename;
}

/**
 * Batch upload into a watched folder: each file becomes a contract card in
 * the folder and is reviewed right away against the folder's playbook.
 */
export function SendContractsModal({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
    const { activeOrganization } = useWorkspace();
    const [folders, setFolders] = useState<WatchedFolder[] | null>(null);
    const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
    const [folderId, setFolderId] = useState<string>(NEW_FOLDER);
    const [folderName, setFolderName] = useState("Contratos recebidos");
    const [playbookId, setPlaybookId] = useState<string>(NO_PLAYBOOK);
    const [files, setFiles] = useState<File[]>([]);
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

    async function send() {
        if (files.length === 0) return;
        try {
            let folder = folders?.find((f) => f.id === folderId) ?? null;
            if (!folder) {
                setBusy("Criando a pasta…");
                folder = await createWatchedFolder({
                    name: folderName.trim() || "Contratos recebidos",
                    source: "upload",
                    playbook_id: playbookId === NO_PLAYBOOK ? null : playbookId,
                    org_id: activeOrganization?.id ?? null,
                });
            }
            let sent = 0;
            for (const [index, file] of files.entries()) {
                setBusy(`Enviando ${index + 1} de ${files.length}…`);
                const project = await createProject(
                    cardName(file.name),
                    undefined,
                    undefined,
                    activeOrganization?.id,
                );
                await watchProject(folder.id, project.id);
                const [outcome] = await uploadProjectDocuments(project.id, [{ file }]);
                if (outcome?.status !== "completed") continue;
                await requestContractReview(project.id);
                sent++;
            }
            showToast({
                tone: "success",
                message:
                    sent === files.length
                        ? `Recebi ${sent} ${sent === 1 ? "contrato" : "contratos"}. Estou revisando.`
                        : `Recebi ${sent} de ${files.length} contratos. Os outros não puderam ser enviados.`,
            });
            onSent();
        } catch (e) {
            notifyError(e);
        } finally {
            setBusy(null);
        }
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
                        accept={ACCEPT}
                        className="sr-only"
                        aria-label="Escolher contratos"
                        onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                    />
                    <button
                        type="button"
                        disabled={!!busy}
                        onClick={() => input.current?.click()}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                            e.preventDefault();
                            setFiles(Array.from(e.dataTransfer.files));
                        }}
                        className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-gray-300 px-4 py-6 text-xs text-gray-500 hover:bg-app-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                    >
                        <FileUp aria-hidden="true" className="h-5 w-5" />
                        {files.length
                            ? files.map((f) => f.name).join(", ")
                            : "Arraste PDFs ou DOCX aqui, ou clique para escolher"}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
