// Facade for the requests module: requests to the legal team ("pedidos") —
// intake from anyone in the company, triage by an agent the Head confirms,
// assignment, questions to the requester, delivery, outside participants,
// and the e-mails around them.
//
// createRequest, getRequest and listRequests are also the surface the chat
// bot's MCP tools call (mike_request_analysis, mike_get_request_status,
// mike_list_my_requests).

export {
    createRequest,
    getRequest,
    listRequests,
    assignRequest,
    decideTriage,
    postMessage,
    deliverRequest,
    inviteParticipant,
    revokeParticipant,
    whoAmI,
    TRIAGE_JOB_KIND,
    type CreateRequestInput,
    type RequestPublicView,
    type RequestTeamView,
    type RequestList,
    type RequestListItem,
} from "./requests.core";
export { handleRequestTriage, suggestAssignee, parseTriage } from "./requests.triage";
export {
    answerIntake,
    getIntake,
    getIntakeTemplate,
    queueIntakePrefill,
    setIntakeTemplate,
    type RequestIntake,
} from "./requests.checklist";
export {
    applyAssignmentRules,
    getAssignmentRules,
    matchRule,
    parseAssignmentRules,
    reloadAfterRules,
    setAssignmentRules,
    valueFromIntake,
    type AssignmentRule,
} from "./requests.rules";
export { parseMoney } from "./requests.money";
export {
    buildStrip,
    currentStage,
    laneOfStage,
    moveStage,
    stageOwner,
    STAGE_CATALOG,
    STAGES,
    syncStage,
    type Stage,
    type StageStrip,
} from "./requests.stages";
export { handleIntakePrefill, parsePrefill, PREFILL_JOB_KIND } from "./requests.prefill";
export {
    enqueueRenewalSweep,
    getRenewalSettings,
    handleRenewalSweep,
    runRenewalSweep,
    setRenewalSettings,
    DEFAULT_RENEWAL_LEAD_DAYS,
    RENEWAL_JOB_KIND,
    type RenewalSettings,
    type RenewalSweep,
} from "./requests.renewals";
export {
    DEFAULT_INTAKE_TEMPLATE,
    intakeForAnalysis,
    type IntakeItem,
} from "./requests.intake";
export { handleRequestNotify, renderNotification, SEND_JOB_KIND } from "./requests.notifications";
export {
    requestCode,
    parseRequestCode,
    computeDueAt,
    slaState,
    requesterStep,
    normalizeArea,
    REQUESTER_AREAS,
} from "./requests.shared";
export type { Caller } from "./requests.access";
export {
    ANALYSIS_START_JOB_KIND,
    getRequestAnalysis,
    handleAnalysisReady,
    handleRequestAnalysisStart,
    listCriticalAlerts,
    requestAnalysis,
    type CriticalAlert,
} from "./requests.analysis";
