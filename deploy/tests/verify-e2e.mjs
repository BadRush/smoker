import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

const BASE_URL = process.env.BASE_URL || "http://smoker-gateway";
const USERNAME = process.env.ADMIN_USERNAME || "admin";
const PASSWORD = process.env.ADMIN_PASSWORD || "smoker_admin_change_me";

async function assertAccessible(page, routeName) {
  const results = await new AxeBuilder({ page }).analyze();
  const criticalViolations = results.violations.filter(
    (v) => v.impact === "critical" || v.impact === "serious"
  );
  if (criticalViolations.length > 0) {
    throw new Error(
      `Axe serious/critical violations on ${routeName}: ${JSON.stringify(criticalViolations, null, 2)}`
    );
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();

  const errors = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(`console.error: ${msg.text()}`);
    }
  });

  // 1. Login
  await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle" });
  await assertAccessible(page, "/login");
  await page.getByLabel("Operator Username").fill(USERNAME);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /sign in to noc/i }).click();
  await page.waitForURL(`${BASE_URL}/`, { timeout: 15000 });
  await page.getByRole("heading", { name: /noc dashboard/i }).waitFor();
  await page.locator('[data-testid="mini-sparkline"]').first().waitFor({ timeout: 15000 });
  await assertAccessible(page, "/ (Matrix)");

  // Switch to Charts Grid on / and verify compact uPlot canvases render cleanly
  await page.getByRole("button", { name: /charts grid/i }).click();
  await page.locator('[data-testid="grid-target-card"]').first().waitFor({ timeout: 10000 });
  await page.locator("canvas.u-over, .uplot canvas").first().waitFor({ timeout: 20000 });
  await assertAccessible(page, "/ (Charts Grid)");
  await page.getByRole("button", { name: /^matrix$/i }).click();

  // 2. Verify local probe online & editable on /probes
  await page.goto(`${BASE_URL}/probes`, { waitUntil: "networkidle" });
  await page.getByText("Local Central Probe").waitFor({ timeout: 10000 });
  await page.getByText("online", { exact: true }).first().waitFor({ timeout: 15000 });
  await assertAccessible(page, "/probes");

  await page.getByRole("button", { name: "Edit probe Local Central Probe" }).click();
  await page.getByLabel("Probe Name *").fill("E2E Renamed Probe");
  await page.getByRole("button", { name: /save changes/i }).click();
  await page.getByText("E2E Renamed Probe", { exact: true }).waitFor({ timeout: 10000 });
  await assertAccessible(page, "/probes (edit modal saved)");

  await page.getByRole("button", { name: "Edit probe E2E Renamed Probe" }).click();
  await page.getByLabel("Probe Name *").fill("Local Central Probe");
  await page.getByRole("button", { name: /save changes/i }).click();
  await page.getByText("Local Central Probe", { exact: true }).waitFor({ timeout: 10000 });

  // 3. Test Group create/edit + Target create/edit/pause/duplicate via /targets UI
  await page.goto(`${BASE_URL}/targets`, { waitUntil: "networkidle" });
  await assertAccessible(page, "/targets");

  await page.getByRole("button", { name: /^add group$/i }).click();
  await page.getByLabel(/group name/i).fill("E2E Temp Group");
  await page.getByRole("button", { name: /^create group$/i }).click();
  await page.getByText("E2E Temp Group", { exact: true }).waitFor({ timeout: 10000 });

  await page.getByRole("button", { name: "Edit group E2E Temp Group" }).click();
  await page.getByLabel(/group name/i).fill("E2E Edited Group");
  await page.getByRole("button", { name: /^update group$/i }).click();
  await page.getByText("E2E Edited Group", { exact: true }).waitFor({ timeout: 10000 });

  await page.getByRole("button", { name: /^add target$/i }).click();
  await page.getByLabel(/target name/i).fill("E2E Loopback Target");
  await page.getByLabel(/host \/ ip/i).fill("127.0.0.1");
  await page.getByRole("button", { name: /save & sync to probes/i }).click();
  await page.getByRole("link", { name: "E2E Loopback Target" }).waitFor({ timeout: 10000 });

  // Edit created target
  await page.getByRole("button", { name: "Edit target E2E Loopback Target" }).click();
  await page.getByLabel(/target name/i).fill("E2E Loopback Edited");
  await page.getByLabel(/interval \(seconds\)/i).fill("2");
  await page.getByRole("button", { name: /update & sync to probes/i }).click();
  await page.getByRole("link", { name: "E2E Loopback Edited" }).waitFor({ timeout: 10000 });
  await assertAccessible(page, "/targets (after edit)");

  // Pause and Resume toggle
  await page.getByRole("button", { name: "Pause target E2E Loopback Edited" }).click();
  await page.getByRole("button", { name: "Resume target E2E Loopback Edited" }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Resume target E2E Loopback Edited" }).click();
  await page.getByRole("button", { name: "Pause target E2E Loopback Edited" }).waitFor({ timeout: 10000 });

  // Duplicate/Copy target, verify modal prefill & save, then delete clone via UI
  await page.getByRole("button", { name: "Duplicate target E2E Loopback Edited" }).click();
  await page.getByRole("button", { name: /save & sync to probes/i }).click();
  await page.getByRole("link", { name: "E2E Loopback Edited (Copy)" }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Delete target E2E Loopback Edited (Copy)" }).click();
  await page.getByRole("link", { name: "E2E Loopback Edited (Copy)" }).waitFor({ state: "detached", timeout: 10000 });

  // Create and delete an explicit IPv6 (icmp6) target via UI
  await page.getByRole("button", { name: /^add target$/i }).click();
  await page.getByLabel(/target name/i).fill("E2E IPv6 Loopback");
  await page.getByLabel(/probe protocol/i).selectOption("icmp6");
  await page.getByLabel(/host \/ ip/i).fill("::1");
  await page.getByRole("button", { name: /save & sync to probes/i }).click();
  await page.getByRole("link", { name: "E2E IPv6 Loopback" }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Delete target E2E IPv6 Loopback" }).click();
  await page.getByRole("link", { name: "E2E IPv6 Loopback" }).waitFor({ state: "detached", timeout: 10000 });

  // 4. Open target detail and verify uPlot canvas, 3h/12h ranges, friendly terms, PNG export, and MTR
  await page.getByRole("link", { name: "E2E Loopback Edited" }).click();
  await page.waitForURL(/\/targets\/[0-9a-f-]+/, { timeout: 10000 });
  const targetUrl = page.url();
  const targetId = targetUrl.split("/targets/")[1].split("?")[0];

  await page.locator("canvas.u-over, .uplot canvas").first().waitFor({ timeout: 25000 });
  await page.getByRole("button", { name: "3h", exact: true }).waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "12h", exact: true }).waitFor({ timeout: 5000 });
  await page.getByText("BEST", { exact: true }).first().waitFor({ timeout: 5000 });
  await page.getByText("NORMAL", { exact: true }).first().waitFor({ timeout: 5000 });
  await page.getByText("HIGH", { exact: true }).first().waitFor({ timeout: 5000 });

  // Verify evidence PNG export on target chart panel (clipboard or download fallback on HTTP)
  const targetDownloadPromise = page.waitForEvent("download", { timeout: 5000 }).catch(() => null);
  await page.locator('[data-testid="copy-chart-png-btn"]').first().click();
  const targetDl = await targetDownloadPromise;
  if (targetDl && !targetDl.suggestedFilename().endsWith(".png")) {
    throw new Error(`Unexpected evidence filename: ${targetDl.suggestedFilename()}`);
  }

  // Trigger manual MTR on 127.0.0.1 and verify non-bloated resolved snapshot arrives cleanly
  await page.getByRole("button", { name: /run mtr now/i }).click();
  await page.getByText("MANUAL", { exact: true }).first().waitFor({ timeout: 15000 });
  const mtrRowCount = await page.locator("table tbody tr").count();
  if (mtrRowCount < 1 || mtrRowCount > 5) {
    throw new Error(`Expected concise loopback MTR snapshot (1..5 hops), got ${mtrRowCount}`);
  }

  await assertAccessible(page, "/targets/[id]");

  await page.getByRole("link", { name: /edit target/i }).click();
  await page.getByRole("heading", { name: "Edit Target: E2E Loopback Edited" }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: /cancel/i }).click();

  // 5. Verify /alerts and /settings pages + friendly High Latency label
  await page.goto(`${BASE_URL}/alerts`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /smart quorum alerts/i }).waitFor();
  const highLatOption = await page.locator('option[value="latency_p95"]').textContent();
  if (!highLatOption || !highLatOption.includes("High Latency")) {
    throw new Error(`Expected friendly latency_p95 option label, got: ${highLatOption}`);
  }
  await assertAccessible(page, "/alerts");

  await page.goto(`${BASE_URL}/settings`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /system settings/i }).waitFor();
  await assertAccessible(page, "/settings");

  // 6. Clean up E2E target and E2E group
  await page.evaluate(async (id) => {
    await fetch(`/api/targets/${id}`, { method: "DELETE" });
    const gRes = await fetch("/api/groups");
    if (gRes.ok) {
      const groups = await gRes.json();
      for (const g of groups) {
        if (g.name === "E2E Edited Group" || g.name === "E2E Temp Group") {
          await fetch(`/api/groups/${g.id}`, { method: "DELETE" });
        }
      }
    }
  }, targetId);

  // 7. Verify unauthenticated TV Display (/tv and /display alias) Auto Best-Fit, 1024x768, Landscape 16:9 & Portrait 9:16
  const tvContext = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    acceptDownloads: true,
  });
  const tvPage = await tvContext.newPage();
  tvPage.on("pageerror", (err) => errors.push(`tv pageerror: ${err.message}`));
  tvPage.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(`tv console.error: ${msg.text()}`);
    }
  });

  // 7a. Default Auto Best Fit on /display alias -> redirects cleanly to /tv with query params preserved
  await tvPage.goto(`${BASE_URL}/display?cards=auto`, { waitUntil: "networkidle" });
  await tvPage.waitForURL((u) => u.pathname === "/tv", { timeout: 10000 });
  await tvPage.getByRole("heading", { name: /smoker tv display/i }).waitFor({ timeout: 10000 });
  await tvPage.locator('[data-testid="tv-cards-grid"]').waitFor({ timeout: 10000 });
  await tvPage.locator('[data-testid="tv-target-card"]').first().waitFor({ timeout: 15000 });
  await tvPage.locator('[data-testid="smoke-chart-panel"] .uplot canvas').first().waitFor({ timeout: 20000 });
  await tvPage.locator('[data-testid="tv-legend-bar"]').waitFor({ timeout: 5000 });
  // Default /tv opens without rolling pages automatically (Static mode)
  await tvPage.getByRole("button", { name: "Start rotation" }).waitFor({ timeout: 5000 });

  const autoFhdStats = await tvPage.evaluate(() => {
    const grid = document.querySelector('[data-testid="tv-cards-grid"]');
    const panel = document.querySelector('[data-testid="smoke-chart-panel"]');
    const rect = panel ? panel.getBoundingClientRect() : null;
    return {
      cols: Number(grid?.getAttribute("data-cols") || 0),
      rows: Number(grid?.getAttribute("data-rows") || 0),
      ratio: rect ? rect.width / Math.max(1, rect.height) : 0,
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
      overflowY: document.documentElement.scrollHeight > window.innerHeight,
    };
  });
  if (
    autoFhdStats.cols !== 4 ||
    autoFhdStats.ratio < 1.85 ||
    autoFhdStats.ratio > 2.85 ||
    autoFhdStats.overflowX ||
    autoFhdStats.overflowY
  ) {
    throw new Error(`Unexpected 1920x1080 Auto 7:3 layout: ${JSON.stringify(autoFhdStats)}`);
  }

  // 7b. Verify 1024x768 monitor responsiveness (2-col balanced ~7:3 panels, no clipped header/overflow)
  await tvPage.setViewportSize({ width: 1024, height: 768 });
  await tvPage.waitForFunction(
    () => document.querySelector('[data-testid="tv-cards-grid"]')?.getAttribute("data-cols") === "2",
    { timeout: 5000 }
  );
  const xgaStats = await tvPage.evaluate(() => {
    const grid = document.querySelector('[data-testid="tv-cards-grid"]');
    const panel = document.querySelector('[data-testid="smoke-chart-panel"]');
    const header = document.querySelector("header");
    const rect = panel ? panel.getBoundingClientRect() : null;
    const hRect = header ? header.getBoundingClientRect() : null;
    return {
      cols: Number(grid?.getAttribute("data-cols") || 0),
      rows: Number(grid?.getAttribute("data-rows") || 0),
      ratio: rect ? rect.width / Math.max(1, rect.height) : 0,
      headerHeight: hRect ? hRect.height : 0,
      headerRight: hRect ? hRect.right : 0,
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
      overflowY: document.documentElement.scrollHeight > window.innerHeight,
    };
  });
  if (
    xgaStats.cols !== 2 ||
    xgaStats.ratio < 1.85 ||
    xgaStats.ratio > 2.85 ||
    xgaStats.headerHeight > 52 ||
    xgaStats.headerRight > 1025 ||
    xgaStats.overflowX ||
    xgaStats.overflowY
  ) {
    throw new Error(`Unexpected 1024x768 monitor TV layout: ${JSON.stringify(xgaStats)}`);
  }
  await assertAccessible(tvPage, "/tv (1024x768 Balanced 7:3)");

  // Verify Configure TV drawer keeps OK button pinned in viewport on 1024x768 without scrolling
  await tvPage.getByRole("button", { name: "Configure TV Display" }).click();
  await tvPage.getByRole("heading", { name: /tv display configuration/i }).waitFor({ timeout: 5000 });
  const okBox1024 = await tvPage.evaluate(() => {
    const btn = document.querySelector('[data-testid="tv-config-ok-btn"]');
    const rect = btn ? btn.getBoundingClientRect() : null;
    return rect ? { top: rect.top, bottom: rect.bottom, vh: window.innerHeight } : null;
  });
  if (!okBox1024 || okBox1024.top < 0 || okBox1024.bottom > okBox1024.vh) {
    throw new Error(`Expected OK button pinned without scroll at 1024x768, got: ${JSON.stringify(okBox1024)}`);
  }
  await tvPage.getByRole("button", { name: /^ok$/i }).click();

  // 7c. Switch back to 1920x1080 with manual ?cards=6 override and test range/export/spotlight/portrait
  await tvPage.setViewportSize({ width: 1920, height: 1080 });
  await tvPage.goto(`${BASE_URL}/tv?orientation=landscape&cards=6&rotate=15`, {
    waitUntil: "networkidle",
  });
  await tvPage.getByRole("heading", { name: /smoker tv display/i }).waitFor({ timeout: 10000 });
  await tvPage.locator('[data-testid="tv-cards-grid"]').waitFor({ timeout: 10000 });
  await tvPage.locator('[data-testid="tv-target-card"]').first().waitFor({ timeout: 15000 });
  await tvPage.locator('[data-testid="smoke-chart-panel"] .uplot canvas').first().waitFor({ timeout: 20000 });
  await tvPage.locator('[data-testid="tv-legend-bar"]').waitFor({ timeout: 5000 });
  // Explicit ?rotate=15 enables rolling timer -> Pause rotation control visible
  await tvPage.getByRole("button", { name: "Pause rotation" }).waitFor({ timeout: 5000 });

  // Verify tall SmokePing graph canvas on TV (>= 72px vs old 28px sparklines) & ~7:3 panel proportion
  const tvCanvasBox = await tvPage.locator('[data-testid="smoke-chart-panel"] .uplot canvas').first().boundingBox();
  if (!tvCanvasBox || tvCanvasBox.height < 70) {
    throw new Error(`Expected tall SmokePing canvas on /tv (>=70px), got: ${JSON.stringify(tvCanvasBox)}`);
  }

  // Verify header clock displays 24h time with full date detail (no AM/PM)
  const headerText = await tvPage.locator("header").innerText();
  if (!/\d{2} [A-Z][a-z]{2} \d{4} · \d{2}:\d{2}:\d{2}/.test(headerText) || /\b(am|pm)\b/i.test(headerText)) {
    throw new Error(`Expected 24h dated clock in TV header, got: ${headerText}`);
  }

  // Verify TV Range selector defaults to 3h, switches to 6h, and persists in Kiosk URL
  const defaultRangeBtn = tvPage.locator('[data-testid="tv-range-selector"] button', { hasText: "3h" });
  if ((await defaultRangeBtn.getAttribute("aria-pressed")) !== "true") {
    throw new Error("Expected /tv range selector to default to 3h");
  }
  await tvPage.locator('[data-testid="tv-range-selector"] button', { hasText: "6h" }).click();
  await tvPage.waitForFunction(() => window.location.search.includes("range=6h"), { timeout: 5000 });

  // Verify TV Copy-PNG button works cleanly and omits probe name from evidence filename
  const tvDownloadPromise = tvPage.waitForEvent("download", { timeout: 5000 }).catch(() => null);
  await tvPage.locator('[data-testid="copy-chart-png-btn"]').first().click();
  const tvDownload = await tvDownloadPromise;
  if (tvDownload && tvDownload.suggestedFilename().includes("local-central-probe")) {
    throw new Error(`PNG filename must omit probe info, got: ${tvDownload.suggestedFilename()}`);
  }

  // Verify admin /api/matrix remains 401 without session cookie while /api/tv/matrix & /api/tv/series are 200
  const adminRes = await tvContext.request.get(`${BASE_URL}/api/matrix`);
  const tvRes = await tvContext.request.get(`${BASE_URL}/api/tv/matrix`);
  const tvSerRes = await tvContext.request.get(`${BASE_URL}/api/tv/series?range=3h`);
  if (adminRes.status() !== 401 || tvRes.status() !== 200 || tvSerRes.status() !== 200) {
    throw new Error(
      `Unexpected TV auth boundary: admin=${adminRes.status()} tv=${tvRes.status()} tvSeries=${tvSerRes.status()}`
    );
  }
  const landscapeOverflowY = await tvPage.evaluate(
    () => document.documentElement.scrollHeight > window.innerHeight
  );
  if (landscapeOverflowY) {
    throw new Error("Landscape /tv overflowed viewport height");
  }
  await assertAccessible(tvPage, "/tv (Landscape 16:9 Regular Grid)");

  // Verify Quick Search & Filter bar on /tv
  await tvPage.locator('[data-testid="tv-search-toggle-btn"]').click();
  await tvPage.locator('[data-testid="tv-search-bar"]').waitFor({ timeout: 5000 });
  await tvPage.locator('[data-testid="tv-search-input"]').fill("Google");
  await assertAccessible(tvPage, "/tv (Quick Search Bar)");
  await tvPage.getByRole("button", { name: /^reset$/i }).click();
  await tvPage.getByRole("button", { name: "Close search bar" }).click();

  // Verify clicking Zoom on a TV card opens the full Target Zoom & MTR Inspector Modal
  await tvPage.locator('[data-testid="zoom-chart-btn"]').first().click();
  await tvPage.locator('[data-testid="tv-zoom-modal"]').waitFor({ timeout: 5000 });
  await tvPage.locator('[data-testid="tv-zoom-range-selector"]').waitFor({ timeout: 5000 });
  await tvPage.getByRole("heading", { name: /mtr \/ hop-by-hop diagnostics/i }).waitFor({ timeout: 5000 });
  await assertAccessible(tvPage, "/tv (Target Zoom Modal)");
  await tvPage.locator('[data-testid="tv-zoom-close-btn"]').click();
  await tvPage.locator('[data-testid="tv-zoom-modal"]').waitFor({ state: "detached", timeout: 5000 });

  // Trigger 30s High-Latency Simulation from TV Display Config Drawer and verify Event-Driven Auto-Switch to Highlight Page
  await tvPage.getByRole("button", { name: "Configure TV Display" }).click();
  await tvPage.getByRole("heading", { name: /tv display configuration/i }).waitFor({ timeout: 5000 });
  await assertAccessible(tvPage, "/tv (Config Drawer)");
  await tvPage.locator('[data-testid="tv-simulate-spike-btn"]').click();

  await tvPage.locator('[data-testid="tv-highlight-page"]').waitFor({ timeout: 10000 });
  await tvPage.locator('[data-testid="tv-highlight-card"]').first().waitFor({ timeout: 10000 });
  await tvPage.locator('[data-testid="tv-highlight-probe-row"]').first().waitFor({ timeout: 10000 });
  const legendText = await tvPage.locator('[data-testid="tv-legend-bar"]').innerText();
  if (!legendText.includes("WARN")) {
    throw new Error(`Expected WARN entry in TV legend bar, got: ${legendText}`);
  }
  const highlightPanelStats = await tvPage.evaluate(() => {
    const p = document.querySelector('[data-testid="tv-highlight-card"] [data-testid="smoke-chart-panel"]');
    const r = p ? p.getBoundingClientRect() : null;
    const hasWarnBadge = Boolean(p && p.textContent && p.textContent.includes("WARN"));
    return r ? { w: r.width, h: r.height, ratio: r.width / Math.max(1, r.height), hasWarnBadge } : null;
  });
  if (
    !highlightPanelStats ||
    highlightPanelStats.ratio < 1.85 ||
    highlightPanelStats.ratio > 2.85 ||
    !highlightPanelStats.hasWarnBadge
  ) {
    throw new Error(`Highlight card graph should lock ~7:3 with WARN badge: ${JSON.stringify(highlightPanelStats)}`);
  }
  await assertAccessible(tvPage, "/tv (Highlight Spotlight Page)");

  // Clear simulation, switch to Auto Best Fit & Portrait (9:16), verify URL query sync & portrait viewport fit
  await tvPage.getByRole("button", { name: "Configure TV Display" }).click();
  await tvPage.locator('[data-testid="tv-simulate-clear-btn"]').click();
  await tvPage.locator('[data-testid="tv-cards-auto-btn"]').click();
  await tvPage.getByRole("button", { name: /portrait \(9:16\)/i }).click();
  await tvPage.getByRole("button", { name: /^ok$/i }).click();

  await tvPage.setViewportSize({ width: 1080, height: 1920 });
  await tvPage.waitForFunction(
    () => document.querySelector('[data-testid="tv-cards-grid"]')?.getAttribute("data-cols") === "2",
    { timeout: 5000 }
  );
  const portraitCheck = await tvPage.evaluate(() => {
    const p = document.querySelector('[data-testid="smoke-chart-panel"]');
    const r = p ? p.getBoundingClientRect() : null;
    return {
      search: window.location.search,
      orientation: document.querySelector('[data-testid="noc-tv-root"]')?.getAttribute("data-orientation"),
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
      overflowY: document.documentElement.scrollHeight > window.innerHeight,
      ratio: r ? r.width / Math.max(1, r.height) : 0,
    };
  });
  if (
    !portraitCheck.search.includes("orientation=portrait") ||
    !portraitCheck.search.includes("cards=auto") ||
    portraitCheck.orientation !== "portrait"
  ) {
    throw new Error(`Portrait config did not sync to URL/DOM: ${JSON.stringify(portraitCheck)}`);
  }
  if (portraitCheck.overflowX || portraitCheck.overflowY || portraitCheck.ratio < 1.85 || portraitCheck.ratio > 2.85) {
    throw new Error(`Portrait /tv failed 7:3 or overflow check: ${JSON.stringify(portraitCheck)}`);
  }
  await assertAccessible(tvPage, "/tv (Portrait 9:16)");
  await tvContext.close();

  if (errors.length > 0) {
    throw new Error(`Browser errors detected:\n${errors.join("\n")}`);
  }

  console.log("E2E_ALL_PASSED");
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
