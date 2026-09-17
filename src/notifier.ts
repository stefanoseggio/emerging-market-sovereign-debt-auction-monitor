import { log } from 'apify';

import type { OutputRecord } from './types.js';

/**
 * Government-published bond-type/benchmark/auction-type fields are treated as untrusted text for
 * formatting purposes (the same discipline applied from the start here that Actor #2 only added
 * after adversarial review found the gap): interpolating them unescaped into Slack `mrkdwn` or a
 * Teams Adaptive Card's markdown-subset text could let a crafted field inject live formatting.
 * Slack's own documented escaping rule for mrkdwn text: replace `&`, `<`, `>` (in that order).
 */
function escapeSlackMrkdwn(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Adaptive Card TextBlock/FactSet text is a CommonMark-like markdown subset - backslash-escape characters that could start unintended markdown. */
function escapeAdaptiveCardText(value: string): string {
    return value.replace(/[[\]()*_~`\\]/g, (char) => `\\${char}`);
}

function formatRate(decimal: number | null): string {
    if (decimal === null) return 'n/a';
    return `${(decimal * 100).toFixed(4)}%`;
}

function formatRateChange(bps: number | null): string {
    if (bps === null) return 'n/a (first observation)';
    const sign = bps > 0 ? '+' : '';
    return `${sign}${bps} bps`;
}

function formatCoverage(ratio: number | null): string {
    if (ratio === null) return 'n/a';
    return `${(ratio * 100).toFixed(1)}%`;
}

function summaryLine(record: OutputRecord): string {
    const breach = record.yield_threshold_breached || record.coverage_threshold_breached ? ' [THRESHOLD BREACH]' : '';
    return `[Sovereign Debt Monitor] ${record.event_type}: ${record.bond_type} ${record.benchmark ?? record.maturity_date ?? ''} - accepted rate ${formatRate(record.accepted_rate_decimal)} (${formatRateChange(record.rate_change_bps)}), coverage ${formatCoverage(record.coverage_ratio)}${breach}`;
}

async function postJson(url: string, body: unknown, channelLabel: string): Promise<void> {
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            log.warning(`${channelLabel} notification failed with status ${response.status} - continuing (channel delivery is best-effort, not run-blocking).`);
        }
    } catch (error) {
        log.warning(`${channelLabel} notification threw an error - continuing: ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function sendGenericWebhook(url: string, record: OutputRecord): Promise<void> {
    return postJson(url, { text: summaryLine(record), record }, 'Generic webhook');
}

/**
 * Slack Block Kit format via a Slack App's Incoming Webhooks feature (Slack's current, supported
 * method - distinct from the older "legacy custom integrations" webhook path, see README).
 */
async function sendSlackNotification(url: string, record: OutputRecord): Promise<void> {
    const bondLabel = escapeSlackMrkdwn(`${record.bond_type} ${record.benchmark ?? record.maturity_date ?? ''}`.trim());
    const breachBadge = record.yield_threshold_breached || record.coverage_threshold_breached ? ':rotating_light: *THRESHOLD BREACH*' : ':chart_with_upwards_trend: Within threshold';
    const payload = {
        text: summaryLine(record),
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*${record.event_type}*: ${bondLabel}\nAuction date ${record.auction_date} · Settlement ${record.settlement_date ?? 'n/a'}`,
                },
            },
            {
                type: 'section',
                fields: [
                    { type: 'mrkdwn', text: `*Accepted rate:*\n${formatRate(record.accepted_rate_decimal)}` },
                    { type: 'mrkdwn', text: `*Rate change:*\n${formatRateChange(record.rate_change_bps)}` },
                    { type: 'mrkdwn', text: `*Coverage ratio:*\n${formatCoverage(record.coverage_ratio)}` },
                    { type: 'mrkdwn', text: `*Total accepted:*\nR$ ${record.total_amount_accepted?.toLocaleString('en-US') ?? 'n/a'}` },
                ],
            },
            {
                type: 'context',
                elements: [{ type: 'mrkdwn', text: breachBadge }],
            },
        ],
    };
    return postJson(url, payload, 'Slack');
}

/**
 * Microsoft Teams via a "Workflows" webhook URL, posting a standard Adaptive Card - see README
 * for why this targets Workflows rather than the classic connector Microsoft retired in 2026.
 * Honest caveat, not silently omitted: a Power Automate flow's exact expected trigger JSON schema
 * is user-configurable per flow, so the precise body shape a given user's flow accepts can vary.
 */
async function sendTeamsNotification(url: string, record: OutputRecord): Promise<void> {
    const bondLabel = escapeAdaptiveCardText(`${record.bond_type} ${record.benchmark ?? record.maturity_date ?? ''}`.trim());
    const breachText = record.yield_threshold_breached || record.coverage_threshold_breached ? '🚨 THRESHOLD BREACH' : '📈 Within threshold';
    const payload = {
        type: 'message',
        attachments: [
            {
                contentType: 'application/vnd.microsoft.card.adaptive',
                content: {
                    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                    type: 'AdaptiveCard',
                    version: '1.4',
                    body: [
                        {
                            type: 'TextBlock',
                            text: `${record.event_type}: ${bondLabel}`,
                            weight: 'Bolder',
                            size: 'Medium',
                            wrap: true,
                        },
                        {
                            type: 'FactSet',
                            facts: [
                                { title: 'Auction date', value: record.auction_date },
                                { title: 'Accepted rate', value: formatRate(record.accepted_rate_decimal) },
                                { title: 'Rate change', value: formatRateChange(record.rate_change_bps) },
                                { title: 'Coverage ratio', value: formatCoverage(record.coverage_ratio) },
                                { title: 'Status', value: breachText },
                            ],
                        },
                    ],
                },
            },
        ],
    };
    return postJson(url, payload, 'Microsoft Teams');
}

export interface NotifierChannels {
    webhookUrl?: string;
    slackWebhookUrl?: string;
    teamsWebhookUrl?: string;
}

/**
 * Fires every configured channel in parallel. Each channel is independently failure-isolated
 * (postJson never throws), and this function itself never rejects.
 */
export async function notifyAllChannels(channels: NotifierChannels, record: OutputRecord): Promise<void> {
    const sends: Promise<void>[] = [];
    if (channels.webhookUrl) sends.push(sendGenericWebhook(channels.webhookUrl, record));
    if (channels.slackWebhookUrl) sends.push(sendSlackNotification(channels.slackWebhookUrl, record));
    if (channels.teamsWebhookUrl) sends.push(sendTeamsNotification(channels.teamsWebhookUrl, record));
    await Promise.allSettled(sends);
}
