import { chromium, type Browser } from "playwright";
import type { Logger } from "../logger.js";

export interface PngRenderer {
  renderPng(htmlDoc: string): Promise<{ png: Buffer; width: number; height: number }>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Renders inside an already-running Puppeteer browser (the one whatsapp-web.js uses), so the
 * service needs only one Chromium in memory.
 */
export class PuppeteerPageRenderer implements PngRenderer {
  constructor(private readonly getBrowser: () => any) {}

  async renderPng(htmlDoc: string): Promise<{ png: Buffer; width: number; height: number }> {
    const browser = this.getBrowser();
    if (!browser) throw new Error("Browser not available");
    const page = await browser.newPage();
    try {
      await page.setJavaScriptEnabled(false);
      await page.setRequestInterception(true);
      page.on("request", (req: any) => (req.url().startsWith("data:") || req.url() === "about:blank" ? req.continue() : req.abort()));
      await page.setViewport({ width: 860, height: 600, deviceScaleFactor: 2 });
      await page.setContent(htmlDoc, { waitUntil: "load", timeout: 30_000 });
      const el = await page.$("#report");
      if (!el) throw new Error("Report element missing");
      const box = await el.boundingBox();
      const png = Buffer.from(await el.screenshot({ type: "png" }));
      return { png, width: Math.round((box?.width ?? 800) * 2), height: Math.round((box?.height ?? 0) * 2) };
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Renders report HTML to PNG with headless Chromium. One browser is shared and
 * relaunched automatically if it crashes; each render uses a fresh, isolated context
 * with JavaScript and network disabled (the HTML is fully self-contained).
 */
export class ReportRenderer implements PngRenderer {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;

  constructor(
    private readonly log: Logger,
    private readonly executablePath?: string,
  ) {}

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (!this.launching) {
      this.launching = chromium
        .launch({ headless: true, executablePath: this.executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] })
        .then((b) => {
          this.browser = b;
          b.on("disconnected", () => {
            this.browser = null;
          });
          return b;
        })
        .finally(() => {
          this.launching = null;
        });
    }
    return this.launching;
  }

  async renderPng(htmlDoc: string): Promise<{ png: Buffer; width: number; height: number }> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 860, height: 600 }, javaScriptEnabled: false });
    try {
      await context.route("**/*", (route) => route.abort()); // no network access from report HTML
      const page = await context.newPage();
      await page.setContent(htmlDoc, { waitUntil: "load", timeout: 30_000 });
      const el = await page.$("#report");
      if (!el) throw new Error("Report element missing");
      const png = await el.screenshot({ type: "png", timeout: 30_000 });
      const box = await el.boundingBox();
      return { png, width: Math.round((box?.width ?? 800) * 2), height: Math.round((box?.height ?? 0) * 2) };
    } finally {
      await context.close().catch((e) => this.log.warn({ err: String(e) }, "failed to close render context"));
    }
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }
}
