import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { getConfigDir } from "./store";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_FILENAME = "master.key";

let masterKey: Buffer | null = null;

async function getMasterKey(): Promise<Buffer> {
  if (masterKey) return masterKey;
  const keyPath = join(getConfigDir(), KEY_FILENAME);
  try {
    const raw = await fs.readFile(keyPath);
    if (raw.length === 32) {
      masterKey = raw;
      return masterKey;
    }
  } catch {
    // Generate new master key
  }

  masterKey = randomBytes(32);
  await fs.mkdir(dirname(keyPath), { recursive: true });
  // Set restricted permissions on key file if possible
  await fs.writeFile(keyPath, masterKey);
  if (process.platform !== "win32") {
    await fs.chmod(keyPath, 0o600).catch(() => {});
  }
  return masterKey;
}

export async function encryptSecret(plainText: string): Promise<string> {
  const key = await getMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv:tag:ciphertext (base64 encoded parts)
  return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export async function decryptSecret(cipherText: string): Promise<string> {
  const parts = cipherText.split(":");
  if (parts.length !== 3) {
    // Fallback if it was stored as plain text previously
    return cipherText;
  }
  const key = await getMasterKey();
  const iv = Buffer.from(parts[0]!, "base64");
  const tag = Buffer.from(parts[1]!, "base64");
  const ciphertext = Buffer.from(parts[2]!, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf-8");
}
