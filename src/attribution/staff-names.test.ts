import { describe, expect, it } from "vitest";

import { aliasKey, defaultStaffKind, matchStaffName, nameKey, suggestStaff, type StaffCandidate } from "./staff-names";

/** Short staff names on invoice lines → full Kreloses staff names (spec story 18). */
const STAFF: StaffCandidate[] = [
  { id: "501", name: "Dr Alpha Anderson" },
  { id: "502", name: "Dr Bravo Brown" },
  { id: "503", name: "Branch North General" },
  { id: "504", name: "Charlie Chen" },
  { id: "506", name: "Branch South General" },
];

describe("aliasKey (the identity of a staff name seen on lines)", () => {
  it("ignores case and extra whitespace, but keeps spelling and punctuation", () => {
    expect(aliasKey("  Dr   Alpha ")).toBe("dr alpha");
    expect(aliasKey("DR ALPHA")).toBe("dr alpha");
    expect(aliasKey("Dr. Alpha")).toBe("dr. alpha");
    expect(aliasKey("Ｄｒ Alpha")).toBe("dr alpha"); // full-width letters (NFKC)
  });
});

describe("nameKey (how the matcher reads a name)", () => {
  it("drops titles, punctuation, accents and case", () => {
    expect(nameKey("Dr. Alpha Anderson")).toBe("alpha anderson");
    expect(nameKey("DOCTOR  alpha-anderson")).toBe("alpha anderson");
    expect(nameKey("Dr Zoë O'Neil")).toBe("zoe o neil");
    expect(nameKey("Alpha Anderson, DVM")).toBe("alpha anderson");
  });

  it("falls back to the plain alias key when nothing but a title is left", () => {
    expect(nameKey("Dr.")).toBe("dr.");
  });
});

describe("matchStaffName", () => {
  it("matches a short line name to the one staff member whose name contains it", () => {
    expect(matchStaffName("Dr Alpha", STAFF)).toEqual({ match: "auto", staffId: "501" });
    expect(matchStaffName("Dr. Alpha", STAFF)).toEqual({ match: "auto", staffId: "501" });
    expect(matchStaffName("dr bravo", STAFF)).toEqual({ match: "auto", staffId: "502" });
    expect(matchStaffName("Brown", STAFF)).toEqual({ match: "auto", staffId: "502" });
    expect(matchStaffName("Charlie", STAFF)).toEqual({ match: "auto", staffId: "504" });
    expect(matchStaffName("North General", STAFF)).toEqual({ match: "auto", staffId: "503" });
    expect(matchStaffName("Dr Alpha Anderson", STAFF)).toEqual({ match: "auto", staffId: "501" });
  });

  it("accepts initials and prefixes when exactly one staff member fits", () => {
    expect(matchStaffName("Dr A. Anderson", STAFF)).toEqual({ match: "auto", staffId: "501" });
    expect(matchStaffName("Dr Alph", STAFF)).toEqual({ match: "auto", staffId: "501" });
    expect(matchStaffName("Chen C", STAFF)).toEqual({ match: "auto", staffId: "504" });
  });

  it("prefers an exact name over a prefix match", () => {
    const staff = [...STAFF, { id: "507", name: "Al Smith" }, { id: "508", name: "Alan Jones" }];
    expect(matchStaffName("Al", staff)).toEqual({ match: "auto", staffId: "507" });
  });

  it("each part of the line name must fit a DIFFERENT part of the full name", () => {
    expect(matchStaffName("Alpha Alpha", STAFF)).toEqual({ match: "unmatched", suggestions: ["501"] });
  });

  it("leaves a name unmatched, with the candidates as suggestions, when several staff fit", () => {
    // "General" is in both branch accounts; "B" starts "Bravo"/"Brown" and "Branch".
    expect(matchStaffName("General", STAFF)).toEqual({ match: "unmatched", suggestions: ["503", "506"] });
    expect(matchStaffName("Dr B", STAFF)).toEqual({ match: "unmatched", suggestions: ["503", "506", "502"] });
  });

  it("leaves a name unmatched when nobody fits (e.g. a deleted doctor), suggesting partial matches", () => {
    expect(matchStaffName("Dr Delta", STAFF)).toEqual({ match: "unmatched", suggestions: [] });
    expect(matchStaffName("Dr Alpha Zulu", STAFF)).toEqual({ match: "unmatched", suggestions: ["501"] });
    expect(matchStaffName("Dr", STAFF)).toEqual({ match: "unmatched", suggestions: [] });
    expect(matchStaffName("Dr Alpha", [])).toEqual({ match: "unmatched", suggestions: [] });
  });

  it("is deterministic whatever order the staff list comes in", () => {
    const reversed = [...STAFF].reverse();
    for (const name of ["Dr Alpha", "General", "Dr B", "Dr Alpha Zulu"]) {
      expect(matchStaffName(name, reversed)).toEqual(matchStaffName(name, STAFF));
    }
  });

  it("suggestStaff lists candidates for any name (Settings shows them for unmatched names)", () => {
    expect(suggestStaff("Dr Delta", STAFF)).toEqual([]);
    expect(suggestStaff("General", STAFF)).toEqual(["503", "506"]);
    expect(suggestStaff("Dr Alpha", STAFF)).toEqual(["501"]);
  });
});

describe("defaultStaffKind (a guess the owner can always change)", () => {
  it("generic accounts: branch / general / admin / reception-style FULL names", () => {
    expect(defaultStaffKind("Branch North General")).toBe("generic");
    expect(defaultStaffKind("North General")).toBe("generic");
    expect(defaultStaffKind("Reception")).toBe("generic");
    expect(defaultStaffKind("Admin Account")).toBe("generic");
  });

  it("doctors: a Dr / Doctor title or a veterinary degree on the full name or any name on lines", () => {
    expect(defaultStaffKind("Dr Alpha Anderson")).toBe("doctor");
    expect(defaultStaffKind("Alpha Anderson", ["Dr. Alpha"])).toBe("doctor");
    expect(defaultStaffKind("Doctor Echo")).toBe("doctor");
    expect(defaultStaffKind("Echo Evans DVM")).toBe("doctor");
  });

  it('a generic-looking name on lines never makes someone generic (e.g. the owner credited "North General" to a doctor)', () => {
    expect(defaultStaffKind("Dr Alpha Anderson", ["Dr Alpha", "North General"])).toBe("doctor");
    expect(defaultStaffKind("Charlie Chen", ["Reception"])).toBe("other");
  });

  it("the full name decides first: a doctor title on it beats a generic word; a generic full name beats a doctor name on lines", () => {
    expect(defaultStaffKind("Dr Branch")).toBe("doctor");
    expect(defaultStaffKind("Branch North General", ["Dr Alpha"])).toBe("generic");
  });

  it("everyone else is other staff", () => {
    expect(defaultStaffKind("Charlie Chen", ["Charlie"])).toBe("other");
    expect(defaultStaffKind("Drew Adams")).toBe("other"); // "Drew" is not a title
  });
});
