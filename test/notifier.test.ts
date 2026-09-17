import { afterEach, describe, expect, it, vi } from 'vitest';

import { notifyAllChannels } from '../src/notifier.js';
import type { OutputRecord } from '../src/types.js';

function sampleRecord(overrides: Partial<OutputRecord> = {}): OutputRecord {
    return {
        '@type': 'schema:FinancialProduct',
        event_id: 'abc123',
        event_type: 'NEW_AUCTION',
        record_id: 'LTN-Venda-2025-04-01-2024-01-04-1.ª volta',
        auction_date: '2024-01-04',
        bond_type: 'LTN',
        auction_type: 'Venda',
        round: '1.ª volta',
        settlement_date: '2024-01-05',
        maturity_date: '2025-04-01',
        benchmark: 'LTN 12 meses',
        quantity_offered: 1_000_000,
        quantity_accepted: 680_000,
        coverage_ratio: 0.68,
        average_rate_decimal: 0.098997,
        average_rate_bps: 990,
        accepted_rate_decimal: 0.099024,
        accepted_rate_bps: 990,
        rate_change_bps: 15,
        total_amount_accepted: 605_220_929.91,
        total_amount_accepted_currency: 'BRL',
        quantity_to_central_bank: 0,
        total_amount_to_central_bank: 0,
        yield_threshold_breached: true,
        coverage_threshold_breached: false,
        status_fingerprint: 'status-fp',
        content_fingerprint: 'content-fp',
        is_new: true,
        scraped_at: '2026-09-16T12:00:00.000Z',
        ...overrides,
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('notifyAllChannels', () => {
    it('sends nothing when no channels are configured', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        await notifyAllChannels({}, sampleRecord());
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('posts a generic JSON payload with a text summary and the full record when webhookUrl is set', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        await notifyAllChannels({ webhookUrl: 'https://example.com/hook' }, sampleRecord());

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toBe('https://example.com/hook');
        const body = JSON.parse(options.body);
        expect(body.record.bond_type).toBe('LTN');
        expect(body.text).toContain('NEW_AUCTION');
        expect(body.text).toContain('9.9024%');
    });

    it('posts a Slack Block Kit payload with the marginal rate, rate change, and coverage ratio as separate fields', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        await notifyAllChannels({ slackWebhookUrl: 'https://hooks.slack.example/services/T000/B000/xxx' }, sampleRecord());

        const [, options] = fetchMock.mock.calls[0];
        const body = JSON.parse(options.body);
        expect(body.blocks[0].text.text).toContain('LTN LTN 12 meses');
        const fieldsBlock = body.blocks[1];
        expect(fieldsBlock.fields.find((f: { text: string }) => f.text.includes('Accepted rate')).text).toContain('9.9024%');
        expect(fieldsBlock.fields.find((f: { text: string }) => f.text.includes('Rate change')).text).toContain('+15 bps');
        expect(fieldsBlock.fields.find((f: { text: string }) => f.text.includes('Coverage ratio')).text).toContain('68.0%');
    });

    it('shows the threshold-breach badge when yield_threshold_breached is true', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        await notifyAllChannels({ slackWebhookUrl: 'https://hooks.slack.example/services/T000/B000/xxx' }, sampleRecord({ yield_threshold_breached: true }));

        const [, options] = fetchMock.mock.calls[0];
        const body = JSON.parse(options.body);
        expect(body.blocks[2].elements[0].text).toContain('THRESHOLD BREACH');
    });

    it('shows "within threshold" when neither threshold is breached', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        await notifyAllChannels(
            { slackWebhookUrl: 'https://hooks.slack.example/services/T000/B000/xxx' },
            sampleRecord({ yield_threshold_breached: false, coverage_threshold_breached: false }),
        );

        const [, options] = fetchMock.mock.calls[0];
        const body = JSON.parse(options.body);
        expect(body.blocks[2].elements[0].text).toContain('Within threshold');
    });

    it('escapes Slack mrkdwn special characters and mention syntax in registry-sourced fields', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        await notifyAllChannels({ slackWebhookUrl: 'https://hooks.slack.example/services/T000/B000/xxx' }, sampleRecord({ benchmark: '<!channel> & <script>' }));

        const [, options] = fetchMock.mock.calls[0];
        const body = JSON.parse(options.body);
        expect(body.blocks[0].text.text).not.toContain('<!channel>');
        expect(body.blocks[0].text.text).toContain('&lt;!channel&gt; &amp; &lt;script&gt;');
    });

    it('posts a Teams Adaptive Card with the marginal rate, rate change, and coverage ratio as FactSet entries', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        await notifyAllChannels({ teamsWebhookUrl: 'https://prod-00.westeurope.logic.azure.com/workflows/xxx' }, sampleRecord());

        const [, options] = fetchMock.mock.calls[0];
        const body = JSON.parse(options.body);
        expect(body.type).toBe('message');
        expect(body.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
        const factSet = body.attachments[0].content.body.find((el: { type: string }) => el.type === 'FactSet');
        expect(factSet.facts.find((f: { title: string }) => f.title === 'Accepted rate').value).toBe('9.9024%');
        expect(factSet.facts.find((f: { title: string }) => f.title === 'Rate change').value).toBe('+15 bps');
        expect(factSet.facts.find((f: { title: string }) => f.title === 'Coverage ratio').value).toBe('68.0%');
        expect(factSet.facts.find((f: { title: string }) => f.title === 'Status').value).toContain('THRESHOLD BREACH');
    });

    it('escapes Adaptive Card markdown special characters in registry-sourced fields', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        await notifyAllChannels(
            { teamsWebhookUrl: 'https://prod-00.westeurope.logic.azure.com/workflows/xxx' },
            sampleRecord({ benchmark: '[Click here](https://evil.example) *bold*' }),
        );

        const [, options] = fetchMock.mock.calls[0];
        const body = JSON.parse(options.body);
        const textBlock = body.attachments[0].content.body[0];
        expect(textBlock.text).not.toContain('[Click here](https://evil.example)');
        expect(textBlock.text).toContain('\\[Click here\\]\\(https://evil.example\\) \\*bold\\*');
    });

    it('formats a rate change of null as "first observation", not a fabricated 0', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        await notifyAllChannels({ slackWebhookUrl: 'https://hooks.slack.example/services/T000/B000/xxx' }, sampleRecord({ rate_change_bps: null }));

        const [, options] = fetchMock.mock.calls[0];
        const body = JSON.parse(options.body);
        expect(body.blocks[1].fields.find((f: { text: string }) => f.text.includes('Rate change')).text).toContain('first observation');
    });

    it('fires all three channels in parallel when all are configured', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        await notifyAllChannels(
            { webhookUrl: 'https://a.example/hook', slackWebhookUrl: 'https://b.example/hook', teamsWebhookUrl: 'https://c.example/hook' },
            sampleRecord(),
        );
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('isolates a failing channel - one rejected fetch does not stop the others or throw out of notifyAllChannels', async () => {
        const fetchMock = vi.fn().mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce({ ok: true });
        vi.stubGlobal('fetch', fetchMock);

        await expect(
            notifyAllChannels({ webhookUrl: 'https://a.example/hook', slackWebhookUrl: 'https://b.example/hook' }, sampleRecord()),
        ).resolves.toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('isolates a non-2xx response - does not throw, just logs and continues', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
        vi.stubGlobal('fetch', fetchMock);
        await expect(notifyAllChannels({ webhookUrl: 'https://a.example/hook' }, sampleRecord())).resolves.toBeUndefined();
    });
});
