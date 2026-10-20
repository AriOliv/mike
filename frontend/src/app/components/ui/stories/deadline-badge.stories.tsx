import { DeadlineBadge } from "@/app/components/ui/deadline-badge";

const meta = { title: "UI / DeadlineBadge" };
export default meta;

const now = new Date(2026, 9, 20);

/** Every tone, nearest last: the closer the date, the louder the badge. */
export const AllTones = () => (
    <div className="flex flex-wrap gap-2">
        <DeadlineBadge date="2027-03-01" now={now} />
        <DeadlineBadge date="2027-01-10" now={now} />
        <DeadlineBadge date="2026-12-10" now={now} />
        <DeadlineBadge date="2026-11-10" endDate="2026-12-10" noticeDays={30} now={now} />
        <DeadlineBadge date="2026-10-25" kind="prazo" now={now} />
        <DeadlineBadge date="2026-10-20" kind="vigencia" now={now} />
        <DeadlineBadge date="2026-10-01" now={now} />
    </div>
);
