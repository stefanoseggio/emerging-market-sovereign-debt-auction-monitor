import { afterEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';

import { excelSerialToIsoDate, fetchYearAuctions } from '../src/dataSource.js';

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

function mockXlsxResponse(dataRows: unknown[][], overrides: Partial<{ ok: boolean; status: number }> = {}) {
    const buffer = buildRealShapedWorkbook(dataRows);
    return {
        ok: overrides.ok ?? true,
        status: overrides.status ?? 200,
        headers: { get: () => null },
        arrayBuffer: async () => buffer,
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
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
        const fetchMock = vi.fn().mockResolvedValue(
            mockXlsxResponse([['', 45295, 'LTN', 'Venda', '1.ª volta', 45296, 45748, 1_000_000, 0.098997, 0.099024, 680_000, 605_220_929.91, 0, 0, 'LTN 12 meses']]),
        );
        vi.stubGlobal('fetch', fetchMock);

        const result = await fetchYearAuctions('2026');
        expect(result).not.toBeNull();
        expect(result!.rows).toHaveLength(1);
        expect(result!.rows[0].bondType).toBe('LTN');
        expect(result!.rows[0].auctionDateSerial).toBe(45295);
        expect(result!.rows[0].acceptedRate).toBe(0.099024);
        expect(result!.rows[0].benchmark).toBe('LTN 12 meses');
    });

    it('handles a row with a missing benchmark (real, confirmed live: a 2nd-round row often has none)', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            mockXlsxResponse([['', 45295, 'LTN', 'Venda', '2.ª volta', 45299, 45748, 250_000, 0.098997, 0.098997, 0, 0, 0, 0, '']]),
        );
        vi.stubGlobal('fetch', fetchMock);

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
        const fetchMock = vi.fn().mockResolvedValue(
            mockXlsxResponse([
                ['', 45295, 'LTN', 'Venda', '1.ª volta', 45296, 45748, 1_000_000, 0.098997, 0.099024, 680_000, 605_220_929.91, 0, 0, 'LTN 12 meses'],
                [''], // interior blank row
                ['', 45296, 'LFT', 'Venda', '1.ª volta', 45297, 46113, 500_000, 0.001, 0.001, 500_000, 1_000_000, 0, 0, 'LFT 6 anos'], // valid row AFTER the blank
                [''],
                [''],
            ]),
        );
        vi.stubGlobal('fetch', fetchMock);

        const result = await fetchYearAuctions('2026');
        expect(result!.rows).toHaveLength(2); // both valid rows kept, not truncated at the interior blank
        expect(result!.rows[1].bondType).toBe('LFT');
    });

    it('returns null (not an error) on a real 404 - a not-yet-published year', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) });
        vi.stubGlobal('fetch', fetchMock);

        const result = await fetchYearAuctions('2027');
        expect(result).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1); // a 404 is not retried
    });

    it('builds the correct real URL and file extension for a year in the confirmed .xls range (2011-2019)', async () => {
        const fetchMock = vi.fn().mockResolvedValue(mockXlsxResponse([]));
        vi.stubGlobal('fetch', fetchMock);

        await fetchYearAuctions('2015');
        const [url] = fetchMock.mock.calls[0];
        expect(url).toContain('historico-leiloes-2015.xls');
        expect(url).not.toContain('.xlsx');
    });

    it('builds the correct real URL and file extension for a year in the confirmed .xlsx range (2020+)', async () => {
        const fetchMock = vi.fn().mockResolvedValue(mockXlsxResponse([]));
        vi.stubGlobal('fetch', fetchMock);

        await fetchYearAuctions('2026');
        const [url] = fetchMock.mock.calls[0];
        expect(url).toContain('historico-leiloes-2026.xlsx');
    });

    it('retries on a 5xx response and succeeds once the server recovers', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({ ok: false, status: 503, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) })
            .mockResolvedValueOnce(mockXlsxResponse([['', 45295, 'LTN', 'Venda', '1.ª volta', 45296, 45748, 1_000_000, 0.098997, 0.099024, 680_000, 605_220_929.91, 0, 0, 'LTN 12 meses']]));
        vi.stubGlobal('fetch', fetchMock);

        const result = await withFakeRetryTimers(async () => fetchYearAuctions('2026'));
        expect(result!.rows).toHaveLength(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('gives up and throws after exhausting all retry attempts against a persistent 500', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) });
        vi.stubGlobal('fetch', fetchMock);

        await expect(withFakeRetryTimers(async () => fetchYearAuctions('2026'))).rejects.toThrow(/500/);
        expect(fetchMock).toHaveBeenCalledTimes(5); // MAX_RETRY_ATTEMPTS
    });

    it('retries on a genuine network-level failure (a rejected fetch, e.g. DNS failure or connection reset), not just a resolved bad-status response', async () => {
        const fetchMock = vi
            .fn()
            .mockRejectedValueOnce(new TypeError('fetch failed: ECONNRESET'))
            .mockResolvedValueOnce(mockXlsxResponse([['', 45295, 'LTN', 'Venda', '1.ª volta', 45296, 45748, 1_000_000, 0.098997, 0.099024, 680_000, 605_220_929.91, 0, 0, 'LTN 12 meses']]));
        vi.stubGlobal('fetch', fetchMock);

        const result = await withFakeRetryTimers(async () => fetchYearAuctions('2026'));
        expect(result!.rows).toHaveLength(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not retry a non-retryable 4xx (e.g. 403) - fails immediately without wasting the retry budget on a permission error', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) });
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchYearAuctions('2026')).rejects.toThrow(/403/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('passes an AbortController signal so a hung request against a high-latency government server can be aborted', async () => {
        const fetchMock = vi.fn().mockResolvedValue(mockXlsxResponse([]));
        vi.stubGlobal('fetch', fetchMock);

        await fetchYearAuctions('2026');
        const [, options] = fetchMock.mock.calls[0];
        expect(options.signal).toBeInstanceOf(AbortSignal);
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
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => buffer });
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchYearAuctions('2026')).rejects.toThrow(/Auction Date/);
    });
});
