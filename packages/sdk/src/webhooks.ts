import {
  type UnknownWebhookEvent,
  UnknownWebhookEventSchema,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_HEADERS,
  WEBHOOK_SIGNATURE_VERSION,
  WEBHOOK_TEST_EVENT_TYPE,
  WEBHOOK_TOLERANCE_SECONDS,
  type WebhookEvent,
  WebhookEventSchema,
} from "./contract/webhooks";

export type WebhookVerificationFailure =
  | "missing_headers"
  | "malformed_timestamp"
  | "malformed_signature"
  | "timestamp_out_of_tolerance"
  | "signature_mismatch"
  | "malformed_body";

export class WebhookVerificationError extends Error {
  override readonly name = "WebhookVerificationError";
  constructor(
    readonly reason: WebhookVerificationFailure,
    message: string,
  ) {
    super(message);
  }
}

const TIMESTAMP_PATTERN = /^[0-9]{1,12}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;
const KNOWN_TYPES: ReadonlySet<string> = new Set([...WEBHOOK_EVENT_TYPES, WEBHOOK_TEST_EVENT_TYPE]);
const encoder = new TextEncoder();

type Bytes = Uint8Array<ArrayBuffer>;

function toBytes(text: string): Bytes {
  return new Uint8Array(encoder.encode(text));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Bytes {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function signedContent(timestamp: string, body: Uint8Array): Bytes {
  const prefix = encoder.encode(`${timestamp}.`);
  const content = new Uint8Array(prefix.byteLength + body.byteLength);
  content.set(prefix, 0);
  content.set(body, prefix.byteLength);
  return content;
}

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", toBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    usage,
  ]);
}

export async function signWebhookPayload(
  secret: string,
  timestampSeconds: number,
  body: string,
): Promise<string> {
  if (!Number.isInteger(timestampSeconds) || timestampSeconds < 0)
    throw new TypeError("The webhook timestamp must be whole seconds since the Unix epoch.");
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    signedContent(String(timestampSeconds), encoder.encode(body)),
  );
  return `${WEBHOOK_SIGNATURE_VERSION}=${toHex(new Uint8Array(mac))}`;
}

export type WebhookHeaders = Headers | Record<string, string | readonly string[] | undefined>;

function header(headers: WebhookHeaders, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (value === undefined) return null;
    return typeof value === "string" ? value : value.join(",");
  }
  return null;
}

export interface VerifyWebhookInput {
  payload: string | Uint8Array | ArrayBuffer;
  headers: WebhookHeaders;
  secret: string | readonly string[];
  toleranceSeconds?: number;
  now?: () => number;
}

function candidateSignatures(value: string): Bytes[] {
  const prefix = `${WEBHOOK_SIGNATURE_VERSION}=`;
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix))
    .map((part) => part.slice(prefix.length))
    .filter((hex) => SIGNATURE_PATTERN.test(hex))
    .map(fromHex);
}

export async function verifyWebhook(
  input: VerifyWebhookInput,
): Promise<WebhookEvent | UnknownWebhookEvent> {
  const timestamp = header(input.headers, WEBHOOK_HEADERS.timestamp);
  const signature = header(input.headers, WEBHOOK_HEADERS.signature);
  if (timestamp === null || signature === null)
    throw new WebhookVerificationError(
      "missing_headers",
      `The ${WEBHOOK_HEADERS.timestamp} and ${WEBHOOK_HEADERS.signature} headers are required.`,
    );
  if (!TIMESTAMP_PATTERN.test(timestamp))
    throw new WebhookVerificationError(
      "malformed_timestamp",
      "The timestamp header is not whole seconds since the Unix epoch.",
    );
  const tolerance = input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((input.now?.() ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > tolerance)
    throw new WebhookVerificationError(
      "timestamp_out_of_tolerance",
      `The delivery was signed more than ${tolerance} seconds from now, so it may be a replay.`,
    );
  const candidates = candidateSignatures(signature);
  if (candidates.length === 0)
    throw new WebhookVerificationError(
      "malformed_signature",
      `The signature header carries no ${WEBHOOK_SIGNATURE_VERSION}= value of 64 hex characters.`,
    );
  const body =
    typeof input.payload === "string"
      ? encoder.encode(input.payload)
      : input.payload instanceof Uint8Array
        ? input.payload
        : new Uint8Array(input.payload);
  const content = signedContent(timestamp, body);
  const secrets = typeof input.secret === "string" ? [input.secret] : input.secret;
  let matched = false;
  for (const secret of secrets) {
    const key = await hmacKey(secret, "verify");
    for (const candidate of candidates)
      if (await crypto.subtle.verify("HMAC", key, candidate, content)) matched = true;
  }
  if (!matched)
    throw new WebhookVerificationError(
      "signature_mismatch",
      "No signature matches this body, timestamp and secret.",
    );
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new WebhookVerificationError("malformed_body", "The signed body is not JSON.");
  }
  const envelope = UnknownWebhookEventSchema.safeParse(json);
  if (!envelope.success)
    throw new WebhookVerificationError(
      "malformed_body",
      "The signed body is not a Delegate webhook event.",
    );
  if (!KNOWN_TYPES.has(envelope.data.type)) return envelope.data;
  const known = WebhookEventSchema.safeParse(json);
  if (!known.success)
    throw new WebhookVerificationError(
      "malformed_body",
      `The signed body does not match the ${envelope.data.type} event.`,
    );
  return known.data;
}

export function isKnownWebhookEvent(
  event: WebhookEvent | UnknownWebhookEvent,
): event is WebhookEvent {
  return KNOWN_TYPES.has(event.type);
}
