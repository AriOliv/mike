import { describe, expect, it } from "vitest";
import { channelConfig, channelDraft, hoursSummary, parseDays, toggle, toPayload } from "./legalAgent";
import type { LegalAgentSettings } from "./mikeApi";

const hours = (days: number[]): LegalAgentSettings["hours"] => ({
    timezone: "America/Sao_Paulo",
    days,
    start: "09:00",
    end: "18:00",
    outside: "avisa_e_registra",
});

describe("legal agent form helpers", () => {
    it("says the hours in one line", () => {
        expect(hoursSummary(hours([5, 1, 2, 3, 4]))).toBe("Seg a sex, 09:00 às 18:00");
        expect(hoursSummary(hours([1, 3]))).toBe("Seg, qua, 09:00 às 18:00");
        expect(hoursSummary(hours([1, 2]))).toBe("Seg, ter, 09:00 às 18:00");
        expect(hoursSummary(hours([]))).toBe("Nenhum dia, 09:00 às 18:00");
    });

    it("toggles an item in a list", () => {
        expect(toggle([1, 2], 2)).toEqual([1]);
        expect(toggle([1], 2)).toEqual([1, 2]);
    });

    it("reads the deadline warnings a person types", () => {
        expect(parseDays("7, 30 15;30")).toEqual([30, 15, 7]);
        expect(parseDays("")).toEqual([]);
        expect(parseDays("0")).toBeNull();
        expect(parseDays("200")).toBeNull();
        expect(parseDays("x")).toBeNull();
    });

    it("drops the server's stamp before saving", () => {
        const settings = { enabled: true, updated_at: "x" } as unknown as LegalAgentSettings;
        expect(toPayload(settings)).toEqual({ enabled: true });
    });

    it("turns a channel's stored config into the form and back", () => {
        expect(channelDraft("slack", { workspace: "Avenia", channels: ["juridico", "pedidos"] })).toEqual({
            workspace: "Avenia",
            channels: "juridico, pedidos",
            bot_name: "advogado-mike",
        });
        expect(channelDraft("slack")).toEqual({ workspace: "", channels: "", bot_name: "advogado-mike" });
        expect(channelDraft("telegram", { bot_username: "acme_bot" })).toEqual({ bot_username: "acme_bot", mode: "polling" });
        expect(channelDraft("whatsapp", { phone_last4: 1234 })).toEqual({ phone_last4: "", business_name: "" });

        expect(channelConfig("slack", { workspace: "A", channels: "#a, b  c", bot_name: "x" })).toEqual({
            workspace: "A",
            channels: ["#a", "b", "c"],
            bot_name: "x",
        });
        expect(channelConfig("slack", {})).toEqual({ workspace: "", channels: [], bot_name: "" });
        expect(channelConfig("telegram", {})).toEqual({ bot_username: "", mode: "polling" });
        expect(channelConfig("telegram", { bot_username: "b", mode: "webhook" })).toEqual({ bot_username: "b", mode: "webhook" });
        expect(channelConfig("whatsapp", {})).toEqual({ phone_last4: "", business_name: "" });
        expect(channelConfig("whatsapp", { phone_last4: "1234", business_name: "A" })).toEqual({ phone_last4: "1234", business_name: "A" });
    });
});
