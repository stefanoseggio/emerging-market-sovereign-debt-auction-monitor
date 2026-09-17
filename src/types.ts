export type RegistryYear =
    | '2000' | '2001' | '2002' | '2003' | '2004' | '2005' | '2006' | '2007' | '2008' | '2009'
    | '2010' | '2011' | '2012' | '2013' | '2014' | '2015' | '2016' | '2017' | '2018' | '2019'
    | '2020' | '2021' | '2022' | '2023' | '2024' | '2025' | '2026' | '2027';

/**
 * The single source of truth for the "current year" fallback used when `input.years` is empty -
 * found by adversarial review to previously exist as three independent hardcoded '2026' literals
 * (here, in src/routes.ts, and in src/main.ts), which would require three simultaneous manual
 * updates when the calendar turns to 2027, with a real risk of missing one. `.actor/input_schema.json`'s
 * own `default` value is a separate JSON literal that cannot import this constant (JSON has no
 * imports) and must still be updated by hand alongside it - documented here so that update isn't
 * missed either.
 */
export const DEFAULT_YEAR: RegistryYear = '2026';

export type BondType = 'LTN' | 'LFT' | 'NTN-B' | 'NTN-F';

export type AuctionType = 'Venda' | 'Troca' | 'Compra' | 'Extra Compra' | 'Extra Venda';

export interface ActorInput {
    years?: RegistryYear[];
    bondTypeFilter?: BondType[];
    auctionTypeFilter?: AuctionType[];
    yieldChangeThresholdBps?: number;
    coverageRatioFloor?: number;
    maxItems?: number;
    deltaStateName?: string;
    resetState?: boolean;
    onlyNew?: boolean;
    webhookUrl?: string;
    slackWebhookUrl?: string;
    teamsWebhookUrl?: string;
}

/**
 * A single auction result row, already mapped from the source's real positional layout (title
 * rows 0-4, Portuguese header row 5, English header row 6, data from row 7 - confirmed live, see
 * ARCHITECTURE.md section 2) to these English field names. Dates are raw Excel serial numbers
 * (not JS Date objects - see dataSource.ts's excelSerialToIsoDate for why `cellDates` is
 * deliberately not used), and rates are raw decimal fractions as published.
 */
export interface RawAuctionRow {
    auctionDateSerial: number | null;
    bondType: string;
    auctionType: string;
    round: string;
    settlementDateSerial: number | null;
    maturityDateSerial: number | null;
    quantityOffered: number | null;
    averageRate: number | null;
    acceptedRate: number | null;
    quantityAccepted: number | null;
    totalAmountAcceptedBrl: number | null;
    quantityToCentralBank: number | null;
    totalAmountToCentralBankBrl: number | null;
    benchmark: string | null;
}

export type EventType = 'NEW_AUCTION' | 'AUCTION_RESULT_REVISED' | 'AUCTION_UNCHANGED' | 'BASELINE_SNAPSHOT';

export interface NormalizedAuction {
    recordId: string;
    auctionDate: string; // ISO YYYY-MM-DD, UTC-canonicalized - see dataSource.ts
    bondType: string;
    auctionType: string;
    round: string;
    settlementDate: string | null;
    maturityDate: string | null;
    benchmark: string | null;
    quantityOffered: number | null;
    quantityAccepted: number | null;
    /** quantityAccepted / quantityOffered - a coverage/take-up ratio, NOT a true bid-to-cover ratio (this source does not publish total market demand). See ARCHITECTURE.md section 3. */
    coverageRatio: number | null;
    averageRateDecimal: number | null;
    averageRateBps: number | null;
    acceptedRateDecimal: number | null;
    acceptedRateBps: number | null;
    totalAmountAcceptedBrl: number | null;
    quantityToCentralBank: number | null;
    totalAmountToCentralBankBrl: number | null;
    /** Fixed to 'BRL' - this source publishes exclusively BRL-denominated domestic auctions. See ARCHITECTURE.md section 4. */
    currency: 'BRL';
}

export interface StoredFingerprint {
    statusFingerprint: string;
    contentFingerprint: string;
    acceptedRateBps: number | null;
    lastSeen: string;
}

export interface YearCacheEntry {
    lastChecked: string;
    baselineComplete: boolean;
}

export interface DeltaState {
    /** Keyed by recordId. */
    auctions: Record<string, StoredFingerprint>;
    /** Keyed by registry year. */
    yearCache: Record<string, YearCacheEntry>;
}

export interface ClassifiedEvent {
    auction: NormalizedAuction;
    eventType: EventType;
    statusFingerprint: string;
    contentFingerprint: string;
    /** Basis-point change in acceptedRateBps versus the previously stored value for this exact recordId, or null if there was no previous value (NEW_AUCTION/BASELINE_SNAPSHOT). */
    rateChangeBps: number | null;
    yieldThresholdBreached: boolean;
    coverageThresholdBreached: boolean;
}

export interface OutputRecord {
    '@type': 'schema:FinancialProduct';
    event_id: string;
    event_type: EventType;
    record_id: string;
    auction_date: string;
    bond_type: string;
    auction_type: string | null;
    round: string | null;
    settlement_date: string | null;
    maturity_date: string | null;
    benchmark: string | null;
    quantity_offered: number | null;
    quantity_accepted: number | null;
    coverage_ratio: number | null;
    average_rate_decimal: number | null;
    average_rate_bps: number | null;
    accepted_rate_decimal: number | null;
    accepted_rate_bps: number | null;
    rate_change_bps: number | null;
    total_amount_accepted: number | null;
    total_amount_accepted_currency: string;
    quantity_to_central_bank: number | null;
    total_amount_to_central_bank: number | null;
    yield_threshold_breached: boolean;
    coverage_threshold_breached: boolean;
    status_fingerprint: string;
    content_fingerprint: string;
    is_new: boolean;
    scraped_at: string;
}
