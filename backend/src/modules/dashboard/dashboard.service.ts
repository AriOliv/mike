// Facade for the dashboard module: the Legal head's panel (volume, cycle
// time, SLA, notice deadlines, agents vs. people, hours saved, adoption).

export {
    computeDashboard,
    getDashboard,
    parseDashboardQuery,
    DEFAULT_ASSUMPTIONS,
    type Assumptions,
    type Caller,
    type Dashboard,
} from "./dashboard.metrics";
