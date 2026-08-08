import { app } from "./app";
import { manifestPublicKey } from "./lib/manifestSigning";
import { notionEnabled, startNotionSyncer } from "./lib/notion";
import { driveEnabled, startDriveSyncer } from "./lib/drive";
import { calendarEnabled, startCalendarSyncer } from "./lib/gcal";

const PORT = process.env.PORT ?? 3001;

// Surface a malformed MANIFEST_SIGNING_KEY at boot rather than when someone's
// first export fails. Unset is a valid choice and means manifests go out
// unsigned; malformed is a misconfiguration, so stop rather than serve a
// deployment whose exports will fail later.
try {
  const signingKey = manifestPublicKey();
  if (signingKey) {
    console.log(`Export manifests signed with key ${signingKey.key_id}`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`Mike backend running on port ${PORT}`);
  // Mirrors the pipeline to Notion. Inert unless NOTION_TOKEN and
  // NOTION_PARENT_ID are both set.
  if (notionEnabled()) {
    startNotionSyncer();
  } else {
    console.log("Notion mirror off (NOTION_TOKEN / NOTION_PARENT_ID unset).");
  }
  // Mirrors project documents to a shared Drive folder. Inert unless a service
  // account file and DRIVE_FOLDER_ID are both set.
  if (driveEnabled()) {
    startDriveSyncer();
  } else {
    console.log("Drive mirror off (GOOGLE_SERVICE_ACCOUNT_FILE / DRIVE_FOLDER_ID unset).");
  }
  // Mirrors radar deadlines onto a shared Google Calendar.
  if (calendarEnabled()) {
    startCalendarSyncer();
  } else {
    console.log("Calendar mirror off (GOOGLE_SERVICE_ACCOUNT_FILE / GOOGLE_CALENDAR_ID unset).");
  }
});
