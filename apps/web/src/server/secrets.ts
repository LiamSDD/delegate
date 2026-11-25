import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { z } from "zod";

const KEY_PATTERN = /^[0-9a-fA-F]{64}$/;
const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export const ENCRYPTION_KEY_MISSING_MESSAGE =
  "Connector secrets cannot be stored because DELEGATE_ENCRYPTION_KEY is not set (generate one with `openssl rand -hex 32`). Connectors without a secret still work.";

export class SecretStoreError extends Error {
  override readonly name = "SecretStoreError";
}

export interface SecretBox {
  seal(plaintext: string, context: string): string;
  open(sealed: string, context: string): string;
}

const envSchema = z.object({ DELEGATE_ENCRYPTION_KEY: z.string().optional() });

export function encryptionKeyFrom(env: Record<string, string | undefined>): Buffer | null {
  const raw = envSchema.parse(env).DELEGATE_ENCRYPTION_KEY?.trim() ?? "";
  if (raw === "") return null;
  if (!KEY_PATTERN.test(raw))
    throw new SecretStoreError(
      "DELEGATE_ENCRYPTION_KEY must be 64 hex characters (32 bytes); generate it with `openssl rand -hex 32`.",
    );
  return Buffer.from(raw, "hex");
}

export function createSecretBox(key: Buffer): SecretBox {
  if (key.length !== 32) throw new SecretStoreError("The encryption key must be 32 bytes.");
  return {
    seal(plaintext, context) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(Buffer.from(context, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [VERSION, iv, cipher.getAuthTag(), ciphertext]
        .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
        .join(".");
    },
    open(sealed, context) {
      const [version, iv, tag, ciphertext, ...rest] = sealed.split(".");
      if (
        version !== VERSION ||
        iv === undefined ||
        tag === undefined ||
        ciphertext === undefined ||
        rest.length > 0
      )
        throw new SecretStoreError("The stored secret has an unknown format.");
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"), {
          authTagLength: TAG_BYTES,
        });
        decipher.setAAD(Buffer.from(context, "utf8"));
        decipher.setAuthTag(Buffer.from(tag, "base64url"));
        return Buffer.concat([
          decipher.update(Buffer.from(ciphertext, "base64url")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw new SecretStoreError(
          "The stored secret could not be decrypted with the current key.",
        );
      }
    },
  };
}

export function secretBoxFromEnv(env: Record<string, string | undefined>): SecretBox | null {
  const key = encryptionKeyFrom(env);
  return key === null ? null : createSecretBox(key);
}
