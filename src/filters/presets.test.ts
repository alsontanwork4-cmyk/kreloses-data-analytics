import { describe, expect, it } from "vitest";

import { clinicToday, resolveDatePreset } from "@/filters";

// Kuala Lumpur is UTC+8 all year, so 16:00Z is midnight at the clinic.
const at = (iso: string) => new Date(iso);

describe("clinicToday", () => {
  it("uses the clinic's calendar date, not UTC's", () => {
    expect(clinicToday(at("2026-09-30T15:59:59Z"))).toBe("2026-09-30");
    expect(clinicToday(at("2026-09-30T16:00:00Z"))).toBe("2026-10-01");
  });
});

describe("resolveDatePreset", () => {
  it("today is a single clinic day", () => {
    expect(resolveDatePreset("today", at("2026-09-30T16:30:00Z"))).toEqual({
      dateFrom: "2026-10-01",
      dateTo: "2026-10-01",
    });
  });

  describe("this week (weeks start on Monday)", () => {
    it.each([
      ["Monday", "2026-09-28T02:00:00Z", "2026-09-28", "2026-09-28"],
      ["Wednesday", "2026-09-30T02:00:00Z", "2026-09-28", "2026-09-30"],
      ["Sunday", "2026-10-04T02:00:00Z", "2026-09-28", "2026-10-04"],
      ["Thursday across a month boundary", "2026-10-01T02:00:00Z", "2026-09-28", "2026-10-01"],
      ["Friday across a year boundary", "2027-01-01T02:00:00Z", "2026-12-28", "2027-01-01"],
      ["Sunday 23:30 in KL (still Sunday, not next week)", "2026-10-04T15:30:00Z", "2026-09-28", "2026-10-04"],
      ["Monday 00:30 in KL (a new week, though UTC says Sunday)", "2026-10-04T16:30:00Z", "2026-10-05", "2026-10-05"],
    ])("%s", (_label, now, dateFrom, dateTo) => {
      expect(resolveDatePreset("this-week", at(now))).toEqual({ dateFrom, dateTo });
    });
  });

  describe("month to date", () => {
    it("runs from the 1st to today", () => {
      expect(resolveDatePreset("month-to-date", at("2026-09-28T02:00:00Z"))).toEqual({
        dateFrom: "2026-09-01",
        dateTo: "2026-09-28",
      });
    });

    it("is just the 1st in the first hour of a month in KL (UTC is still last month)", () => {
      expect(resolveDatePreset("month-to-date", at("2026-09-30T16:30:00Z"))).toEqual({
        dateFrom: "2026-10-01",
        dateTo: "2026-10-01",
      });
    });
  });

  describe("last month", () => {
    it.each([
      ["a 30-day month", "2026-10-15T02:00:00Z", "2026-09-01", "2026-09-30"],
      ["a 31-day month, asked on the 31st", "2026-08-31T02:00:00Z", "2026-07-01", "2026-07-31"],
      ["February in a common year", "2026-03-31T02:00:00Z", "2026-02-01", "2026-02-28"],
      ["February in a leap year", "2028-03-01T02:00:00Z", "2028-02-01", "2028-02-29"],
      ["December of the previous year", "2027-01-10T02:00:00Z", "2026-12-01", "2026-12-31"],
      ["the first hour of a month in KL", "2026-09-30T16:30:00Z", "2026-09-01", "2026-09-30"],
    ])("%s", (_label, now, dateFrom, dateTo) => {
      expect(resolveDatePreset("last-month", at(now))).toEqual({ dateFrom, dateTo });
    });
  });

  describe("year to date", () => {
    it("runs from 1 January to today", () => {
      expect(resolveDatePreset("year-to-date", at("2026-09-28T02:00:00Z"))).toEqual({
        dateFrom: "2026-01-01",
        dateTo: "2026-09-28",
      });
    });

    it("rolls over at midnight in KL, not UTC", () => {
      expect(resolveDatePreset("year-to-date", at("2025-12-31T16:10:00Z"))).toEqual({
        dateFrom: "2026-01-01",
        dateTo: "2026-01-01",
      });
    });
  });
});
