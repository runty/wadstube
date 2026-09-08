import test from "node:test";
import assert from "node:assert/strict";
import { preview } from "vite";
import { chromium, firefox, webkit } from "playwright";
import AxeBuilder from "@axe-core/playwright";

// Uses the production build and intercepted synthetic APIs, never real accounts.
test("desktop/phone reader, native dialogs, sharing and install metadata", { timeout: 180000 }, async t => {
  const server = await preview({ preview: { host: "127.0.0.1", port: 0, open: false } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  t.after(() => server.httpServer.close());
  const engine = process.env.BROWSER || "chromium";
  const browser = await ({ chromium, firefox, webkit }[engine]).launch({ executablePath: process.env.BROWSER_EXECUTABLE });
  t.after(() => browser.close());
  for (const [width, height] of [[1440, 900], [390, 844], [844, 390], [320, 568], [720, 450]]) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 900, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "share", { configurable: true, value: async data => { window.sharedLink = data; } });
    });
    const videos = Array.from({ length: 40 }, (_, i) => ({ video_id: `video${i}`, channel_id: "UCaaaaaaaaaaaaaaaaaaaaaa", title: `Fixture video ${i}`, channel: "Fixture channel", description: "Synthetic description", published: "2026-09-07T12:00:00Z", thumbnail: "/wads.png", url: `https://www.youtube.com/watch?v=fixture${i}`, watched: false, starred: false, hidden: false }));
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      let data = [];
      if (url.pathname === "/api/folders") data = [{ id: "fixture", name: "Fixture folder", channels: [], children: [] }];
      if (url.pathname === "/api/videos") data = { videos: videos.filter(v => !url.searchParams.get("q") || v.title.includes(url.searchParams.get("q"))), hasMore: false };
      if (url.pathname.endsWith("/state")) {
        const video = videos.find(v => url.pathname.includes(`/${v.video_id}/`));
        Object.assign(video, route.request().postDataJSON()); data = { state: video };
      }
      if (url.pathname.includes("returns")) data = { count: 0, videoIds: [] };
      if (url.pathname === "/api/status/quota") data = { used: 0, limit: 10000, remaining: 10000 };
      if (url.pathname === "/api/status/refresh") data = { refreshing: false };
      return route.fulfill({ json: data });
    });
    await page.goto(origin + "/?folder=__all__");
    await page.locator(".card").first().waitFor();
    await page.getByRole("combobox", { name: "Show videos", exact: true }).selectOption("all");
    assert.equal(await page.locator('link[rel="manifest"]').getAttribute("href"), "/manifest.webmanifest");
    const manifest = await (await context.request.get(origin + "/manifest.webmanifest")).json();
    assert.equal(manifest.display, "standalone");
    for (const icon of manifest.icons) assert((await context.request.get(origin + icon.src)).ok());
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      for (const density of width <= 640 ? ["Grid", "List"] : ["Grid", "List", "Compact grid"]) {
        await page.getByRole("button", { name: density, exact: true }).click();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width} ${density} overflow`);
        const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
        assert.deepEqual(axe.violations.map(v => v.id), [], `${width} ${theme} ${density}`);
      }
    }
    if (width <= 640) assert.equal(await page.getByRole("button", { name: "Compact grid", exact: true }).count(), 0);
    if (width < 900) {
      assert.equal(await page.locator("aside").evaluate(el => el.inert), true);
      await page.getByRole("button", { name: "Toggle folders", exact: true }).click();
      await page.locator("aside .root").first().focus();
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("aside").evaluate(el => el.inert), true);
      assert(await page.getByRole("button", { name: "Toggle folders", exact: true }).evaluate(el => el === document.activeElement));
      assert.equal(await page.locator(".search").evaluate(el => getComputedStyle(el).fontSize), "16px");
      assert((await page.locator(".card .actions button").first().boundingBox()).height >= 44);
    }
    await page.locator(".card .actions").first().getByRole("button", { name: "Share", exact: true }).click();
    assert.equal(await page.evaluate(() => window.sharedLink.url), videos[0].url);
    await page.locator(".card .actions").first().getByRole("button", { name: "Watched", exact: true }).click();
    await page.locator(".card .actions").first().getByRole("button", { name: "Unread", exact: true }).waitFor();
    await page.locator(".search").fill("Fixture video 3");
    await page.waitForFunction(() => document.querySelectorAll(".card").length === 11);
    await page.locator(".search").fill("");
    const settings = page.getByTitle("Settings", { exact: true });
    await settings.click();
    await page.locator("#settings-popover").getByRole("button", { name: "Channel health", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Channel health", exact: true });
    await dialog.waitFor();
    assert(await dialog.evaluate(el => el.matches(":modal")));
    await page.evaluate(() => document.querySelector(".search").focus());
    assert(await page.evaluate(() => !!document.activeElement.closest("dialog")), "background must be inert");
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      assert(await page.evaluate(() => !!document.activeElement.closest("dialog")));
    }
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert(await settings.evaluate(el => document.activeElement === el));
    assert.deepEqual(errors, []);
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tube-${width}.png` });
    t.diagnostic(`${engine}: ${width}x${height} passed`);
    await context.close();
  }
});
