import { type RunEventDraft } from "../events";

export type PiiKind = "email" | "phone" | "card" | "iban";

export interface Redaction {
  text: string;
  count: number;
}

const FILE_EXTENSION_TLDS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico"]);

const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/gi;
const IBAN_COUNTRIES = new Set(
  (
    "AD AE AL AT AZ BA BE BG BH BI BR BY CH CR CY CZ DE DJ DK DO EE EG ES FI FK FO FR GB GE GI GL GR " +
    "GT HR HU IE IL IQ IS IT JO KW KZ LB LC LI LT LU LV LY MC MD ME MK MN MR MT MU NI NL NO OM PK PL " +
    "PS PT QA RO RS RU SA SC SD SE SI SK SM SO ST SV TL TN TR UA VA VG XK YE"
  ).split(" "),
);
const CARD = /(?<![\d.,])\d(?:[ -]?\d){12,18}(?![\d.,]*\d)/g;
const EMAIL = /(?<![\w.%+-])[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.([A-Za-z]{2,24})\b/g;
const INTERNATIONAL_PHONE = /(?<![\w+])\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,6}(?![\d.]*\d)/g;
const NATIONAL_PHONE =
  /(?<![\w.,/:-])(?:\(\d{2,4}\) ?\d{3,4}[ -]?\d{3,4}|0\d{1,4}[ -]\d{3,4}[ -]?\d{3,4})(?![\w.,/:-]*\d)/g;
const NANP_PHONE =
  /(?<![\w.,/:-])(?:1[ .-]?)?(?:\([2-9]\d{2}\) ?|[2-9]\d{2}[ .-])[2-9]\d{2}[ .-]\d{4}(?![\w.,/:-]*\d)/g;

const CARD_PREFIX = /^(?:4|5[1-5]|2[2-7]|3[47]|3[068]|35|6011|64[4-9]|65|62)/;

function digitsOf(text: string): string {
  return text.replace(/\D/g, "");
}

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

export function ibanValid(candidate: string): boolean {
  const compact = candidate.replace(/ /g, "").toUpperCase();
  if (compact.length < 15 || compact.length > 34) return false;
  if (!IBAN_COUNTRIES.has(compact.slice(0, 2))) return false;
  const rearranged = `${compact.slice(4)}${compact.slice(0, 4)}`;
  let remainder = 0;
  for (const char of rearranged) {
    const value = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

function isCard(candidate: string): boolean {
  const digits = digitsOf(candidate);
  return (
    digits.length >= 13 && digits.length <= 19 && CARD_PREFIX.test(digits) && luhnValid(digits)
  );
}

function isPhone(candidate: string, minDigits: number): boolean {
  const digits = digitsOf(candidate);
  return digits.length >= minDigits && digits.length <= 15;
}

export function redactPii(input: string): Redaction {
  let count = 0;
  const replace = (
    text: string,
    pattern: RegExp,
    kind: PiiKind,
    accept: (match: string, group?: string) => boolean,
  ) =>
    text.replace(pattern, (match: string, group?: string) => {
      if (!accept(match, group)) return match;
      count += 1;
      return `[redacted:${kind}]`;
    });
  let text = replace(input, IBAN, "iban", (match) => ibanValid(match));
  text = replace(text, CARD, "card", (match) => isCard(match));
  text = replace(
    text,
    EMAIL,
    "email",
    (_match, tld) => tld === undefined || !FILE_EXTENSION_TLDS.has(tld.toLowerCase()),
  );
  text = replace(text, INTERNATIONAL_PHONE, "phone", (match) => isPhone(match, 8));
  text = replace(text, NANP_PHONE, "phone", (match) => isPhone(match, 10));
  text = replace(text, NATIONAL_PHONE, "phone", (match) => isPhone(match, 9));
  return { text, count };
}

function withCount<P extends object>(payload: P, count: number): P {
  return count === 0 ? payload : { ...payload, redactions: count };
}

export function redactEventDraft(draft: RunEventDraft): RunEventDraft {
  switch (draft.type) {
    case "tool.result": {
      const summary = redactPii(draft.payload.summary);
      const error = draft.payload.error === undefined ? undefined : redactPii(draft.payload.error);
      return {
        ...draft,
        payload: withCount(
          {
            ...draft.payload,
            summary: summary.text,
            ...(error === undefined ? {} : { error: error.text }),
          },
          summary.count + (error?.count ?? 0),
        ),
      };
    }
    case "policy.decided": {
      const reason = redactPii(draft.payload.reason);
      return {
        ...draft,
        payload: withCount({ ...draft.payload, reason: reason.text }, reason.count),
      };
    }
    case "run.failed": {
      const message = redactPii(draft.payload.error.message);
      return {
        ...draft,
        payload: withCount(
          { ...draft.payload, error: { ...draft.payload.error, message: message.text } },
          message.count,
        ),
      };
    }
    default:
      return draft;
  }
}
