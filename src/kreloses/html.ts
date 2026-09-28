/**
 * Just enough HTML reading for the Kreloses login flow: forms and their inputs, ASP.NET MVC
 * validation messages, and whether a page is a login form or a one-time-code step. Kreloses pages
 * are server-rendered ASP.NET MVC 5 (attributes in any order, `&amp;`-style entities, self-closing
 * or bare `<input>` tags), which these patterns handle.
 */

export interface HtmlInput {
  name: string;
  type: string;
  value: string;
  autocomplete: string;
}

export interface HtmlForm {
  /** The raw `action` attribute ("" when absent: posts back to the page's own URL). */
  action: string;
  method: string;
  inputs: HtmlInput[];
  /** Names of `<select>` elements. */
  selects: string[];
}

const FORM = /<form\b([^>]*)>([\s\S]*?)<\/form\s*>/gi;
const INPUT = /<input\b([^>]*)>/gi;
const SELECT = /<select\b([^>]*)>/gi;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

export function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1]!.toLowerCase();
    if (name in attributes) continue; // first occurrence wins, like browsers
    attributes[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function parseInputs(html: string): HtmlInput[] {
  return [...html.matchAll(INPUT)].map((match) => {
    const attributes = parseAttributes(match[1]!);
    return {
      name: attributes.name ?? "",
      type: (attributes.type ?? "text").toLowerCase(),
      value: attributes.value ?? "",
      autocomplete: (attributes.autocomplete ?? "").toLowerCase(),
    };
  });
}

function parseSelects(html: string): string[] {
  return [...html.matchAll(SELECT)].map((match) => parseAttributes(match[1]!).name ?? "").filter(Boolean);
}

/** Every `<form>` on the page. Inputs outside any form are ignored. */
export function parseForms(html: string): HtmlForm[] {
  return [...html.matchAll(FORM)].map((match) => {
    const attributes = parseAttributes(match[1]!);
    return {
      action: attributes.action ?? "",
      method: (attributes.method ?? "get").toLowerCase(),
      inputs: parseInputs(match[2]!),
      selects: parseSelects(match[2]!),
    };
  });
}

function hasInput(form: HtmlForm, name: RegExp, type?: string): boolean {
  return form.inputs.some((input) => name.test(input.name) && (!type || input.type === type));
}

/** The Kreloses login form: it has a password field named `Password`. */
export function findLoginForm(html: string): HtmlForm | null {
  return parseForms(html).find((form) => hasInput(form, /^password$/i, "password")) ?? null;
}

const ONE_TIME_CODE_FIELD = /^(code|otp|otpcode|pin|token2fa|twofactorcode|verificationcode|authenticatorcode|recoverycode|selectedprovider)$/i;
// Whole path segments only, so e.g. `/HotProducts` (which contains "otp") is not a code step.
const ONE_TIME_CODE_PATH = /(?:^|\/)(?:verifycode|sendcode|two-?factor|2fa|otp|mfa|loginwith2fa)(?:\/|$)/i;

/** A URL path with a segment such as `/Account/VerifyCode` or `/Account/SendCode`: a one-time-code / 2FA step. */
export function isOneTimeCodePath(url: URL): boolean {
  return ONE_TIME_CODE_PATH.test(url.pathname);
}

/**
 * Whether a page's forms ask for a one-time code / second factor: a code-like field (the ASP.NET
 * Identity `VerifyCode`/`SendCode` pages use `Code` and `SelectedProvider`) or a field with
 * `autocomplete="one-time-code"`. Only meaningful on login pages: an app page may well have a
 * field called `Code` (e.g. an item-code search).
 */
export function hasOneTimeCodeForm(html: string): boolean {
  return parseForms(html).some(
    (form) =>
      form.inputs.some(
        (input) =>
          input.type !== "hidden" && (ONE_TIME_CODE_FIELD.test(input.name) || input.autocomplete === "one-time-code"),
      ) || form.selects.some((name) => ONE_TIME_CODE_FIELD.test(name)),
  );
}

const TOKEN_FIELD = "__RequestVerificationToken";
const META = /<meta\b([^>]*)>/gi;

/**
 * The ASP.NET anti-forgery token: from `form` if it has one, else from any hidden input of that
 * name on the page, else from a `<meta name="__RequestVerificationToken" content="…">` tag.
 */
export function findAntiForgeryToken(html: string, form: HtmlForm | null): string | null {
  const inForm = form?.inputs.find((input) => input.name === TOKEN_FIELD)?.value;
  if (inForm) return inForm;
  const onPage = parseInputs(html).find((input) => input.name === TOKEN_FIELD)?.value;
  if (onPage) return onPage;
  for (const match of html.matchAll(META)) {
    const attributes = parseAttributes(match[1]!);
    if (attributes.name === TOKEN_FIELD && attributes.content) return attributes.content;
  }
  return null;
}

const VALIDATION_SUMMARY = /<div\b[^>]*class\s*=\s*["'][^"']*\bvalidation-summary-errors\b[^"']*["'][^>]*>([\s\S]*?)<\/div\s*>/gi;
const FIELD_ERROR = /<span\b[^>]*class\s*=\s*["'][^"']*\bfield-validation-error\b[^"']*["'][^>]*>([\s\S]*?)<\/span\s*>/gi;
const DANGER = /<(div|span|p|li|strong|small)\b[^>]*class\s*=\s*["'][^"']*\b(?:alert-danger|text-danger)\b[^"']*["'][^>]*>([\s\S]*?)<\/\1\s*>/gi;
const LIST_ITEM = /<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi;

/**
 * Error messages shown on the page, as plain text, de-duplicated: ASP.NET MVC validation
 * (`validation-summary-errors` list items, `field-validation-error` spans) and Bootstrap
 * `.alert-danger` / `.text-danger` elements. Empty and one- or two-character texts (e.g. a
 * required-field "*") are ignored.
 */
export function validationMessages(html: string): string[] {
  const messages: string[] = [];
  for (const summary of html.matchAll(VALIDATION_SUMMARY)) {
    const items = [...summary[1]!.matchAll(LIST_ITEM)].map((item) => item[1]!);
    for (const item of items.length > 0 ? items : [summary[1]!]) messages.push(toPlainText(item));
  }
  for (const field of html.matchAll(FIELD_ERROR)) messages.push(toPlainText(field[1]!));
  for (const danger of html.matchAll(DANGER)) messages.push(toPlainText(danger[2]!));
  return [...new Set(messages.filter((message) => message.length > 2))];
}

export function toPlainText(html: string, maxLength = 200): string {
  const text = decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}
