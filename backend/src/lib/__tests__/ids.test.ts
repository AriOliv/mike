import { describe, expect, it } from "vitest";
import { isUuidShape, uuidId } from "../ids";

// The preview seed's fixed ids: version 4, but variants c and e, which the
// RFC (and zod's uuid()) refuse and Postgres accepts.
const SEED_ORG = "00000000-0000-4000-c000-000000000001";
const SEED_CHANGE = "00000000-0000-4000-e000-000000000001";

describe("ids as Postgres stores them", () => {
    it("accepts any 8-4-4-4-12 hex id, seed ids and random ones alike", () => {
        for (const id of [SEED_ORG, SEED_CHANGE, "8f14e45f-ceea-467a-9575-3b3e5f2a1c0d", "8F14E45F-CEEA-467A-9575-3B3E5F2A1C0D"])
            expect(isUuidShape(id)).toBe(true);
        expect(uuidId().safeParse(SEED_ORG).success).toBe(true);
    });

    it("refuses anything that is not that shape", () => {
        for (const bad of ["", "abc", "00000000-0000-4000-c000-00000000000", "00000000-0000-4000-c000-0000000000011", "0000000g-0000-4000-c000-000000000001", 42, null])
            expect(isUuidShape(bad)).toBe(false);
        const r = uuidId("document_id must be a UUID").safeParse("x");
        expect(r.success).toBe(false);
        expect(!r.success && r.error.issues[0].message).toBe("document_id must be a UUID");
        expect(!uuidId().safeParse("x").success && uuidId().safeParse("x").error?.issues[0].message).toBe("Invalid UUID");
    });
});
