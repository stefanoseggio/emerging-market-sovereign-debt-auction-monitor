import { afterEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';

import { excelSerialToIsoDate, FETCH_WORST_CASE_MS, fetchYearAuctions } from '../src/dataSource.js';

// impit's Impit.fetch() is a native binding, not built on the global `fetch` -
// vi.stubGlobal('fetch', ...) never intercepts it. Mock the `impit` module
// itself instead, so `new Impit()` in src/dataSource.ts returns an object whose
// `.fetch` is this mock. vi.hoisted() is required because vi.mock() factories
// run before the top-level `const` below would otherwise be initialized.
const { fetchMock } = vi.hoisted(() => ({
    fetchMock: vi.fn<(url: string, init: RequestInit) => Promise<Response>>(),
}));
vi.mock('impit', () => ({
    // Must be a real `function`, not an arrow function - `new Impit(...)` in
    // src/dataSource.ts requires a constructible mock implementation.
    // eslint-disable-next-line prefer-arrow-callback -- a `new`-able mock cannot be an arrow function
    Impit: vi.fn().mockImplementation(function ImpitMock() {
        return { fetch: fetchMock };
    }),
}));

/** Builds a real, valid XLSX buffer matching the source's confirmed live layout: title rows 0-4, Portuguese header row 5, English header row 6, data from row 7. */
function buildRealShapedWorkbook(dataRows: unknown[][]): ArrayBuffer {
    const rows: unknown[][] = [
        ['', 'Tesouro Nacional (National Treasury)'],
        ['', 'Leilões (ano 2026)'],
        ['', 'Auctions (year 2026)'],
        [''],
        ['', '* TROCA = Exchange Auction; VENDA = Sale Auction'],
        ['', 'Data do leilão', 'Título', 'Tipo de leilão', 'Volta', 'Data de liquidação', 'Data de vencimento', 'Oferta', 'Taxa média', 'Taxa de corte', 'Venda', 'Financeiro (R$)', 'Venda para Bacen', 'Financeiro para Bacen (R$)', 'Referência'],
        ['', 'Auction Date', 'Bond Type', 'Auction Type*', 'Round', 'Settlement Date', 'Maturity Date', 'Quantity Tendered', 'Average Rate', 'Accepted Rate', 'Quantity Accepted', 'Total Amount Accepted (R$)', 'Quantity to Central Bank', 'Total Amount to Central Bank (R$)', 'Benchmark'],
        ...dataRows,
    ];
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Ano 2026');
    return XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
}

// Returns a minimal fetch-response-shaped object, not a real `Response` - cast at the boundary
// (same pattern as mendoza-compras-monitor's fakeResponse()) since fetchMock's declared type
// mirrors the real `impit.fetch()` signature but this suite only needs the handful of fields
// fetchYearAuctions() actually reads.
function mockXlsxResponse(dataRows: unknown[][], overrides: Partial<{ ok: boolean; status: number }> = {}): Response {
    const buffer = buildRealShapedWorkbook(dataRows);
    return {
        ok: overrides.ok ?? true,
        status: overrides.status ?? 200,
        headers: { get: () => null },
        arrayBuffer: async () => buffer,
    } as unknown as Response;
}

afterEach(() => {
    // vi.restoreAllMocks() does not reliably clear a plain vi.fn() created via vi.hoisted() (it
    // only reliably restores real vi.spyOn() spies) - fetchMock.mock.calls would otherwise leak
    // across tests, exactly the same fix already applied in florida-tenders-monitor/test/http.test.ts.
    fetchMock.mockReset();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

/** Runs `work` while auto-advancing fake timers, so the real 1s-30s exponential backoff between retries doesn't make this suite slow (same pattern established in Actor #2's csvSource.test.ts). */
async function withFakeRetryTimers<T>(work: () => Promise<T>): Promise<T> {
    vi.useFakeTimers();
    const resultPromise = work();
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- suppress unhandled-rejection warning during the advance window; the caller still awaits/asserts on resultPromise itself
    resultPromise.catch(() => {});
    await vi.advanceTimersByTimeAsync(120_000);
    return resultPromise;
}

describe('FETCH_WORST_CASE_MS (real-recurrence timeout-budget fix, 2026-09-19 fleet audit follow-up)', () => {
    it('matches the exact worst-case arithmetic documented above REQUEST_TIMEOUT_MS/MAX_RETRY_ATTEMPTS (4 x 20_000ms + 9_100ms backoff = 89_100ms)', () => {
        expect(FETCH_WORST_CASE_MS).toBe(89_100);
    });

    it('leaves comfortable margin under the real 300s timeoutSecs budget for a SINGLE registry year, independent of the separate per-run multi-year budget guard', () => {
        const REAL_TIMEOUT_SECS_BUDGET_MS = 300_000;
        expect(FETCH_WORST_CASE_MS).toBeLessThan(REAL_TIMEOUT_SECS_BUDGET_MS * 0.35);
    });
});

describe('excelSerialToIsoDate', () => {
    it('converts real observed serials to the correct calendar dates', () => {
        expect(excelSerialToIsoDate(45295)).toBe('2024-01-04');
        expect(excelSerialToIsoDate(46280)).toBe('2026-09-15');
    });

    it('produces a stable, deterministic result for the same serial regardless of how many times it is called', () => {
        expect(excelSerialToIsoDate(45295)).toBe(excelSerialToIsoDate(45295));
    });
});

describe('fetchYearAuctions', () => {
    it('parses a real-shaped workbook, finding the header row by content rather than a hardcoded index', async () => {
        fetchMock.mockResolvedValue(
            mockXlsxResponse([['', 45295, 'LTN', 'Venda', '1.ª volta', 45296, 45748, 1_000_000, 0.098997, 0.099024, 680_000, 605_220_929.91, 0, 0, 'LTN 12 meses']]),
        );

        const result = await fetchYearAuctions('2026');
        expect(result).not.toBeNull();
        expect(result!.rows).toHaveLength(1);
        expect(result!.rows[0].bondType).toBe('LTN');
        expect(result!.rows[0].auctionDateSerial).toBe(45295);
        expect(result!.rows[0].acceptedRate).toBe(0.099024);
        expect(result!.rows[0].benchmark).toBe('LTN 12 meses');
    });

    it('handles a row with a missing benchmark (real, confirmed live: a 2nd-round row often has none)', async () => {
        fetchMock.mockResolvedValue(
            mockXlsxResponse([['', 45295, 'LTN', 'Venda', '2.ª volta', 45299, 45748, 250_000, 0.098997, 0.098997, 0, 0, 0, 0, '']]),
        );

        const result = await fetchYearAuctions('2026');
        expect(result!.rows[0].benchmark).toBeNull();
    });

    it('filters out blank rows wherever they appear, including trailing padding (real files pad with empty rows at the end)', async () => {
        // Note: the implementation is a `.filter()` over every remaining row, not a
        // stop/truncate-at-first-blank loop - it removes blank rows from anywhere in the sheet,
        // including an interior blank row, not only trailing ones. This fixture exercises the
        // interior case specifically so the test name matches what the code actually does,
        // corrected after adversarial review flagged an earlier version's name/fixture as only
        // covering trailing blanks (indistinguishable from a true stop-at-first-blank behavior).
        fetchMock.mockResolvedValue(
            mockXlsxResponse([
                ['', 45295, 'LTN', 'Venda', '1.ª volta', 45296, 45748, 1_000_000, 0.098997, 0.099024, 680_000, 605_220_929.91, 0, 0, 'LTN 12 meses'],
                [''], // interior blank row
                ['', 45296, 'LFT', 'Venda', '1.ª volta', 45297, 46113, 500_000, 0.001, 0.001, 500_000, 1_000_000, 0, 0, 'LFT 6 anos'], // valid row AFTER the blank
                [''],
                [''],
            ]),
        );

        const result = await fetchYearAuctions('2026');
        expect(result!.rows).toHaveLength(2); // both valid rows kept, not truncated at the interior blank
        expect(result!.rows[1].bondType).toBe('LFT');
    });

    it('returns null (not an error) on a real 404 - a not-yet-published year', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response);

        const result = await fetchYearAuctions('2027');
        expect(result).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1); // a 404 is not retried
    });

    it('builds the correct real URL and file extension for a year in the confirmed .xls range (2011-2019)', async () => {
        fetchMock.mockResolvedValue(mockXlsxResponse([]));

        await fetchYearAuctions('2015');
        const [url] = fetchMock.mock.calls[0];
        expect(url).toContain('historico-leiloes-2015.xls');
        expect(url).not.toContain('.xlsx');
    });

    it('builds the correct real URL and file extension for a year in the confirmed .xlsx range (2020+)', async () => {
        fetchMock.mockResolvedValue(mockXlsxResponse([]));

        await fetchYearAuctions('2026');
        const [url] = fetchMock.mock.calls[0];
        expect(url).toContain('historico-leiloes-2026.xlsx');
    });

    it('retries on a 5xx response and succeeds once the server recovers', async () => {
        fetchMock
            .mockResolvedValueOnce({ ok: false, status: 503, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response)
            .mockResolvedValueOnce(mockXlsxResponse([['', 45295, 'LTN', 'Venda', '1.ª volta', 45296, 45748, 1_000_000, 0.098997, 0.099024, 680_000, 605_220_929.91, 0, 0, 'LTN 12 meses']]));

        const result = await withFakeRetryTimers(async () => fetchYearAuctions('2026'));
        expect(result!.rows).toHaveLength(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('gives up and throws after exhausting all retry attempts against a persistent 500', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 500, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response);

        await expect(withFakeRetryTimers(async () => fetchYearAuctions('2026'))).rejects.toThrow(/500/);
        expect(fetchMock).toHaveBeenCalledTimes(4); // MAX_RETRY_ATTEMPTS
    });

    it('retries on a genuine network-level failure (a rejected fetch, e.g. DNS failure or connection reset), not just a resolved bad-status response', async () => {
        fetchMock
            .mockRejectedValueOnce(new TypeError('fetch failed: ECONNRESET'))
            .mockResolvedValueOnce(mockXlsxResponse([['', 45295, 'LTN', 'Venda', '1.ª volta', 45296, 45748, 1_000_000, 0.098997, 0.099024, 680_000, 605_220_929.91, 0, 0, 'LTN 12 meses']]));

        const result = await withFakeRetryTimers(async () => fetchYearAuctions('2026'));
        expect(result!.rows).toHaveLength(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not retry a non-retryable 4xx (e.g. 403) - fails immediately without wasting the retry budget on a permission error', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 403, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response);

        await expect(fetchYearAuctions('2026')).rejects.toThrow(/403/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('passes an AbortController signal so a hung request against a high-latency government server can be aborted', async () => {
        fetchMock.mockResolvedValue(mockXlsxResponse([]));

        await fetchYearAuctions('2026');
        const [, options] = fetchMock.mock.calls[0];
        expect(options.signal).toBeInstanceOf(AbortSignal);
    });

    it('aborts a hung attempt at the tightened ~20s per-attempt timeout (not the old 30s/60s) so the retry loop fits the run\'s real 300s timeoutSecs budget even across a multi-year run - see the REQUEST_TIMEOUT_MS doc comment\'s worst-case arithmetic', async () => {
        let callCount = 0;
        fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
            callCount += 1;
            if (callCount === 1) {
                // Simulates a real hung connection: never resolves on its own, only rejects if/when the
                // AbortController fires - exactly what a genuine `fetch` does on abort. init.signal is
                // always real here - fetchYearAuctions() always passes one - non-null assertion is fine
                // (test files have @typescript-eslint/no-non-null-assertion turned off).
                return new Promise((_resolve, reject) => {
                    init.signal!.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
                });
            }
            return Promise.resolve(mockXlsxResponse([['', 45295, 'LTN', 'Venda', '1.ª volta', 45296, 45748, 1_000_000, 0.098997, 0.099024, 680_000, 605_220_929.91, 0, 0, 'LTN 12 meses']]));
        });

        vi.useFakeTimers();
        const resultPromise = fetchYearAuctions('2026');
        // eslint-disable-next-line @typescript-eslint/no-empty-function -- suppress unhandled-rejection warning during the advance window; the caller still awaits/asserts on resultPromise itself
        resultPromise.catch(() => {});

        // Just under the new 20s boundary: the first attempt must still be the only one made - it
        // has not been aborted yet.
        await vi.advanceTimersByTimeAsync(19_000);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Cross the 20s boundary, then allow the (sub-2s) backoff delay before the retry fires.
        // Under the OLD 30_000ms/60_000ms timeout this abort would not have fired yet at this
        // point, the second attempt would never have been made, and this assertion would fail -
        // which is exactly the regression this test guards against.
        await vi.advanceTimersByTimeAsync(3_000);
        const result = await resultPromise;
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(result!.rows).toHaveLength(1);
    });

    it('throws a descriptive error if the real "Auction Date" English header row cannot be found - a real format-change signal, not a silent misparse', async () => {
        const buffer = XLSX.write(
            (() => {
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['nothing', 'resembling', 'a', 'header']]), 'Sheet1');
                return wb;
            })(),
            { type: 'array', bookType: 'xlsx' },
        );
        fetchMock.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => buffer } as unknown as Response);

        await expect(fetchYearAuctions('2026')).rejects.toThrow(/Auction Date/);
    });
});
