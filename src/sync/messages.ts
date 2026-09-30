import { CredentialsKeyError, DecryptionError } from "@/connections/encryption";
import { describeTestFailure } from "@/connections/messages";
import { AuthFailed, LayoutChanged, PageMissing, RateLimited, Transient } from "@/kreloses";

import type { SyncErrorCode, SyncWarning } from "./runs";

export interface SyncFailure {
  code: SyncErrorCode;
  /** Shown on the Sync status page (to the owner and managers): what happened and what happens next. */
  message: string;
}

/**
 * Why a sync run failed, in plain words, from the error that stopped it. Kreloses errors never
 * carry passwords, cookies, tokens or query strings, so their messages are safe to store and show.
 */
export function describeSyncFailure(error: unknown): SyncFailure {
  if (error instanceof AuthFailed) {
    return { code: "auth_failed", message: `The Kreloses login failed. ${describeTestFailure(error).message}` };
  }
  if (error instanceof PageMissing) {
    return {
      code: "layout_changed",
      message: `The app could not open invoice pages in Kreloses (${error.message}), not even the first few it tried, so their line items were not read. Kreloses may have moved them: the app needs checking. Sales are still counted at their net amounts as "line items not synced yet".`,
    };
  }
  if (error instanceof LayoutChanged) {
    return {
      code: "layout_changed",
      message: `Kreloses answered in a way the app does not recognise (${error.message}). Its pages may have changed: the app needs an update before this sync can work, so no numbers were guessed.`,
    };
  }
  if (error instanceof RateLimited) {
    return {
      code: "rate_limited",
      message: `Kreloses asked the app to slow down (${error.message}). The next sync will try again.`,
    };
  }
  if (error instanceof Transient) {
    return {
      code: "transient",
      message: `Kreloses could not be reached or had a problem (${error.message}). The next sync will try again.`,
    };
  }
  if (error instanceof CredentialsKeyError || error instanceof DecryptionError) {
    return { code: "key_problem", message: describeTestFailure(error).message };
  }
  return {
    code: "internal",
    message: `Something went wrong in the app during the sync (${error instanceof Error ? error.name : "unknown error"}). Try again; if it keeps failing, check the server logs.`,
  };
}

/** Errors that say the connection's login no longer works (shown on the Connections page too). */
export function isLoginFailure(error: unknown): boolean {
  return error instanceof AuthFailed || error instanceof CredentialsKeyError || error instanceof DecryptionError;
}

/** The warning for a run that could not open some invoice pages (it ends `partial`). */
export function missingPagesWarning(count: number): SyncWarning {
  const one = count === 1;
  return {
    code: "invoice_pages_missing",
    message: `${count} invoice ${one ? "page" : "pages"} could not be opened in Kreloses (not found, or sent elsewhere). ${one ? "Its sale counts" : "Those sales count"} at the net amount as "line items not synced yet" until a sync reads ${one ? "it" : "them"}; the next sync tries again.`,
  };
}

/** The warning for a nightly run whose time budget ran out before every older sale's line items were read. */
export function lineItemsLeftWarning(count: number): SyncWarning {
  const one = count === 1;
  return {
    code: "line_items_left",
    message: `${count} older ${one ? "sale still waits" : "sales still wait"} for ${one ? "its" : "their"} line items (the time limit was reached). ${one ? "It counts" : "They count"} at the revenue base as "line items not synced yet"; the next nightly sync carries on.`,
  };
}

/** The warning for a nightly run whose sweep met older invoice pages it could not read. */
export function unreadablePagesWarning(count: number, example: LayoutChanged): SyncWarning {
  const one = count === 1;
  return {
    code: "invoice_pages_unreadable",
    message: `${count} older invoice ${one ? "page" : "pages"} could not be read (${example.message}), so ${one ? "it was" : "they were"} skipped. ${one ? "That sale counts" : "Those sales count"} at the revenue base as "line items not synced yet"; the nightly sync tries again every night. If it keeps happening, or new sales show it too, the app needs an update.`,
  };
}

/** The warning for a backfill run that stopped because tonight's request budget for the login is used up (#8). */
export function requestBudgetWarning(): SyncWarning {
  return {
    code: "backfill_request_budget",
    message:
      "Tonight's history backfill budget of Kreloses requests for this login is used up, so it stopped here. The backfill carries on from this point tomorrow night.",
  };
}

/** The warning for a backfill run that stepped aside for the nightly sync or Sync now (docs/adr/0011). */
export function yieldedWarning(): SyncWarning {
  return {
    code: "backfill_yielded",
    message:
      "Paused so that the nightly sync (or Sync now) could use this Kreloses login. The history backfill carries on from this point in its next chunk.",
  };
}

/** The warning for a run whose Sale List filter had no readable Staff list. */
export function staffListWarning(error: LayoutChanged): SyncWarning {
  return {
    code: "staff_list_unreadable",
    message: `Kreloses's Staff list could not be read this time (${error.message}), so new staff names on invoice lines were not matched to full names. Their sales are still credited to the names as written; check Settings → Doctors.`,
  };
}
