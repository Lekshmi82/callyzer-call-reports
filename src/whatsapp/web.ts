import fs from "node:fs";
import path from "node:path";
import QRCode from "qrcode";
import wweb from "whatsapp-web.js";
import type { Logger } from "../logger.js";

const { Client, LocalAuth, MessageMedia } = wweb;

export type WaState = "starting" | "qr" | "ready" | "disconnected" | "auth_failure";

/**
 * WhatsApp Web session (whatsapp-web.js) for posting the report into a group.
 * The login is saved under DATA_DIR/wwebjs so it survives restarts (needs a persistent volume).
 */
export class WhatsAppGroupSender {
  state: WaState = "starting";
  qrDataUrl: string | null = null;
  me: string | null = null;
  lastError: string | null = null;
  private client: InstanceType<typeof Client> | null = null;
  private restarting = false;

  constructor(
    private readonly dataDir: string,
    private readonly executablePath: string | undefined,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    const sessionDir = path.join(this.dataDir, "wwebjs");
    removeStaleChromeLocks(sessionDir);
    const client = new Client({
      authStrategy: new LocalAuth({ dataPath: sessionDir }),
      puppeteer: {
        headless: true,
        executablePath: this.executablePath,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run"],
      },
    });
    this.client = client;
    this.state = "starting";

    client.on("qr", async (qr: string) => {
      this.state = "qr";
      this.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      this.log.info("WhatsApp needs login: open the status page and scan the QR code");
    });
    client.on("authenticated", () => this.log.info("WhatsApp authenticated"));
    client.on("ready", () => {
      this.state = "ready";
      this.qrDataUrl = null;
      this.lastError = null;
      const wid = client.info?.wid?.user ?? "";
      this.me = wid ? `••••${wid.slice(-4)}` : null;
      this.log.info({ me: this.me }, "WhatsApp ready");
    });
    client.on("auth_failure", (msg: string) => {
      this.state = "auth_failure";
      this.lastError = `Login failed: ${msg}`;
      this.log.error({ msg }, "WhatsApp auth failure");
    });
    client.on("disconnected", (reason: string) => {
      this.state = "disconnected";
      this.lastError = `Disconnected: ${reason}`;
      this.log.warn({ reason }, "WhatsApp disconnected; restarting session in 30s");
      void this.restart(30_000);
    });

    try {
      await client.initialize();
    } catch (e) {
      this.state = "disconnected";
      this.lastError = `Could not start WhatsApp: ${(e as Error).message}`;
      this.log.error({ err: (e as Error).message }, "WhatsApp initialize failed; retrying in 60s");
      void this.restart(60_000);
    }
  }

  private async restart(delayMs: number): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      await this.client?.destroy().catch(() => undefined);
    } finally {
      this.restarting = false;
    }
    await this.start();
  }

  /** Logs the WhatsApp account out (removes the saved session) — a new QR scan is then required. */
  async logout(): Promise<void> {
    await this.client?.logout().catch(() => undefined);
  }

  async groupNames(): Promise<string[]> {
    if (this.state !== "ready" || !this.client) return [];
    const chats = await this.client.getChats();
    return chats.filter((c) => c.isGroup).map((c) => c.name).sort((a, b) => a.localeCompare(b));
  }

  /** Posts the PNG with a caption into the group with this exact name (case-insensitive). */
  async sendToGroup(groupName: string, png: Buffer, caption: string, filename: string): Promise<void> {
    if (this.state !== "ready" || !this.client) throw new Error(`WhatsApp is not connected (state: ${this.state})`);
    if (!groupName.trim()) throw new Error("Group name is not configured");
    const chats = await this.client.getChats();
    const wanted = groupName.trim().toLowerCase();
    const group = chats.find((c) => c.isGroup && c.name.trim().toLowerCase() === wanted);
    if (!group) throw new Error(`WhatsApp group "${groupName}" not found for this number (check the exact name on the status page)`);
    const media = new MessageMedia("image/png", png.toString("base64"), filename);
    await this.client.sendMessage(group.id._serialized, media, { caption });
  }

  async stop(): Promise<void> {
    await this.client?.destroy().catch(() => undefined);
  }
}

/** Chromium refuses to start if a previous container left its profile lock behind. */
function removeStaleChromeLocks(dir: string): void {
  if (!fs.existsSync(dir)) return;
  const walk = (d: string, depth: number) => {
    if (depth > 4) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.name === "SingletonLock" || e.name === "SingletonSocket" || e.name === "SingletonCookie") fs.rmSync(p, { force: true });
      else if (e.isDirectory()) walk(p, depth + 1);
    }
  };
  walk(dir, 0);
}
