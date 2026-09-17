import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockExit = vi.fn().mockResolvedValue(undefined);
const mockGetInput = vi.fn();
const mockOn = vi.fn();
const mockOff = vi.fn();

vi.mock('apify', () => ({
    Actor: {
        init: mockInit,
        exit: mockExit,
        getInput: mockGetInput,
        on: mockOn,
        off: mockOff,
    },
    log: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

const mockRun = vi.fn();
vi.mock('../src/routes.js', () => ({ run: (...args: unknown[]) => mockRun(...args) }));

const mockLoadState = vi.fn();
const mockSaveState = vi.fn();
const mockLoadBenchmarkRates = vi.fn();
const mockSaveBenchmarkRates = vi.fn();
vi.mock('../src/state.js', () => ({
    loadState: (...args: unknown[]) => mockLoadState(...args),
    saveState: (...args: unknown[]) => mockSaveState(...args),
    loadBenchmarkRates: (...args: unknown[]) => mockLoadBenchmarkRates(...args),
    saveBenchmarkRates: (...args: unknown[]) => mockSaveBenchmarkRates(...args),
    stateStoreName: (name: string) => `SOVEREIGN-DEBT-DELTA-STATE-${name}`,
}));

function handlerFor(event: string): () => Promise<void> {
    const call = mockOn.mock.calls.find(([e]) => e === event);
    if (!call) throw new Error(`No handler registered for '${event}'`);
    return call[1] as () => Promise<void>;
}

beforeEach(() => {
    vi.resetModules();
    mockInit.mockClear();
    mockExit.mockClear();
    mockGetInput.mockReset();
    mockOn.mockClear();
    mockOff.mockClear();
    mockRun.mockReset();
    mockLoadState.mockReset();
    mockSaveState.mockReset().mockResolvedValue(undefined);
    mockLoadBenchmarkRates.mockReset();
    mockSaveBenchmarkRates.mockReset().mockResolvedValue(undefined);

    mockGetInput.mockResolvedValue({ years: ['2026'] });
    mockLoadState.mockResolvedValue({ auctions: {}, yearCache: {} });
    mockLoadBenchmarkRates.mockResolvedValue({});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('main.ts shutdown-safety wiring', () => {
    it('registers migrating and aborting handlers before running, and deregisters them after a successful run', async () => {
        mockRun.mockResolvedValue({ totalPushed: 1, stopped: false, yearsChecked: 1, byEventType: { NEW_AUCTION: 1 } });

        await import('../src/main.js');

        expect(mockOn).toHaveBeenCalledWith('migrating', expect.any(Function));
        expect(mockOn).toHaveBeenCalledWith('aborting', expect.any(Function));
        expect(mockOff).toHaveBeenCalledWith('migrating', expect.any(Function));
        expect(mockOff).toHaveBeenCalledWith('aborting', expect.any(Function));
        expect(mockExit).toHaveBeenCalledTimes(1);
    });

    it('the registered migrating handler actually flushes both state stores when invoked - the exact regression this wiring exists to prevent', async () => {
        mockRun.mockResolvedValue({ totalPushed: 0, stopped: false, yearsChecked: 1, byEventType: {} });

        await import('../src/main.js');
        const migratingHandler = handlerFor('migrating');

        mockSaveState.mockClear();
        mockSaveBenchmarkRates.mockClear();
        await migratingHandler();

        expect(mockSaveState).toHaveBeenCalledTimes(1);
        expect(mockSaveBenchmarkRates).toHaveBeenCalledTimes(1);
    });

    it('the registered aborting handler also flushes both state stores when invoked', async () => {
        mockRun.mockResolvedValue({ totalPushed: 0, stopped: false, yearsChecked: 1, byEventType: {} });

        await import('../src/main.js');
        const abortingHandler = handlerFor('aborting');

        mockSaveState.mockClear();
        mockSaveBenchmarkRates.mockClear();
        await abortingHandler();

        expect(mockSaveState).toHaveBeenCalledTimes(1);
        expect(mockSaveBenchmarkRates).toHaveBeenCalledTimes(1);
    });

    it('the shutdown handler does not throw even if saving state fails - a flush failure must not crash the shutdown path', async () => {
        mockRun.mockResolvedValue({ totalPushed: 0, stopped: false, yearsChecked: 1, byEventType: {} });

        await import('../src/main.js');
        const migratingHandler = handlerFor('migrating');

        mockSaveState.mockRejectedValueOnce(new Error('KV store unavailable'));
        await expect(migratingHandler()).resolves.toBeUndefined();
    });

    it('saves both state stores even when the run fails, then rethrows - progress already made must not be lost to a later failure', async () => {
        mockRun.mockRejectedValue(new Error('simulated download failure'));

        await expect(import('../src/main.js')).rejects.toThrow('simulated download failure');

        expect(mockSaveState).toHaveBeenCalled();
        expect(mockSaveBenchmarkRates).toHaveBeenCalled();
        expect(mockExit).not.toHaveBeenCalled(); // top-level `await run(); await Actor.exit();` never reaches exit() if run() rethrows
        expect(mockOff).toHaveBeenCalledWith('migrating', expect.any(Function)); // handlers are still deregistered via `finally`
    });

    it('defaults deltaStateName to "default" when Actor.getInput returns nothing', async () => {
        mockGetInput.mockResolvedValue(null);
        mockRun.mockResolvedValue({ totalPushed: 0, stopped: false, yearsChecked: 1, byEventType: {} });

        await import('../src/main.js');

        expect(mockLoadState).toHaveBeenCalledWith('SOVEREIGN-DEBT-DELTA-STATE-default', false);
        // The empty-input object itself is passed straight through to routes.ts's run() - the
        // years=[DEFAULT_YEAR] fallback for a missing `years` field lives there, not in main.ts.
        expect(mockRun.mock.calls[0][0].years).toBeUndefined();
    });
});
