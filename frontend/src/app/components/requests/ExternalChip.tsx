import { Users } from "lucide-react";

/**
 * Marks a request someone outside the team (an outside firm, a colleague
 * from the business) can see. Amber, with an icon and a word, so a glance at
 * the queue says a third party is reading.
 */
export function ExternalChip() {
    return (
        <span className="inline-flex h-5 items-center gap-1 rounded-full bg-amber-50 px-2 text-[11px] font-medium text-amber-700">
            <Users aria-hidden="true" className="h-3 w-3" />
            Externo
        </span>
    );
}
