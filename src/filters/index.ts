/**
 * The shared global filter: `{ dateFrom, dateTo, branchIds?, doctorIds? }`.
 *
 * Every dashboard page and the Analytics Service take this filter. Its state lives in the URL
 * (`?range=`, `?from=&to=`, `?branch=`, `?doctor=`); this module is the only code that reads or
 * writes those params. Safe to import from server and client code.
 */
export * from "./dates";
export * from "./presets";
export * from "./search-params";
export * from "./types";
