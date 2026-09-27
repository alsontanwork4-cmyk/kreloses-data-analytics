"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import {
  DATE_PRESETS,
  DATE_RANGE_LABELS,
  formatDateRange,
  isIsoDate,
  mergeFilterIntoSearchParams,
  parseFilter,
  withSearchParams,
  type FilterOption,
  type FilterState,
  type GlobalFilter,
} from "@/filters";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * The global filter bar. Its state lives entirely in the URL: every change navigates to the same
 * page with new search params (see `@/filters`), and the page re-renders on the server.
 */
export function FilterBarControls({
  branches,
  doctors,
}: {
  branches: FilterOption[];
  doctors?: FilterOption[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const state = parseFilter(searchParams);
  const [customOpen, setCustomOpen] = useState(state.range === "custom");

  const hrefFor = (next: FilterState) =>
    withSearchParams(pathname, mergeFilterIntoSearchParams(searchParams, next));
  const navigate = (next: FilterState) =>
    startTransition(() => router.push(hrefFor(next), { scroll: false }));

  const setIds = (key: "branchIds" | "doctorIds", ids: string[] | undefined) => {
    const filter: GlobalFilter = { ...state.filter };
    delete filter[key];
    if (ids?.length) filter[key] = ids;
    navigate({ range: state.range, filter });
  };

  const applyCustom = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const dateFrom = String(data.get("from"));
    const dateTo = String(data.get("to"));
    if (!isIsoDate(dateFrom) || !isIsoDate(dateTo)) return;
    navigate({ range: "custom", filter: { ...state.filter, dateFrom, dateTo } });
  };

  return (
    <section
      aria-label="Filters"
      aria-busy={pending}
      className={cn("flex flex-col gap-3 rounded-lg border bg-card p-3 transition-opacity", pending && "opacity-70")}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div role="group" aria-label="Date range" className="flex flex-wrap gap-1">
          {DATE_PRESETS.map((preset) => {
            const active = state.range === preset;
            return (
              <Button
                key={preset}
                asChild
                size="sm"
                variant={active ? "default" : "ghost"}
                className="shrink-0"
              >
                <Link
                  href={hrefFor({ range: preset, filter: state.filter })}
                  scroll={false}
                  aria-current={active ? "true" : undefined}
                  onClick={() => setCustomOpen(false)}
                >
                  {DATE_RANGE_LABELS[preset]}
                </Link>
              </Button>
            );
          })}
          <Button
            type="button"
            size="sm"
            variant={state.range === "custom" ? "default" : "ghost"}
            className="shrink-0"
            aria-expanded={customOpen}
            aria-current={state.range === "custom" ? "true" : undefined}
            onClick={() => setCustomOpen((open) => !open)}
          >
            {DATE_RANGE_LABELS.custom}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <IdSelect
            name="branch"
            label="Branch"
            allLabel="All branches"
            emptyHint="Branches appear after the first sync"
            options={branches}
            selected={state.filter.branchIds}
            onChange={(ids) => setIds("branchIds", ids)}
          />
          {/* Doctor selector: shown once listDoctorOptions() returns a list (ticket #5). */}
          {doctors ? (
            <IdSelect
              name="doctor"
              label="Doctor"
              allLabel="All doctors"
              emptyHint="Doctors appear after the first sync"
              options={doctors}
              selected={state.filter.doctorIds}
              onChange={(ids) => setIds("doctorIds", ids)}
            />
          ) : null}
        </div>
      </div>

      {customOpen ? (
        <form
          key={`${state.filter.dateFrom}:${state.filter.dateTo}`}
          onSubmit={applyCustom}
          aria-label="Custom date range"
          className="flex flex-wrap items-end gap-2"
        >
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            From
            <Input type="date" name="from" required defaultValue={state.filter.dateFrom} className="h-9 w-40" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            To
            <Input type="date" name="to" required defaultValue={state.filter.dateTo} className="h-9 w-40" />
          </label>
          <Button type="submit" size="sm" className="h-9">
            Apply
          </Button>
        </form>
      ) : null}

      <p className="text-xs text-muted-foreground" data-testid="filter-range">
        {formatDateRange(state.filter.dateFrom, state.filter.dateTo)}
      </p>
    </section>
  );
}

function IdSelect({
  name,
  label,
  allLabel,
  emptyHint,
  options,
  selected,
  onChange,
}: {
  name: string;
  label: string;
  allLabel: string;
  emptyHint: string;
  options: FilterOption[];
  selected: string[] | undefined;
  onChange: (ids: string[] | undefined) => void;
}) {
  const several = (selected?.length ?? 0) > 1;
  const value = several ? "__several" : (selected?.[0] ?? "");
  const empty = options.length === 0;
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">{label}</span>
      <select
        name={name}
        aria-label={label}
        value={value}
        disabled={empty && !selected}
        title={empty ? emptyHint : undefined}
        onChange={(event) => onChange(event.target.value ? [event.target.value] : undefined)}
        className="h-8 min-w-40 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
      >
        <option value="">{empty ? `${allLabel} (none yet)` : allLabel}</option>
        {several ? (
          <option value="__several" disabled>
            {selected!.length} selected
          </option>
        ) : null}
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
        {!several && selected?.[0] && !options.some((option) => option.id === selected[0]) ? (
          <option value={selected[0]}>Unknown ({selected[0]})</option>
        ) : null}
      </select>
    </label>
  );
}
