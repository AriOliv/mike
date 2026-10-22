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
    getRequestPlan,
    listRequests,
    previewCreateRequest,
    resolveRequestRef,
    assignRequest,
    decideTriage,
    moveRequestStage,
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
export { handleIntakePrefill, parsePrefill, PREFILL_JOB_KIND } from "./requests.prefill";
export {
    DEFAULT_INTAKE_TEMPLATE,
    intakeForAnalysis,
    type IntakeItem,
} from "./requests.intake";
export { handleRequestNotify, renderNotification, requestLink, SEND_JOB_KIND } from "./requests.notifications";
export {
    requestCode,
    parseRequestCode,
    computeDueAt,
    slaState,
    requesterStep,
    normalizeArea,
    requestPlan,
    REQUESTER_AREAS,
    REQUEST_KINDS,
    LANE_LABELS,
    type PlanStep,
} from "./requests.shared";
export type { Caller, McpActor } from "./requests.access";
export { REQUEST_TOOLS, REQUEST_READ_TOOLS, REQUEST_WRITE_TOOLS } from "./requests.mcp";
