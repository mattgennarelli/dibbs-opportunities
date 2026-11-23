"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Badge, Solicitation } from "@/lib/solicitation";
import type { ApiSolicitation } from "@/lib/dbRow";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { firstArticleRowLabel } from "@/lib/firstArticle";

type BrowseSortKey = "deadline" | "quantity" | "issued" | "nsn";
type SortValue = BrowseSortKey | "relevance";
type Dir = "asc" | "desc";
type PostedValue = "latest" | "3d" | "7d" | "all";
type FirstArticleValue = "include" | "exclude" | "only";

interface SolicitationsResponse {
  rows: ApiSolicitation[];
  nextCursor: string | null;
  total: number;
  capped?: boolean;
}

interface FacetsResponse {
  facets: { fsc: string; count: number }[];
  setAside: { value: string; count: number }[];
}

interface IngestStatusResponse {
  lastRun: { started_at: string; finished_at: string; status: string; error: string | null } | null;
  latestSourceDate: string | null;
}

interface ApiErrorBody {
  error?: string;
}

// Exception-only flags -- "unrestricted" (the default case) and "other" are deliberately
// never shown; a non-"Open" status becomes a flag too (see statusFlag below) instead of its
// own column.
const BADGE_FLAG_LABELS: Partial<Record<Badge, string>> = {
  fastAward: "Fast Award",
  smallBusinessSetAside: "Small Business",
  hubZone: "HUBZone",
  eightA: "8(a)",
  sdvosb: "SDVOSB",
  wosb: "WOSB",
};
const BADGE_FLAG_STYLE = "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300";
const FAST_AWARD_STYLE = "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300";
const NEW_FLAG_STYLE = "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300";
const STATUS_FLAG_STYLE = "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300";
const FIRST_ARTICLE_FLAG_STYLE = "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300";

const SET_ASIDE_OPTIONS: { value: string; label: string }[] = [
  { value: "smallBusinessSetAside", label: "Small Business" },
  { value: "hubZone", label: "HUBZone" },
  { value: "eightA", label: "8(a)" },
  { value: "sdvosb", label: "SDVOSB" },
  { value: "wosb", label: "WOSB" },
  { value: "unrestricted", label: "Unrestricted" },
];

const SOLICITATION_TYPE_LABELS: Record<NonNullable<Solicitation["solicitationType"]>, string> = {
  automated: "Automated",
  buyerGenerated: "Buyer",
  other: "Other",
};

const ROW_HEIGHT_ESTIMATE = 44;
const PAGE_LIMIT = 50;
const PREFETCH_BEFORE_END = 15;

// One grid template, used for both the header and every row, so columns can never drift out
// of alignment with each other.
const GRID_TEMPLATE = "150px minmax(220px,1fr) 190px 70px 140px 90px 170px 80px";

function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

// Today's calendar date in US Eastern time -- regardless of the viewer's own timezone.
// Computed fresh at render time every call, never stored/cached.
function todayInEt(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Whole-calendar-day difference between two "YYYY-MM-DD" dates, computed via UTC-midnight
// timestamps so it's pure date-math (no DST/timezone interference) -- both inputs are
// already plain calendar dates, not instants.
function daysBetweenDates(fromYMD: string, toYMD: string): number {
  const [fy, fm, fd] = fromYMD.split("-").map(Number);
  const [ty, tm, td] = toYMD.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

type ReturnByStyle = "urgent" | "muted" | "normal";

function relativeReturnBy(returnByDate: string | null): { text: string; style: ReturnByStyle } {
  if (returnByDate === null) return { text: "—", style: "normal" };
  const daysOut = daysBetweenDates(todayInEt(), returnByDate);
  if (daysOut < 0) return { text: "past due", style: "muted" };
  if (daysOut === 0) return { text: "today", style: "urgent" };
  if (daysOut <= 2) return { text: daysOut === 1 ? "in 1 day" : "in 2 days", style: "urgent" };
  return { text: `in ${daysOut} days`, style: "normal" };
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

interface FlagInfo {
  label: string;
  style: string;
}

function rowFlags(row: ApiSolicitation): FlagInfo[] {
  const flags: FlagInfo[] = [];
  for (const badge of row.badges) {
    const label = BADGE_FLAG_LABELS[badge];
    if (label) flags.push({ label, style: badge === "fastAward" ? FAST_AWARD_STYLE : BADGE_FLAG_STYLE });
  }
  if (row.isNew) flags.push({ label: "New", style: NEW_FLAG_STYLE });
  if (row.status !== null && row.status !== "Open") flags.push({ label: row.status, style: STATUS_FLAG_STYLE });
  // Guard on !isFirstArticle: hasFirstArticleSibling is computed self-inclusively at the SQL
  // layer (see lib/apiQuery.ts's hasFirstArticleLineSql) so an orphan FA row would otherwise
  // show this flag on ITSELF -- the flag belongs on the parent, never on an FA line.
  if (!row.isFirstArticle && row.hasFirstArticleSibling) flags.push({ label: "First Article", style: FIRST_ARTICLE_FLAG_STYLE });
  return flags;
}


function Flags({ flags }: { flags: FlagInfo[] }) {
  if (flags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {flags.map((f, i) => (
        <span key={`${f.label}-${i}`} className={`whitespace-normal rounded-full px-2 py-0.5 text-xs font-medium leading-tight ${f.style}`}>
          {f.label}
        </span>
      ))}
    </div>
  );
}

function NsnCell({ row }: { row: ApiSolicitation }) {
  if (row.nsnDigits === null) {
    return (
      <span className="font-mono text-sm text-zinc-400 dark:text-zinc-500" title={row.nsnRaw}>
        {row.nsn}
      </span>
    );
  }
  return (
    <span className="font-mono text-sm" title={row.nsn}>
      <span className="font-bold">{row.nsn.slice(0, 4)}</span>
      {row.nsn.slice(4)}
    </span>
  );
}

function SortArrow({ active, dir }: { active: boolean; dir: Dir }) {
  if (!active) return null;
  return <span className="ml-0.5">{dir === "asc" ? "▲" : "▼"}</span>;
}

// A multi-select combobox: a button that opens a filterable checkbox list with live counts.
// Built from scratch (no new dependency) -- small enough that a combobox library didn't seem
// obviously worth it; flagging that choice rather than silently making it.
function MultiSelectDropdown({
  label,
  options,
  selected,
  onChange,
  searchable = true,
}: {
  label: string;
  options: { value: string; label: string; count: number }[];
  selected: string[];
  onChange: (next: string[]) => void;
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const filtered = filter.trim()
    ? options.filter((o) => o.label.toLowerCase().includes(filter.trim().toLowerCase()))
    : options;

  function toggle(value: string) {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  }

  return (
    <div ref={containerRef} className="relative flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
      {label}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-28 rounded border border-zinc-300 bg-white px-2 py-1 text-left text-sm text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
      >
        {selected.length > 0 ? `${selected.length} selected` : "All"}
      </button>
      {open && (
        <div className="absolute top-full left-0 z-20 mt-1 w-56 rounded border border-zinc-300 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          {searchable && (
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter…"
              autoFocus
              className="mb-2 w-full rounded border border-zinc-300 px-2 py-1 text-sm text-black dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
            />
          )}
          <div className="max-h-56 overflow-y-auto">
            {filtered.length === 0 && <div className="px-1 py-1 text-xs text-zinc-500">No matches</div>}
            {filtered.map((o) => (
              <label
                key={o.value}
                className="flex items-center justify-between gap-2 rounded px-1 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <span className="flex items-center gap-2">
                  <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
                  {o.label}
                </span>
                <span className="text-xs text-zinc-500">{o.count}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-zinc-500 dark:text-zinc-400">Loading…</div>}>
      <SolicitationsPage />
    </Suspense>
  );
}

function SolicitationsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const urlQ = searchParams.get("q") ?? "";
  const fscList = useMemo(() => searchParams.getAll("fsc").sort(), [searchParams]);
  const setAsideList = useMemo(() => searchParams.getAll("setAside").sort(), [searchParams]);
  const fastAward = searchParams.get("fastAward") === "true";
  const techDocs = searchParams.get("techDocs") === "true";
  const minQty = searchParams.get("minQty") ?? "";
  const closingWithinDays = searchParams.get("closingWithinDays") ?? "";
  const sort: SortValue = (searchParams.get("sort") as SortValue) || "deadline";
  const dir: Dir = (searchParams.get("dir") as Dir) || "asc";
  const posted: PostedValue = (searchParams.get("posted") as PostedValue) || "latest";
  const firstArticle: FirstArticleValue = (searchParams.get("firstArticle") as FirstArticleValue) || "include";

  const updateParams = useCallback(
    (patch: Record<string, string | string[] | null>) => {
      const next = new URLSearchParams(searchParams);
      for (const [key, value] of Object.entries(patch)) {
        next.delete(key);
        if (value === null) continue;
        if (Array.isArray(value)) {
          for (const v of value) next.append(key, v);
        } else {
          next.set(key, value);
        }
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [searchParams, router, pathname]
  );

  const [searchInput, setSearchInput] = useState(urlQ);
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  const prevDebouncedRef = useRef(urlQ);

  useEffect(() => {
    setSearchInput(urlQ);
    prevDebouncedRef.current = urlQ;
  }, [urlQ]);

  useEffect(() => {
    if (debouncedSearch === urlQ) return;
    const wasEmpty = prevDebouncedRef.current === "";
    const patch: Record<string, string | null> = { q: debouncedSearch || null };
    if (debouncedSearch === "") {
      patch.sort = null;
      patch.dir = null;
    } else if (wasEmpty) {
      patch.sort = "relevance";
      patch.dir = null;
    }
    updateParams(patch);
    prevDebouncedRef.current = debouncedSearch;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  function clearFilters() {
    setSearchInput("");
    router.replace(pathname, { scroll: false });
  }

  function handleSort(key: BrowseSortKey) {
    if (sort === key) {
      updateParams({ dir: dir === "asc" ? "desc" : "asc" });
    } else {
      updateParams({ sort: key, dir: null });
    }
  }

  const filtersForKey = {
    q: urlQ || undefined,
    fastAward: fastAward || undefined,
    setAside: setAsideList.join(",") || undefined,
    techDocs: techDocs || undefined,
    minQty: minQty || undefined,
    closingWithinDays: closingWithinDays || undefined,
    posted,
    firstArticle,
  };

  const {
    data,
    error,
    isLoading,
    isError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
  } = useInfiniteQuery({
    queryKey: ["solicitations", filtersForKey, fscList, sort, dir],
    queryFn: async ({ pageParam, signal }) => {
      const url = new URL("/api/solicitations", window.location.origin);
      if (urlQ) url.searchParams.set("q", urlQ);
      for (const f of fscList) url.searchParams.append("fsc", f);
      for (const s of setAsideList) url.searchParams.append("setAside", s);
      if (fastAward) url.searchParams.set("fastAward", "true");
      if (techDocs) url.searchParams.set("techDocs", "true");
      if (minQty) url.searchParams.set("minQty", minQty);
      if (closingWithinDays) url.searchParams.set("closingWithinDays", closingWithinDays);
      url.searchParams.set("posted", posted);
      if (firstArticle !== "include") url.searchParams.set("firstArticle", firstArticle);
      url.searchParams.set("sort", sort);
      if (sort !== "relevance") url.searchParams.set("dir", dir);
      url.searchParams.set("limit", String(PAGE_LIMIT));
      if (pageParam) url.searchParams.set("cursor", pageParam);
      const res = await fetch(url, { signal });
      if (!res.ok) {
        const body: ApiErrorBody = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      return res.json() as Promise<SolicitationsResponse>;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const { data: facetsData } = useQuery({
    queryKey: ["facets", filtersForKey, fscList],
    queryFn: async ({ signal }) => {
      const url = new URL("/api/facets", window.location.origin);
      if (urlQ) url.searchParams.set("q", urlQ);
      for (const f of fscList) url.searchParams.append("fsc", f);
      for (const s of setAsideList) url.searchParams.append("setAside", s);
      if (fastAward) url.searchParams.set("fastAward", "true");
      if (techDocs) url.searchParams.set("techDocs", "true");
      if (minQty) url.searchParams.set("minQty", minQty);
      if (closingWithinDays) url.searchParams.set("closingWithinDays", closingWithinDays);
      url.searchParams.set("posted", posted);
      if (firstArticle !== "include") url.searchParams.set("firstArticle", firstArticle);
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error("Failed to load facets");
      return res.json() as Promise<FacetsResponse>;
    },
  });
  const fscOptions = (facetsData?.facets ?? []).map((f) => ({ value: f.fsc, label: f.fsc, count: f.count }));
  const setAsideCounts = new Map((facetsData?.setAside ?? []).map((f) => [f.value, f.count]));
  const setAsideOptions = SET_ASIDE_OPTIONS.map((o) => ({ ...o, count: setAsideCounts.get(o.value) ?? 0 }));

  const { data: statusData } = useQuery({
    queryKey: ["ingest-status"],
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/ingest-status", { signal });
      if (!res.ok) throw new Error("Failed to load ingest status");
      return res.json() as Promise<IngestStatusResponse>;
    },
    refetchInterval: 5 * 60 * 1000,
  });

  // Each page's rows already arrive with FA children (and page-1 orphans) assembled
  // server-side, in order -- see app/api/solicitations/route.ts's withFirstArticlesAssembled.
  // No client-side nesting needed; flatMap just concatenates pages in fetch order.
  const rows = useMemo(() => data?.pages.flatMap((p) => p.rows) ?? [], [data]);
  // "Showing X of Y": Y (total) is parent/normal rows only (see
  // app/api/solicitations/route.ts's parentRowCondition), so X must match -- nested FA
  // children and orphans are extra rendered rows, not extra loaded results, and must not
  // inflate this count above the total they're drawn from.
  const loadedParentCount = useMemo(() => rows.filter((r) => !r.isFirstArticle).length, [rows]);
  const total = data?.pages[0]?.total ?? 0;
  const capped = sort === "relevance" && (data?.pages[0]?.capped ?? false);

  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT_ESTIMATE,
    overscan: 8,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  const sentinelIndex = Math.max(0, rows.length - PREFETCH_BEFORE_END);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const sentinelRef = useCallback(
    (node: HTMLDivElement | null) => {
      observerRef.current?.disconnect();
      if (!node) return;
      observerRef.current = new IntersectionObserver((entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
          fetchNextPage();
        }
      });
      observerRef.current.observe(node);
    },
    [hasNextPage, isFetchingNextPage, fetchNextPage]
  );

  const noResults = !isLoading && !isError && rows.length === 0;

  const headerCell = (label: string, key: BrowseSortKey | null) => {
    if (!key) return <div className="whitespace-nowrap font-semibold">{label}</div>;
    const active = sort === key;
    return (
      <button
        type="button"
        onClick={() => handleSort(key)}
        className="whitespace-nowrap text-left font-semibold hover:text-black dark:hover:text-zinc-50"
      >
        {label}
        <SortArrow active={active} dir={dir} />
      </button>
    );
  };

  const postedLabel = (() => {
    const latest = statusData?.latestSourceDate ?? "…";
    switch (posted) {
      case "latest":
        return `Showing RFQs posted ${latest} (latest available)`;
      case "3d":
        return `Showing RFQs posted in the last 3 days (through ${latest})`;
      case "7d":
        return `Showing RFQs posted in the last 7 days (through ${latest})`;
      case "all":
        return "Showing all open RFQs, regardless of posting date";
    }
  })();

  const freshness = (() => {
    if (!statusData?.lastRun) return null;
    const { finished_at, status } = statusData.lastRun;
    const hoursOld = (Date.now() - new Date(finished_at).getTime()) / (1000 * 60 * 60);
    const stale = status === "failed" || hoursOld > 24;
    return {
      text: `Data updated ${relativeTime(finished_at)} · latest posting ${statusData.latestSourceDate ?? "—"}`,
      stale,
    };
  })();

  function openRow(row: ApiSolicitation, e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest("a")) return; // the real link already handled it
    window.open(row.packageViewUrl, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="flex flex-col flex-1 bg-zinc-50 font-sans dark:bg-black">
      <main className="flex flex-1 flex-col gap-4 px-6 py-8 max-w-[1280px] w-full mx-auto">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Opportunities</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Open DLA DIBBS RFQs, scraped from{" "}
            <a
              className="underline"
              href="https://www.dibbs.bsm.dla.mil/Rfq/RfqDates.aspx?category=issue"
              target="_blank"
              rel="noopener noreferrer"
            >
              DIBBS
            </a>
            . Every blank cell means the source page did not have that value — nothing here is guessed.
          </p>
          {freshness && (
            <p className={`text-xs ${freshness.stale ? "font-medium text-amber-700 dark:text-amber-400" : "text-zinc-500 dark:text-zinc-500"}`}>
              {freshness.stale ? "⚠ " : ""}
              {freshness.text}
              {statusData?.lastRun?.status === "failed" && " — last run failed"}
            </p>
          )}
        </header>

        <div className="flex flex-wrap items-start gap-x-1 gap-y-3 rounded border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
          {/* Two explicit halves (5 controls each), not one big organic flex-wrap -- that
              gave an uneven 7+2/8+1 split at in-between widths. As two fixed groups, the
              outer wrap always lands on either "both groups side by side" (fits) or "each
              group on its own row" (doesn't fit) -- never a lopsided split. */}
          <div className="flex flex-wrap items-end gap-x-2 gap-y-3">
          <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
            Search
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="NSN, nomenclature"
              className="w-48 rounded border border-zinc-300 bg-white px-2 py-1 text-sm text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
            Posted
            <select
              value={posted}
              onChange={(e) => updateParams({ posted: e.target.value === "latest" ? null : e.target.value })}
              className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            >
              <option value="latest">Latest day</option>
              <option value="3d">Last 3 days</option>
              <option value="7d">Last 7 days</option>
              <option value="all">All open</option>
            </select>
          </label>
          <MultiSelectDropdown
            label="FSC"
            options={fscOptions}
            selected={fscList}
            onChange={(next) => updateParams({ fsc: next.length ? next : null })}
          />
          <MultiSelectDropdown
            label="Set-aside"
            options={setAsideOptions}
            selected={setAsideList}
            onChange={(next) => updateParams({ setAside: next.length ? next : null })}
            searchable={false}
          />
          <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
            First Article
            <select
              value={firstArticle}
              onChange={(e) => updateParams({ firstArticle: e.target.value === "include" ? null : e.target.value })}
              className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            >
              <option value="include">Include</option>
              <option value="exclude">Exclude</option>
              <option value="only">Only</option>
            </select>
          </label>
          </div>
          <div className="flex flex-wrap items-end gap-x-2 gap-y-3">
          <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
            Min qty
            <input
              type="number"
              min={0}
              value={minQty}
              onChange={(e) => updateParams({ minQty: e.target.value || null })}
              placeholder="0"
              className="w-24 rounded border border-zinc-300 bg-white px-2 py-1 text-sm text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
            Closing within (days)
            <input
              type="number"
              min={0}
              value={closingWithinDays}
              onChange={(e) => updateParams({ closingWithinDays: e.target.value || null })}
              placeholder="e.g. 7"
              className="w-24 rounded border border-zinc-300 bg-white px-2 py-1 text-sm text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            />
          </label>
          {/* Same label-row + control-row shape as every other filter above, so flex-wrap
              lines up evenly instead of these two being shorter and throwing off the wrap. */}
          <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
            <span className="invisible">Fast Award</span>
            <span className="flex h-[26px] items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
              <input
                type="checkbox"
                checked={fastAward}
                onChange={(e) => updateParams({ fastAward: e.target.checked ? "true" : null })}
              />
              Fast Award only
            </span>
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
            <span className="invisible">Has tech docs</span>
            <span className="flex h-[26px] items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
              <input
                type="checkbox"
                checked={techDocs}
                onChange={(e) => updateParams({ techDocs: e.target.checked ? "true" : null })}
              />
              Has tech docs
            </span>
          </label>
          <div className="flex flex-col gap-1">
            <span className="invisible text-xs">Clear all</span>
            <button
              type="button"
              onClick={clearFilters}
              className="rounded border border-zinc-300 px-3 py-1 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Clear all
            </button>
          </div>
          </div>
          <span className="ml-auto self-center text-sm text-zinc-600 dark:text-zinc-400">
            Showing <strong className="text-black dark:text-zinc-50">{loadedParentCount}</strong> of{" "}
            <strong className="text-black dark:text-zinc-50">{total}</strong>
          </span>
        </div>

        <div className="text-sm text-zinc-600 dark:text-zinc-400">
          {sort === "relevance" ? <span className="font-medium text-zinc-700 dark:text-zinc-300">Sorted by best match</span> : postedLabel}
        </div>

        {capped && (
          <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
            Showing top 200 of {total} — refine your search for more precise results.
          </div>
        )}

        {isError && (
          <div className="flex items-center justify-between rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
            <span>Failed to load: {error instanceof Error ? error.message : "unknown error"}</span>
            <button
              type="button"
              onClick={() => refetch()}
              className="rounded border border-red-400 px-3 py-1 text-xs font-medium hover:bg-red-100 dark:border-red-700 dark:hover:bg-red-900"
            >
              Retry
            </button>
          </div>
        )}

        {isLoading && (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-11 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
            ))}
          </div>
        )}

        {noResults && (
          <div className="flex flex-col items-center gap-3 rounded border border-zinc-200 bg-white px-4 py-10 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
            <span>No results match the current filters.</span>
            <button
              type="button"
              onClick={clearFilters}
              className="rounded border border-zinc-300 px-3 py-1 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Clear filters
            </button>
          </div>
        )}

        {!isLoading && !isError && rows.length > 0 && (
          <div
            ref={parentRef}
            data-testid="virtual-scroll-container"
            className="overflow-auto rounded border border-zinc-200 dark:border-zinc-800"
            style={{ height: "70vh" }}
          >
            <div
              className="sticky top-0 z-10 grid items-center gap-3 border-b border-zinc-200 bg-zinc-100 px-3 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
              style={{ gridTemplateColumns: GRID_TEMPLATE }}
            >
              {headerCell("NSN", "nsn")}
              <div className="font-semibold">Item</div>
              <div className="font-semibold">Solicitation</div>
              {headerCell("Qty", "quantity")}
              {headerCell("Return By", "deadline")}
              {headerCell("Issued", "issued")}
              <div className="font-semibold">Flags</div>
              <div className="text-center font-semibold">Tech Docs</div>
            </div>
            <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const row = rows[virtualRow.index];
                const rb = relativeReturnBy(row.returnByDate);
                const typeLabel = row.solicitationType ? SOLICITATION_TYPE_LABELS[row.solicitationType] : null;
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={(el) => {
                      rowVirtualizer.measureElement(el);
                      if (virtualRow.index === sentinelIndex) sentinelRef(el);
                    }}
                    data-row-index={virtualRow.index}
                    onClick={(e) => openRow(row, e)}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${virtualRow.start}px)`,
                      gridTemplateColumns: GRID_TEMPLATE,
                      minHeight: ROW_HEIGHT_ESTIMATE,
                    }}
                    className="grid cursor-pointer items-center gap-3 border-t border-zinc-200 px-3 py-1.5 odd:bg-white even:bg-zinc-50 hover:bg-zinc-100 dark:border-zinc-800 dark:odd:bg-zinc-950 dark:even:bg-black dark:hover:bg-zinc-900"
                  >
                    {row.isFirstArticle ? (
                      <>
                        <div />
                        <div
                          className={`truncate text-sm text-zinc-500 dark:text-zinc-400 ${row.isOrphanFirstArticle ? "" : "pl-4"}`}
                        >
                          {firstArticleRowLabel(row.nomenclature, row.isOrphanFirstArticle)}
                        </div>
                      </>
                    ) : (
                      <>
                        <NsnCell row={row} />
                        <div className="truncate text-sm" title={row.nomenclature}>
                          {cell(row.nomenclature)}
                        </div>
                      </>
                    )}
                    <div className="overflow-hidden">
                      <a
                        href={row.packageViewUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="truncate font-mono text-sm underline"
                        title={row.solicitationNumber}
                      >
                        {row.solicitationNumber} ↗
                      </a>
                      <div className="truncate text-xs text-zinc-500 dark:text-zinc-500">
                        {typeLabel ?? "—"}
                        {row.purchaseRequestNumber ? ` · PR ${row.purchaseRequestNumber}` : ""}
                      </div>
                    </div>
                    <div className="text-sm">{row.isFirstArticle ? "" : cell(row.quantity)}</div>
                    <div className="text-sm">
                      {cell(row.returnByDate)}
                      {row.returnByDate && (
                        <div
                          className={`text-xs ${
                            rb.style === "urgent"
                              ? "text-red-600 dark:text-red-400"
                              : rb.style === "muted"
                                ? "text-zinc-400 dark:text-zinc-500"
                                : "text-zinc-500 dark:text-zinc-500"
                          }`}
                        >
                          {rb.text}
                        </div>
                      )}
                    </div>
                    <div className="text-sm">{cell(row.issuedDate)}</div>
                    <div>
                      <Flags flags={rowFlags(row)} />
                    </div>
                    <div className="flex justify-center">
                      {row.technicalDocuments === "present" ? (
                        <span
                          title="Drawings available on DIBBS (DIBBS account required)"
                          className="cursor-default text-sm text-zinc-500 no-underline dark:text-zinc-400"
                        >
                          On DIBBS
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {isFetchingNextPage && <div className="text-center text-xs text-zinc-500 dark:text-zinc-400">Loading more…</div>}
      </main>
    </div>
  );
}
