// Facade for the dashboard module: the Legal head's panel (volume, cycle
// time, SLA, notice deadlines, agents vs. people, hours saved, adoption).

export {
    computeDashboard,
    getDashboard,
    parseDashboardQuery,
    DEFAULT_ASSUMPTIONS,
    periodStart,
    type Assumptions,
    type Caller,
    type Dashboard,
} from "./dashboard.metrics";
export { countAgentReviews, REVIEW_AGENTS } from "../contracts/contracts.service";
