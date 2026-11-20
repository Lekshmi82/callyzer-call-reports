import crypto from "node:crypto";

/**
 * Cryptographic helpers. The master key comes only from APP_ENCRYPTION_KEY;
 * sub-keys are derived per purpose so one key can't be misused for another job.
 */
export class Crypto {
  private readonly encKey: Buffer;
  private readonly hmacKey: Buffer;
  private readonly urlKey: Buffer;

  constructor(masterKey: string) {
    if (masterKey.length < 32) throw new Error("APP_ENCRYPTION_KEY too short");
    const derive = (purpose: string) =>
      Buffer.from(crypto.hkdfSync("sha256", Buffer.from(masterKey, "utf8"), Buffer.alloc(0), purpose, 32));
    this.encKey = derive("secrets-aes-256-gcm");
    this.hmacKey = derive("phone-number-hmac");
    this.urlKey = derive("signed-media-url");
  }

  /** AES-256-GCM. Output: v1:<iv>:<tag>:<ciphertext> (base64url). */
  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.encKey, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(":");
  }

  decrypt(payload: string): string {
    const [v, iv, tag, ct] = payload.split(":");
    if (v !== "v1" || !iv || !tag || ct === undefined) throw new Error("Unrecognised secret format");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.encKey, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
  }

  /** Stable keyed hash for phone numbers (used for de-duplication and mapping, never reversible). */
  phoneKey(normalisedNumber: string): string {
    return crypto.createHmac("sha256", this.hmacKey).update(normalisedNumber).digest("base64url").slice(0, 32);
  }

  signUrl(pathname: string, expiresAtSec: number): string {
    return crypto.createHmac("sha256", this.urlKey).update(`${pathname}|${expiresAtSec}`).digest("base64url");
  }

  verifyUrl(pathname: string, expiresAtSec: number, sig: string): boolean {
    if (!Number.isFinite(expiresAtSec) || expiresAtSec * 1000 < Date.now()) return false;
    return safeEqual(this.signUrl(pathname, expiresAtSec), sig);
  }
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// ---- Password hashing (scrypt; no native dependencies) ----
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[4]!, "base64url");
  const expected = Buffer.from(parts[5]!, "base64url");
  const key = await scrypt(password, salt);
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}
