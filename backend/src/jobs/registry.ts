// Composition root: domain handlers are reached through their public facades.
import { handleChatTurnAudit } from "../modules/audit/audit.service";
import { handleAccountDelete, handleExportBuild, handleMcpRefreshToken } from "../modules/user/user.service";
import { handleDocumentCleanup, handleDocumentExtractText, markDocumentTextFailed, handleDocumentPrecomputeText, handleConversionConvert, markConversionFailed } from "../modules/documents/documents.service";
import { handleExtractionExtract, markExtractionJobFailed } from "../modules/tabular/tabular.service";
import { handleMemoryConsolidation, markMemoryConsolidationFailed } from "../modules/memory/memory.service";
import { FEEDBACK_JOB, handleFeedbackIssue, markFeedbackFailed } from "../modules/feedback/feedback.service";
import { handleRegulatoryScan } from "../modules/regulatory/regulatory.service";
import {
  ANALYSIS_START_JOB_KIND,
  handleAnalysisReady,
  handleIntakePrefill,
  handleRequestAnalysisStart,
  handleRequestNotify,
  handleRequestTriage,
  PREFILL_JOB_KIND,
} from "../modules/requests/requests.service";
import { AUTO_REVIEW_JOB, handleAutoReview, markAutoReviewFailed } from "../modules/contracts/contracts.service";
import { ANALYSIS_READY_JOB, ANALYST_ANALYSIS_JOB, handleAnalystAnalysis, markAnalystAnalysisFailed } from "../modules/contract-review/contractReview.service";
import { handleStorageCleanup } from "../lib/dbq/storageCleanup";
import { type DbJobHandlers } from "../lib/dbq/types";
import { type DbJobFailureHook } from "../lib/dbq/runner";

export const DB_JOB_HANDLERS: DbJobHandlers = {
  "audit.chat_turn": handleChatTurnAudit,
  "account.delete": handleAccountDelete,
  "storage.cleanup": handleStorageCleanup,
  "document.cleanup": handleDocumentCleanup,
  "export.build": handleExportBuild,
  "conversion.convert": handleConversionConvert,
  "extraction.extract": handleExtractionExtract,
  "mcp.refresh_token": handleMcpRefreshToken,
  "document.precompute_text": handleDocumentPrecomputeText,
  "document.extract_text": handleDocumentExtractText,
  "memory.consolidate": handleMemoryConsolidation,
  "regulatory.scan": handleRegulatoryScan,
  [FEEDBACK_JOB]: (db, job) => handleFeedbackIssue(db, job),
  "request.triage": handleRequestTriage,
  "request.notify": (db) => handleRequestNotify(db),
  [PREFILL_JOB_KIND]: handleIntakePrefill,
  [ANALYSIS_START_JOB_KIND]: handleRequestAnalysisStart,
  [ANALYSIS_READY_JOB]: handleAnalysisReady,
  [AUTO_REVIEW_JOB]: handleAutoReview,
  [ANALYST_ANALYSIS_JOB]: handleAnalystAnalysis,
};
export const DB_JOB_FAILURE_HOOKS: Record<string, DbJobFailureHook> = {
  "conversion.convert": markConversionFailed,
  "document.extract_text": markDocumentTextFailed,
  "extraction.extract": markExtractionJobFailed,
  "memory.consolidate": markMemoryConsolidationFailed,
  [AUTO_REVIEW_JOB]: markAutoReviewFailed,
  [ANALYST_ANALYSIS_JOB]: markAnalystAnalysisFailed,
  [FEEDBACK_JOB]: markFeedbackFailed,
};
export {
  handleChatTurnAudit,
  handleAccountDelete,
  handleExportBuild,
  handleMcpRefreshToken,
  handleDocumentPrecomputeText,
  handleStorageCleanup,
};
export { MAX_ZIP_EXPORT_DOCUMENTS, MCP_TOKEN_REFRESH_WINDOW_MS } from "../modules/user/user.service";
