"use client";

import { useEffect, useMemo, useState } from "react";
import type { Badge, IngestResult, Solicitation } from "@/lib/solicitation";

type ApiResponse = IngestResult & { source: string } & { error?: string };

type SortKey =
  | "nsn"
  | "nomenclature"
  | "solicitationNumber"
  | "solicitationType"
  | "status"
  | "quantity"
  | "issuedDate"
  | "returnByDate";

type SortDirection = "asc" | "desc";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "nsn", label: "NSN / FSC" },
  { key: "nomenclature", label: "Nomenclature" },
  { key: "solicitationNumber", label: "Solicitation" },
  { key: "solicitationType", label: "Type" },
  { key: "status", label: "Status" },
  { key: "quantity", label: "Qty" },
  { key: "issuedDate", label: "Issued" },
  { key: "returnByDate", label: "Return By" },
];

const BADGE_LABELS: Record<Badge, string> = {
  fastAward: "Fast Award",
  unrestricted: "Unrestricted",
  smallBusinessSetAside: "Small Business Set-Aside",
  other: "Other",
};

const BADGE_STYLES: Record<Badge, string> = {
  fastAward: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  unrestricted: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  smallBusinessSetAside: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  other: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
};

const SOLICITATION_TYPE_LABELS: Record<NonNullable<Solicitation["solicitationType"]>, string> = {
  automated: "Automated",
  buyerGenerated: "Buyer-Generated",
  other: "Other",
};

function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function compareValues(a: Solicitation, b: Solicitation, key: SortKey): number {
  const av = a[key];
  const bv = b[key];
  if (av === null && bv === null) return 0;
  if (av === null) return 1;
  if (bv === null) return -1;
  if (typeof av === "number" && typeof bv === "number") return av - bv;
  return String(av).localeCompare(String(bv));
}

function Badges({ badges }: { badges: Badge[] }) {
  if (badges.length === 0) return <span className="text-zinc-400 dark:text-zinc-500">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {badges.map((badge, i) => (
        <span
          key={`${badge}-${i}`}
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${BADGE_STYLES[badge]}`}
        >
          {BADGE_LABELS[badge]}
        </span>
      ))}
    </div>
  );
}

export default function Home() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("returnByDate");
  const [sortDir, setSortDir] = useState<SortDirection>("asc"); // soonest return-by date first

  useEffect(() => {
    fetch("/api/solicitations")
      .then((res) => res.json())
      .then((json: ApiResponse) => setData(json))
      .catch((err) => setFetchError(String(err)));
  }, []);

  const sortedRows = useMemo(() => {
    if (!data?.rows) return [];
    const sorted = [...data.rows].sort((a, b) => compareValues(a, b, sortKey));
    return sortDir === "asc" ? sorted : sorted.reverse();
  }, [data, sortKey, sortDir]);

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  return (
    <div className="flex flex-col flex-1 bg-zinc-50 font-sans dark:bg-black">
      <main className="flex flex-1 flex-col gap-4 px-6 py-8 max-w-7xl w-full mx-auto">
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
        </header>

        {fetchError && (
          <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
            Failed to load solicitations: {fetchError}
          </div>
        )}

        {data?.error && (
          <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
            {data.error}
          </div>
        )}

        {data && !data.error && (
          <>
            <div className="flex flex-wrap items-center gap-3 text-sm text-zinc-600 dark:text-zinc-400">
              <span>
                <strong className="text-black dark:text-zinc-50">
                  {data.rows.length} of {cell(data.recordsFound)}
                </strong>{" "}
                RFQs &middot; posted <strong className="text-black dark:text-zinc-50">{data.date}</strong> &middot;
                pulled{" "}
                <strong className="text-black dark:text-zinc-50">
                  {new Date(data.fetchedAt).toLocaleTimeString()}
                </strong>
              </span>
              {data.source === "data/sample.json" && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                  Sample data — run `npm run ingest` for the full day
                </span>
              )}
            </div>

            {data.recordsFound !== null && data.rows.length < data.recordsFound && (
              <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
                Only {data.rows.length} of {data.recordsFound} RFQs DIBBS reported for this date loaded — the list
                below is incomplete.
              </div>
            )}

            {data.errors.length > 0 && (
              <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
                <strong>Ingest reported issues:</strong>
                <ul className="mt-1 list-disc pl-5">
                  {data.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="overflow-x-auto rounded border border-zinc-200 dark:border-zinc-800">
              <table className="w-full min-w-[1100px] border-collapse text-sm">
                <thead>
                  <tr className="bg-zinc-100 dark:bg-zinc-900">
                    {COLUMNS.map((col) => (
                      <th
                        key={col.key}
                        onClick={() => handleSort(col.key)}
                        className="cursor-pointer select-none whitespace-nowrap px-3 py-2 text-left font-semibold text-zinc-700 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      >
                        {col.label}
                        {sortKey === col.key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                      </th>
                    ))}
                    <th className="px-3 py-2 text-left font-semibold text-zinc-700 dark:text-zinc-300">Badges</th>
                    <th className="px-3 py-2 text-left font-semibold text-zinc-700 dark:text-zinc-300">Solicitation PDF</th>
                    <th className="px-3 py-2 text-left font-semibold text-zinc-700 dark:text-zinc-300">Tech Docs</th>
                    <th className="px-3 py-2 text-left font-semibold text-zinc-700 dark:text-zinc-300">DIBBS</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((row) => (
                    <tr
                      key={row.solicitationNumberRaw}
                      className="border-t border-zinc-200 odd:bg-white even:bg-zinc-50 dark:border-zinc-800 dark:odd:bg-zinc-950 dark:even:bg-black"
                    >
                      <td className="whitespace-nowrap px-3 py-2">
                        <div className="font-mono">{row.nsn}</div>
                        <div className="text-xs text-zinc-500 dark:text-zinc-500">FSC {row.fsc}</div>
                      </td>
                      <td className="px-3 py-2 max-w-[260px]">{cell(row.nomenclature)}</td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono">{row.solicitationNumber}</td>
                      <td className="whitespace-nowrap px-3 py-2">
                        {row.solicitationType ? SOLICITATION_TYPE_LABELS[row.solicitationType] : "—"}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">{cell(row.status)}</td>
                      <td className="whitespace-nowrap px-3 py-2">{cell(row.quantity)}</td>
                      <td className="whitespace-nowrap px-3 py-2">{cell(row.issuedDate)}</td>
                      <td className="whitespace-nowrap px-3 py-2">{cell(row.returnByDate)}</td>
                      <td className="px-3 py-2">
                        <Badges badges={row.badges} />
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">
                        {row.documentUrl ? (
                          <a className="underline" href={row.documentUrl} target="_blank" rel="noopener noreferrer">
                            Solicitation PDF
                          </a>
                        ) : (
                          <span className="text-zinc-400 dark:text-zinc-500">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">
                        {row.technicalDocuments === "present" ? (
                          <span className="text-black dark:text-zinc-50">Present</span>
                        ) : (
                          <span className="text-zinc-400 dark:text-zinc-500">None</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">
                        <a
                          className="underline"
                          href={row.packageViewUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Package View
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {!data && !fetchError && (
          <div className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</div>
        )}
      </main>
    </div>
  );
}
