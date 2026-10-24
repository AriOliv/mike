import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Notion sync is a deployment switch (NOTION_SYNC_ENABLED), off by
// default. With it off the worker must boot without any Notion credential,
// create no Notion timer, and send nothing to api.notion.com.
const notion = vi.hoisted(() => ({ enqueueDueNotionSyncs: vi.fn().mockResolvedValue(0) }));
vi.mock("../modules/integrations-notion/notionSync.service", async () => ({
    ...(await vi.importActual<typeof import("../modules/integrations-notion/notionSync.service")>("../modules/integrations-notion/notionSync.service")),
    enqueueDueNotionSyncs: notion.enqueueDueNotionSyncs,
}));
vi.mock("../workers", async () => ({
    ...(await vi.importActual<typeof import("../workers")>("../workers")),
    anyWorkerEnabled: () => false,
    startWorkers: vi.fn(),
    stopWorkers: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/dbq/runner", async () => ({
    ...(await vi.importActual<typeof import("../lib/dbq/runner")>("../lib/dbq/runner")),
    startDbJobRunner: vi.fn(),
    stopDbJobRunner: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/dbq/enqueue", async () => ({
    ...(await vi.importActual<typeof import("../lib/dbq/enqueue")>("../lib/dbq/enqueue")),
    enqueueDbJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../jobs/maintenance", async () => ({
    ...(await vi.importActual<typeof import("../jobs/maintenance")>("../jobs/maintenance")),
    runStaleWorkSweep: vi.fn().mockResolvedValue({ documents: 0, cells: 0 }),
}));
vi.mock("../modules/uploads/uploads.service", async () => ({
    ...(await vi.importActual<typeof import("../modules/uploads/uploads.service")>("../modules/uploads/uploads.service")),
    startUploadProcessingWorkers: vi.fn(() => () => undefined),
}));
vi.mock("../modules/contracts/contracts.service", async () => ({
    ...(await vi.importActual<typeof import("../modules/contracts/contracts.service")>("../modules/contracts/contracts.service")),
    startContractMirrors: vi.fn(),
}));
vi.mock("../modules/feedback/feedback.service", async () => ({
    ...(await vi.importActual<typeof import("../modules/feedback/feedback.service")>("../modules/feedback/feedback.service")),
    requeuePending: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../modules/regulatory/regulatory.service", async () => ({
    ...(await vi.importActual<typeof import("../modules/regulatory/regulatory.service")>("../modules/regulatory/regulatory.service")),
    enqueueDueRegulatoryScans: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../modules/requests/requests.service", async () => ({
    ...(await vi.importActual<typeof import("../modules/requests/requests.service")>("../modules/requests/requests.service")),
    enqueueRenewalSweep: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/supabase", async () => ({
    ...(await vi.importActual<typeof import("../lib/supabase")>("../lib/supabase")),
    createServerSupabase: () => ({}),
}));

const saved = { ...process.env };
beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    notion.enqueueDueNotionSyncs.mockClear();
    delete process.env.NOTION_TOKEN;
    delete process.env.NOTION_PARENT_ID;
    delete process.env.NOTION_SYNC_ENABLED;
});
afterEach(() => {
    vi.useRealTimers();
    process.env = { ...saved };
});

describe("worker runtime and the Notion sync switch", () => {
    it("boots with the switch off and no Notion credential, and never sweeps", async () => {
        const runtime = await import("../workerRuntime.js");
        expect(() => runtime.startAllWorkers()).not.toThrow();
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(notion.enqueueDueNotionSyncs).not.toHaveBeenCalled();
        await runtime.stopAllWorkers();
    });

    it("with the switch on, the sweep runs every minute", async () => {
        process.env.NOTION_SYNC_ENABLED = "true";
        const runtime = await import("../workerRuntime.js");
        runtime.startAllWorkers();
        await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
        expect(notion.enqueueDueNotionSyncs.mock.calls.length).toBeGreaterThanOrEqual(3);
        await runtime.stopAllWorkers();
    });
});
