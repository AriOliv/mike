// Status of the server-side mirrors (Notion, Drive, Google Calendar), manual
// triggers for them, and the background loop that keeps them in step.

import { notionBoardUrl, notionEnabled, startNotionSyncer, syncPipelineToNotion } from "../../lib/notion";
import { driveEnabled, startDriveSyncer, syncDocumentsToDrive } from "../../lib/drive";
import { calendarEnabled, startCalendarSyncer, syncObligationsToCalendar } from "../../lib/gcal";

export async function integrationStatus() {
    return {
        notion: { enabled: notionEnabled(), board_url: await notionBoardUrl() },
        drive: { enabled: driveEnabled(), folder_id: process.env.DRIVE_FOLDER_ID ?? null },
        calendar: {
            enabled: calendarEnabled(),
            calendar_id: process.env.GOOGLE_CALENDAR_ID ?? null,
        },
    };
}

export { syncPipelineToNotion, syncDocumentsToDrive, syncObligationsToCalendar };

let started = false;

/**
 * Start the periodic mirrors that are configured. Called once by the worker
 * runtime, so the loops run wherever background work runs (the worker thread
 * by default) instead of on the HTTP event loop.
 */
export function startContractMirrors(): void {
    if (started) return;
    started = true;
    if (notionEnabled()) startNotionSyncer();
    else console.log("Notion mirror off (NOTION_TOKEN / NOTION_PARENT_ID unset).");
    if (driveEnabled()) startDriveSyncer();
    else console.log("Drive mirror off (GOOGLE_SERVICE_ACCOUNT_FILE / DRIVE_FOLDER_ID unset).");
    if (calendarEnabled()) startCalendarSyncer();
    else console.log("Calendar mirror off (GOOGLE_SERVICE_ACCOUNT_FILE / GOOGLE_CALENDAR_ID unset).");
}
