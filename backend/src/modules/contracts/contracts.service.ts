// Facade for the contracts module: the CLM surface on top of projects — the
// pipeline board, the deadline radar, the AI analysis (dossier), commercial
// terms, the corpus Q&A (acervo), the contract preview, and the Notion /
// Drive / Calendar mirrors.

export {
    LANES,
    listPipeline,
    updatePipelineCard,
    type Lane,
    type PipelineBoard,
    type PipelineCard,
} from "./contracts.pipeline";
export {
    listObligations,
    createObligation,
    updateObligation,
    deleteObligation,
    type Obligation,
} from "./contracts.obligations";
export { getDossier, putDossier, type Dossier } from "./contracts.dossiers";
export {
    getContractPreview,
    getContractPreviewFile,
    type ContractPreview,
    type ContractPreviewFile,
} from "./contracts.preview";
export {
    ALERT_LEAD_DAYS,
    getContractTerms,
    extractContractTerms,
    extractMissingContractTerms,
    type ContractTerms,
    type TermsSyncSummary,
} from "./contracts.terms";
export { askAcervo, type AcervoAnswer } from "./contracts.acervo";
export {
    integrationStatus,
    syncPipelineToNotion,
    syncDocumentsToDrive,
    syncObligationsToCalendar,
    startContractMirrors,
} from "./contracts.integrations";
export type { Caller } from "./contracts.shared";
