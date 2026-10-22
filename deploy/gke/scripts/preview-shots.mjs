#!/usr/bin/env node
// Screenshots of a Mike environment behind IAP, for a PR's review.
//
//   export IAP_TOKEN=$(deploy/gke/scripts/iap-token.sh "$MIKE_URL")
//   export DEMO_PASSWORD=...        # from the preview/mike-secrets Secret, never a file
//   node deploy/gke/scripts/preview-shots.mjs deploy/gke/shots/pedidos.json out/pedidos
//
// A shot list is JSON: who logs in, which pages, at which widths and themes,
// and what to do on the page before the picture (open a panel, pick a tab):
//
//   { "shots": [ { "name": "fila", "as": "legal", "path": "/pedidos",
//                  "widths": [1440, 390], "themes": ["light", "dark"],
//                  "steps": [ { "click": "text=LEG-0001" }, { "wait": 800 } ] } ] }
//
// Steps: click, press, fill {selector, value}, goto, waitFor, wait (ms), and
// mock {method, path, status, json} to answer one call in the browser.
//
// Accounts: "legal" (legal.demo@avenia.io) and "solicitante"
// (solicitante.demo@avenia.io); override with DEMO_LEGAL_EMAIL /
// DEMO_REQUESTER_EMAIL. One headless Chromium for the whole run, one page at
// a time (the team's machine is shared). The IAP token goes only to the Mike
// host, never to a third party; it is read from the environment and never
// written anywhere.
//
// Needs `playwright-core` (the repo's @playwright/test brings it) and a
// Chromium: CHROME=<path>, or the newest one in the Playwright cache.

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const BASE = (process.env.MIKE_URL || "https://preview.34-120-191-197.nip.io").replace(/\/$/, "");
const ACCOUNTS = {
    legal: process.env.DEMO_LEGAL_EMAIL || "legal.demo@avenia.io",
    solicitante: process.env.DEMO_REQUESTER_EMAIL || "solicitante.demo@avenia.io",
};

function fail(message) {
    console.error(message);
    process.exit(1);
}

/** The newest Chromium in the Playwright cache, unless CHROME says otherwise. */
function chromiumPath() {
    if (process.env.CHROME) return process.env.CHROME;
    const cache =
        process.env.PLAYWRIGHT_BROWSERS_PATH ||
        (process.platform === "darwin"
            ? join(homedir(), "Library/Caches/ms-playwright")
            : join(homedir(), ".cache/ms-playwright"));
    if (!existsSync(cache)) return undefined;
    const candidates = readdirSync(cache)
        .filter((d) => /^chromium_headless_shell-\d+$/.test(d) || /^chromium-\d+$/.test(d))
        .sort((a, b) => Number(b.split("-").pop()) - Number(a.split("-").pop()));
    for (const dir of candidates) {
        for (const rel of [
            "chrome-headless-shell-mac-arm64/chrome-headless-shell",
            "chrome-headless-shell-mac-x64/chrome-headless-shell",
            "chrome-headless-shell-linux64/chrome-headless-shell",
            "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
            "chrome-linux64/chrome",
        ]) {
            const full = join(cache, dir, rel);
            if (existsSync(full)) return full;
        }
    }
    return undefined;
}

async function run(page, step) {
    if (step.click) await page.locator(step.click).first().click();
    else if (step.press) await page.keyboard.press(step.press);
    else if (step.fill) await page.locator(step.fill.selector).first().fill(step.fill.value);
    else if (step.goto) await page.goto(`${BASE}${step.goto}`, { waitUntil: "networkidle" });
    else if (step.waitFor) await page.locator(step.waitFor).first().waitFor({ timeout: 15000 });
    // {"mock": {"method": "POST", "path": "/api/x", "status": 201, "json": {...}}}:
    // answer that one call in this browser only, e.g. to show a screen whose
    // real response would carry a secret (a token shown once). Never reaches
    // the backend; the next request to that path is the real one.
    else if (step.mock) {
        const m = step.mock;
        const target = `${BASE}${m.path}`;
        await page.route(
            (u) => u.href.split("?")[0] === target,
            (route) =>
                route.request().method() === (m.method ?? "GET")
                    ? route.fulfill({ status: m.status ?? 200, contentType: "application/json", body: JSON.stringify(m.json ?? {}) })
                    : route.fallback(),
            { times: 1 },
        );
    }
    if (step.wait) await page.waitForTimeout(step.wait);
}

async function main() {
    const [listFile, outDir] = process.argv.slice(2);
    if (!listFile || !outDir) fail("usage: preview-shots.mjs <shots.json> <outdir>");
    if (!process.env.IAP_TOKEN) fail("IAP_TOKEN is not set (deploy/gke/scripts/iap-token.sh)");
    if (!process.env.DEMO_PASSWORD) fail("DEMO_PASSWORD is not set");
    const { shots } = JSON.parse(readFileSync(listFile, "utf8"));
    mkdirSync(outDir, { recursive: true });

    const browser = await chromium.launch({ executablePath: chromiumPath() });
    const host = new URL(BASE).host;
    // One logged-in context per account, reused across its shots and themes:
    // the backend allows few logins per account, so never log in twice.
    const sessions = new Map();
    async function session(as, theme) {
        if (sessions.has(as)) {
            const page = sessions.get(as);
            await page.emulateMedia({ colorScheme: theme });
            return page;
        }
        const context = await browser.newContext({ colorScheme: theme, locale: "pt-BR", timezoneId: "America/Sao_Paulo" });
        // Chrome refuses Proxy-Authorization; IAP also takes (and strips) Authorization.
        await context.route("**/*", (route) => {
            const req = route.request();
            if (new URL(req.url()).host !== host) return route.continue();
            return route.continue({ headers: { ...req.headers(), authorization: `Bearer ${process.env.IAP_TOKEN}` } });
        });
        const page = await context.newPage();
        await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
        await page.fill('input[type="email"]', ACCOUNTS[as] ?? fail(`unknown account "${as}"`));
        await page.fill('input[type="password"]', process.env.DEMO_PASSWORD);
        await Promise.all([
            page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 }),
            page.keyboard.press("Enter"),
        ]);
        sessions.set(as, page);
        return page;
    }

    let taken = 0;
    let failures = 0;
    for (const shot of shots) {
        for (const theme of shot.themes ?? ["light"]) {
            const page = await session(shot.as ?? "legal", theme);
            for (const width of shot.widths ?? [1440]) {
                await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
                await page.goto(`${BASE}${shot.path}`, { waitUntil: "networkidle" });
                // The theme is a class on <html> set from the profile (lib/theme.ts);
                // force it after loading and again after the steps, which may re-render.
                const applyTheme = () =>
                    page.evaluate((t) => {
                        document.documentElement.classList.toggle("dark", t === "dark");
                        document.documentElement.style.colorScheme = t;
                    }, theme);
                await applyTheme();
                // a failed step still gets its picture (it shows what went wrong)
                // and the run goes on: every run costs logins (see session())
                let failed = "";
                try {
                    for (const step of shot.steps ?? []) await run(page, step);
                } catch (error) {
                    failed = String(error?.message ?? error).split("\n")[0];
                    failures += 1;
                }
                await applyTheme();
                await page.waitForTimeout(shot.settle ?? 800);
                const file = join(outDir, `${shot.name}-${width}-${theme}.png`);
                await page.screenshot({ path: file, fullPage: !!shot.fullPage });
                // Horizontal page scroll at phone width is a review failure; say so.
                const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
                console.log(`${file}${overflow > 1 ? `  ⚠ page scrolls sideways by ${overflow}px` : ""}${failed ? `  ⚠ step failed: ${failed}` : ""}`);
                taken += 1;
            }
        }
    }
    await browser.close();
    console.log(`${taken} screenshots in ${outDir}${failures ? `, ${failures} with a failed step` : ""}`);
    if (failures) process.exitCode = 1;
}

main().catch((error) => fail(error?.message ?? String(error)));
