import { log } from 'apify';
import * as XLSX from 'xlsx';

import type { RawAuctionRow, RegistryYear } from './types.js';

/**
 * Brazil's National Treasury real, official per-year bulk auction-results file - confirmed live
 * via the Tesouro Transparente CKAN open-data portal (dataset `ds013`), hosted on an Oracle APEX
 * application. See ARCHITECTURE.md section 0.
 */
const DOWNLOAD_BASE = 'https://sisweb.tesouro.gov.br/apex/cosis/rleiloes/arquivos/unico/desc';

const USER_AGENT = 'DeltaRegistrySovereignDebtMonitor/1.0 (+https://apify.com/stefano_seggio/emerging-market-sovereign-debt-auction-monitor)';

const MAX_RETRY_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
/**
 * Confirmed timeout-budget bug (2026-09-19 audit): this Actor's `.actor/actor.json` real, live
 * `defaultRunOptions.timeoutSecs` is 300s. With the previous value here (60_000ms), a single
 * `fetchWithRetry` call's own worst case already exceeded that whole run budget on nothing but the
 * DEFAULT input (`years: ["2026"]`, one file) - not a large-N edge case, the ordinary default run:
 *
 *   worst case = MAX_RETRY_ATTEMPTS x REQUEST_TIMEOUT_MS + sum of the 4 inter-attempt backoff
 *                delays (each up to BASE_BACKOFF_MS x 2^attempt, capped at MAX_BACKOFF_MS, plus
 *                up to 30% jitter - see backoffDelay())
 *              = 5 x 60_000ms + (1_300 + 2_600 + 5_200 + 10_400)ms
 *              = 300_000ms + 19_500ms = 319_500ms (~319.5s) > 300s timeoutSecs
 *
 * i.e. a single stalled/erroring download of this actor's own ~58-85 KB file (see
 * fetchYearAuctions's doc comment) could by itself exhaust the entire run's timeout budget before
 * a single row is ever parsed, even for a one-year run. This was the retry ceiling at this call
 * site being oversized relative to timeoutSecs, not an unbounded input - `years` is a small,
 * enum-constrained field and the default is already the smallest possible workload (one year).
 *
 * Fix: tighten REQUEST_TIMEOUT_MS, not MAX_RETRY_ATTEMPTS/backoff - the 60s-per-attempt stall
 * timeout was far more generous than this tiny file ever needs (58-85 KB - full transfer normally
 * completes in a few seconds even over a slow, high-latency government-server connection), and
 * cutting it does not reduce how many genuine retries a transient 5xx/429/network failure gets.
 * New worst case with all 5 retries still available:
 *
 *   worst case = 5 x 30_000ms + 19_500ms = 150_000ms + 19_500ms = 169_500ms (~169.5s)
 *              = ~56.5% of the real 300s timeoutSecs budget - genuine margin left over for XLSX
 *                parsing and row processing on the default (one-year) run.
 *
 * Note: a user-selected multi-year run (`years` can hold more than one of the 28 enum values) still
 * calls this once per year, sequentially (see routes.ts's run()/processYear()), so a run covering
 * several years compounds this same per-call worst case linearly. That is a real, separate
 * multi-year headroom question about the Actor's own `defaultRunOptions.timeoutSecs`, not the
 * single default-run bug fixed here.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The real file extension per year, confirmed live from the CKAN dataset's own resource list
 * (`package_show?id=ds013`) - NOT a guess. The source's own naming is inconsistent across its
 * history (2000-2010 and 2020+ are `.xlsx`; 2011-2019 are the older `.xls` format), so building a
 * URL with the wrong extension would 404 against this specific file server.
 */
function fileExtensionForYear(year: RegistryYear): 'xls' | 'xlsx' {
    const yearNum = Number(year);
    if (yearNum >= 2011 && yearNum <= 2019) return 'xls';
    return 'xlsx';
}

function fileUrl(year: RegistryYear): string {
    return `${DOWNLOAD_BASE}/historico-leiloes-${year}.${fileExtensionForYear(year)}`;
}

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function backoffDelay(attempt: number): number {
    const exponential = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
    const jitter = Math.random() * exponential * 0.3;
    return exponential + jitter;
}

/**
 * This server returns HTTP 405 for HEAD and Range requests (confirmed live - see
 * ARCHITECTURE.md section 1), so every fetch is a real GET. Adaptive retry backoff still applies
 * for genuine transient failures (5xx/429/network errors) against what can be a high-latency
 * government server, per the mandate's own "robust transport layer" requirement.
 */
interface FetchedResponse {
    status: number;
    /** Present whenever `status` is a real 2xx - null for a 404 (caller never reads the body of a not-yet-published year). */
    buffer: ArrayBuffer | null;
}

/**
 * Fetches AND reads the full response body within the same retry attempt and the same
 * abort/timeout window - found by adversarial review to be a real gap in a prior version, which
 * cleared its timeout as soon as `fetch()`'s headers resolved, then read the body afterward with
 * no timeout or abort signal covering that read at all. A server that answers with a prompt
 * `200 OK` but then stalls or trickles the body indefinitely would have hung with no code-level
 * bound. Reading the body inside this same try/catch also means a body-read failure is retried
 * like any other transient failure, not just a header-fetch failure.
 */
async function fetchWithRetry(url: string): Promise<FetchedResponse> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
        if (attempt > 0) {
            const delay = backoffDelay(attempt - 1);
            log.info(`Retrying GET ${url} (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS}) after ${Math.round(delay)}ms backoff...`);
            await sleep(delay);
        }
        const timeoutController = new AbortController();
        const timeoutHandle = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
        try {
            const response = await fetch(url, { method: 'GET', headers: { 'User-Agent': USER_AGENT }, signal: timeoutController.signal });
            if (response.status === 404) return { status: 404, buffer: null }; // a not-yet-published year - not transient, caller decides
            if (!response.ok) {
                if (response.status >= 500 || response.status === 429) {
                    lastError = new Error(`GET ${url} returned ${response.status}`);
                    continue;
                }
                return { status: response.status, buffer: null }; // another non-retryable 4xx
            }
            const buffer = await response.arrayBuffer();
            return { status: response.status, buffer };
        } catch (networkError) {
            lastError = networkError instanceof Error ? networkError : new Error(String(networkError));
        } finally {
            clearTimeout(timeoutHandle);
        }
    }
    throw lastError ?? new Error(`GET ${url} failed with no further detail after retries.`);
}

/**
 * Excel's date epoch is 1899-12-30 (not 1900-01-01 - this offset already accounts for Excel's own
 * historical leap-year bug, the standard, correct conversion). Deliberately NOT using `xlsx`'s
 * `cellDates: true` option: live testing during this build showed it can produce a
 * timezone-shifted timestamp (e.g. `...T03:00:00.000Z` instead of `...T00:00:00.000Z`) depending
 * on the host environment - unacceptable for a "financial-grade, ISO-8601 UTC" requirement. This
 * function reads the raw numeric serial and computes the UTC date explicitly, independent of the
 * host's local timezone. Returns a plain `YYYY-MM-DD` string - these are calendar dates with no
 * time-of-day component in the source, so no time or timezone offset is fabricated onto them.
 */
export function excelSerialToIsoDate(serial: number): string {
    const utcMillis = Date.UTC(1899, 11, 30) + serial * 86_400_000;
    return new Date(utcMillis).toISOString().slice(0, 10);
}

function toNumberOrNull(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const num = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(num) ? num : null;
}

function toStringOrEmpty(value: unknown): string {
    return value === null || value === undefined ? '' : String(value).trim();
}

/**
 * Locates the real English header row by content, not a hardcoded row index - defensive against
 * the title-block row count drifting across 26 years of real files (confirmed live to be rows
 * 0-4 for the years actually tested, but not assumed identical for every year in a range this
 * wide). Searches column index 1 (column 0 is a real blank spacer column in every observed file)
 * for the literal header text "Auction Date".
 */
function findHeaderRowIndex(rows: unknown[][]): number {
    for (let i = 0; i < rows.length; i++) {
        const cell = rows[i]?.[1];
        if (typeof cell === 'string' && cell.trim().toLowerCase() === 'auction date') {
            return i;
        }
    }
    throw new Error('Could not locate the real "Auction Date" English header row in this year\'s file - the source\'s file format may have changed.');
}

export interface FetchedYear {
    rows: RawAuctionRow[];
}

/**
 * Downloads and parses a full year's auction-results file. Returns null if the year genuinely
 * doesn't exist yet (a real 404, e.g. a not-yet-published future year).
 *
 * There is deliberately no cheap "has this changed" pre-check here. This server's `ETag` header
 * was tested live and found to change on every single request - including two back-to-back GETs
 * of the same file, moments apart, with byte-identical content. It is not a content-hash the way
 * Actor #2's UK registry `Content-MD5` was; it appears to be a per-response value from this
 * Oracle APEX application, not a real caching signal. Using it anyway would have meant this
 * actor's own cache would never actually hit, silently defeating its own purpose while implying
 * an optimization that doesn't exist. Given these files are small (58-85 KB observed live), the
 * honest design is simpler: every run downloads and parses every selected year in full, and the
 * existing per-record content fingerprint (see deltaEngine.ts) is what actually avoids re-billing
 * unchanged auctions - the "zero-cost" guarantee here is at the per-record level, not the
 * per-file level, unlike Actors #1 and #2.
 */
export async function fetchYearAuctions(year: RegistryYear): Promise<FetchedYear | null> {
    const response = await fetchWithRetry(fileUrl(year));
    if (response.status === 404) {
        log.info(`Registry year ${year} has no published file yet (404) - skipping.`);
        return null;
    }
    if (response.buffer === null) {
        throw new Error(`GET ${fileUrl(year)} returned ${response.status}`);
    }

    const workbook = XLSX.read(response.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null });

    const headerRowIndex = findHeaderRowIndex(rawRows);
    const dataRows = rawRows.slice(headerRowIndex + 1).filter((row) => row.length > 0 && row[1] !== null && row[1] !== '');

    const rows: RawAuctionRow[] = dataRows.map((row) => ({
        // Deliberately NOT `?? 0` (a prior version did this, found and fixed by adversarial
        // review): `excelSerialToIsoDate(0)` computes a real-looking but entirely fabricated
        // sentinel date, `1899-12-30`. A row with an unparseable-but-non-empty auction-date cell
        // (e.g. a stray footnote marker in an older file) must be rejected, not silently given a
        // fake date that would then be baked into the record and its identity key.
        auctionDateSerial: toNumberOrNull(row[1]),
        bondType: toStringOrEmpty(row[2]),
        auctionType: toStringOrEmpty(row[3]),
        round: toStringOrEmpty(row[4]),
        settlementDateSerial: toNumberOrNull(row[5]),
        maturityDateSerial: toNumberOrNull(row[6]),
        quantityOffered: toNumberOrNull(row[7]),
        averageRate: toNumberOrNull(row[8]),
        acceptedRate: toNumberOrNull(row[9]),
        quantityAccepted: toNumberOrNull(row[10]),
        totalAmountAcceptedBrl: toNumberOrNull(row[11]),
        quantityToCentralBank: toNumberOrNull(row[12]),
        totalAmountToCentralBankBrl: toNumberOrNull(row[13]),
        benchmark: toStringOrEmpty(row[14]) || null,
    }));

    return { rows };
}
