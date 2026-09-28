import { describe, expect, it } from "vitest";

import { matchName, type NamedEntry } from "./names";

const DOCTORS: NamedEntry[] = [
  { id: "3", name: "Dr Alpha Anderson", otherNames: ["Dr Alpha", "Dr. Alpha"] },
  { id: "5", name: "Dr Bravo Brown", otherNames: ["Dr Bravo"] },
  { id: "7", name: "Dr Delta", otherNames: ["Dr Delta"] },
  { id: "9", name: "Dr Alphonse Bell", otherNames: ["Dr Alphonse"] },
];
const BRANCHES: NamedEntry[] = [
  { id: "1", name: "Branch North" },
  { id: "2", name: "Branch South" },
];

const doctor = (term: string) => matchName(term, DOCTORS, "doctor");
const branch = (term: string) => matchName(term, BRANCHES, "branch");

describe("matching a typed branch or doctor name to one id", () => {
  it.each([
    ["an id", "5", "5"],
    ["the full name", "Dr Bravo Brown", "5"],
    ["the full name in another case, spacing and punctuation", "  dr.   bravo  BROWN ", "5"],
    ["the short name on invoice lines", "Dr Bravo", "5"],
    ["a name without the title", "Bravo", "5"],
    ["the surname", "Brown", "5"],
    ["\"Doctor\" instead of \"Dr\"", "Doctor Delta", "7"],
    ["a name that is exactly one doctor's even though it starts another's", "Dr Alpha", "3"],
    ["a line-name spelling", "Dr. Alpha", "3"],
    ["the start of a word", "Brav", "5"],
  ])("finds a doctor by %s", (_label, term, id) => {
    expect(doctor(term)).toEqual({ ok: true, entry: DOCTORS.find((entry) => entry.id === id) });
  });

  it.each([
    ["a word of the name", "North", "1"],
    ["the words in another order", "south branch", "2"],
    ["the id", "2", "2"],
  ])("finds a branch by %s", (_label, term, id) => {
    expect(branch(term)).toEqual({ ok: true, entry: BRANCHES.find((entry) => entry.id === id) });
  });

  it("lists the candidates when a name fits more than one", () => {
    expect(doctor("Alph")).toEqual({
      ok: false,
      problem: 'Doctor "Alph" matches more than one doctor: Dr Alpha Anderson (id 3), Dr Alphonse Bell (id 9). Use the full name or the id.',
    });
    expect(branch("Branch")).toEqual({
      ok: false,
      problem: 'Branch "Branch" matches more than one branch: Branch North (id 1), Branch South (id 2). Use the full name or the id.',
    });
  });

  it("lists every option when nothing fits", () => {
    expect(doctor("Zed")).toEqual({
      ok: false,
      problem:
        'No doctor matches "Zed". Doctors: Dr Alpha Anderson (id 3), Dr Alphonse Bell (id 9), Dr Bravo Brown (id 5), Dr Delta (id 7).',
    });
    // An unknown id is not a name either.
    expect(branch("99")).toMatchObject({ ok: false, problem: expect.stringContaining('No branch matches "99". Branches: Branch North (id 1), Branch South (id 2).') });
    expect(matchName("North", [], "branch")).toEqual({ ok: false, problem: 'No branch matches "North": no branches have been synced yet.' });
    // A title alone names nobody.
    expect(doctor("Dr")).toMatchObject({ ok: false, problem: expect.stringContaining("matches more than one doctor") });
  });

  it("refuses a blank or punctuation-only name instead of matching everyone", () => {
    expect(branch("  ")).toEqual({ ok: false, problem: 'Branch "" is not a name or an id.' });
    expect(doctor("--")).toEqual({ ok: false, problem: 'Doctor "--" is not a name or an id.' });
  });
});
