// Facade for the contracts module: the CLM surface on top of projects — the
// pipeline board, the deadline radar, the AI analysis (dossier), commercial
// terms, the corpus Q&A (acervo), the contract preview, the activity log
// shared by people and agents (card_events), the automatic review of
// watched folders and the home screen, and the Notion / Drive / Calendar
// mirrors.

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
    listObligationAlerts,
    listContractAlerts,
    obligationIcs,
    OBLIGATION_STATUSES,
    DEFAULT_ALERT_DAYS,
    type Obligation,
    type ObligationAlert,
    type ContractAlert,
    type ObligationStatus,
    type OwnerOptions,
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
export { contractCorpus, type ContractCorpusEntry } from "./contracts.corpus";
export {
    integrationStatus,
    syncPipelineToNotion,
    syncDocumentsToDrive,
    syncObligationsToCalendar,
    startContractMirrors,
} from "./contracts.integrations";
export {
    ACTOR_TYPES,
    EVENT_SOURCES,
    recordCardEvent,
    recordAgentRead,
    listCardEvents,
    startAgentRun,
    finishAgentRun,
    type ActorType,
    type EventSource,
    type CardEvent,
    type CardEventInput,
    type AgentRunInput,
    type AgentRunOutcome,
} from "./contracts.events";
export {
    AUTO_REVIEW_JOB,
    listWatchedFolders,
    createWatchedFolder,
    watchProject,
    scanWatchedFolders,
    requestReview,
    handleAutoReview,
    markAutoReviewFailed,
    updateContractReview,
    getLatestReview,
    type WatchedFolder,
} from "./contracts.autoReview";
export {
    getHomeSummary,
    listNoticeDeadlines,
    countAgentReviews,
    REVIEW_AGENTS,
    type HomeSummary,
    type HomeReview,
    type HomeDeadline,
} from "./contracts.home";
export type { Caller } from "./contracts.shared";

export { CONTRACT_TOOLS } from "./contracts.mcp";
export { getContractText, type ContractText } from "./contracts.text";
