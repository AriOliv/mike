// Facade of the contract-review module: a contract's review by playbook
// (redline + one verdict per clause) and its Ficha. Topic files:
//   contractReview.reviews.ts      start / read / decide a review
//   contractReview.fichaService.ts extract and validate the Ficha
//   contractReview.ficha.ts        the Ficha's envelope, verification, merge
//   contractReview.rules.ts        deterministic risk rules on the Ficha
//   contractReview.playbook.ts     Playbook Avenia v1 (seed content)
//   contractReview.portfolio.ts    the contract portfolio list (GET /contracts/fichas)

export {
    buildClauses,
    decideReviewClause,
    ensureAveniaPlaybook,
    getContractReview,
    listContractReviews,
    startContractReview,
    type ClauseSource,
    type ContractReview,
    type Decision,
    type Precedent,
    type ReviewClause,
    type ReviewSummary,
} from "./contractReview.reviews";
export { decideFichaField, extractFicha, getFicha, type FichaView } from "./contractReview.fichaService";
export { listContractPortfolio, type Portfolio, type PortfolioRow } from "./contractReview.portfolio";
export { AVENIA_PLAYBOOK_CONTENT, AVENIA_PLAYBOOK_NAME, RULE_RISK_RULES } from "./contractReview.playbook";
export type { Caller } from "./contractReview.shared";
