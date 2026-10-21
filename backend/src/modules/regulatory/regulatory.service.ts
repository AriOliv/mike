// Facade for the regulatory module: the radar that scans Brazilian public
// sources (BCB, DOU, CVM, Receita), keeps what each saved scan watches,
// crosses it with the contract base and lets the team turn a change into a
// request or a deadline in one click.

export {
    listPresets,
    listScans,
    createScan,
    updateScan,
    deleteScan,
    runScanNow,
    listChanges,
    visibleScanIds,
    updateChange,
    createRequestFromChange,
    createObligationFromChange,
    type Caller,
    type RegulatoryScan,
    type RegulatoryChange,
} from "./regulatory.changes";
export {
    suggestPlaybookRule,
    listRuleSuggestions,
    decideRuleSuggestion,
    draftGuidance,
    type RuleSuggestion,
} from "./regulatory.rules";
export {
    runRegulatoryScan,
    handleRegulatoryScan,
    enqueueDueRegulatoryScans,
    SCAN_INTERVAL_MS,
} from "./regulatory.scan";
