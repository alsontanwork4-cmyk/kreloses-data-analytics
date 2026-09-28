"use server";

import { revalidatePath } from "next/cache";

import type { ItemClassification, ItemMatchType, MixGroup } from "@/attribution";
import { requireRole } from "@/auth/session";
import { getDb } from "@/db/client";
import { addItemRule, assignItem, clearItemAssignment, deleteItemRule, type ItemSettingsChange } from "@/items/store";

export type ItemChangeState = { status: "idle" } | { status: "saved" | "error"; message: string };

/**
 * Settings → Items actions. Owner only: `requireRole` refuses anyone else (Server Actions are
 * reachable by a direct POST, not only through the page). Every change reclassifies every item in
 * the same transaction and the whole dashboard is revalidated, so all figures — past periods
 * included — follow at once; nothing is re-synced.
 */
export async function assignItemAction(_previous: ItemChangeState, formData: FormData): Promise<ItemChangeState> {
  const user = await requireRole("owner");
  const result = await assignItem(getDb(), {
    itemKey: String(formData.get("itemKey") ?? ""),
    classification: classificationFrom(formData),
    assignedBy: user.email,
  });
  return done(result, "Saved: every figure, past periods included, uses this group now.");
}

export async function clearItemAssignmentAction(_previous: ItemChangeState, formData: FormData): Promise<ItemChangeState> {
  await requireRole("owner");
  const result = await clearItemAssignment(getDb(), String(formData.get("itemKey") ?? ""));
  return done(result, "Saved: the rules decide this item's group again.");
}

export async function addItemRuleAction(_previous: ItemChangeState, formData: FormData): Promise<ItemChangeState> {
  const user = await requireRole("owner");
  const priority = String(formData.get("priority") ?? "").trim();
  const result = await addItemRule(getDb(), {
    matchType: String(formData.get("matchType") ?? "") as ItemMatchType,
    pattern: String(formData.get("pattern") ?? ""),
    priority: priority === "" ? 100 : Number(priority),
    // "Leave unmapped": a rule that keeps matching items out of every group.
    classification: formData.get("group") === "unmapped" ? null : classificationFrom(formData),
    createdBy: user.email,
  });
  return done(result, "Rule added: every item was checked against the rules again.");
}

export async function deleteItemRuleAction(_previous: ItemChangeState, formData: FormData): Promise<ItemChangeState> {
  await requireRole("owner");
  const result = await deleteItemRule(getDb(), String(formData.get("ruleId") ?? ""));
  return done(result, "Rule deleted: every item was checked against the rules again.");
}

function classificationFrom(formData: FormData): ItemClassification {
  const checked = (name: string) => formData.get(name) === "on";
  return {
    group: String(formData.get("group") ?? "") as MixGroup,
    surgery: checked("surgery"),
    consult: checked("consult"),
    vaccine: checked("vaccine"),
    dentalScaling: checked("dentalScaling"),
    procedure: checked("procedure"),
  };
}

function done(result: ItemSettingsChange | { status: "saved"; ruleId: string }, message: string): ItemChangeState {
  switch (result.status) {
    case "saved":
      revalidatePath("/", "layout");
      return { status: "saved", message };
    case "invalid":
      return { status: "error", message: result.message };
    case "duplicate":
      return { status: "error", message: "A rule with this match and text already exists: delete it first to change it." };
    case "not_found":
      return { status: "error", message: "That item or rule no longer exists. Reload the page." };
  }
}
