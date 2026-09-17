// Calls the Emerging-Market Sovereign Debt Auction Monitor Actor via the Apify API and prints
// each delivered record. Install first: npm install apify-client
// Run with: APIFY_TOKEN=your_token node examples/call-actor.cjs

const { ApifyClient } = require('apify-client');

const client = new ApifyClient({
    token: process.env.APIFY_TOKEN,
});

const input = {
    years: ['2026'],
    bondTypeFilter: ['LTN', 'NTN-F'],
    yieldChangeThresholdBps: 10,
    coverageRatioFloor: 0.5,
    onlyNew: true,
    maxItems: 50,
};

(async () => {
    // V3i5xKy1kf7vL0Rue is the Emerging-Market Sovereign Debt Auction Monitor Actor ID.
    const run = await client.actor('V3i5xKy1kf7vL0Rue').call(input);

    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    for (const item of items) {
        console.log(
            `${item.event_type}: ${item.bond_type} ${item.benchmark} - ${(item.accepted_rate_decimal * 100).toFixed(4)}% (${item.rate_change_bps} bps)`,
        );
    }

    console.log(`\nFetched ${items.length} records. Full run: https://console.apify.com/actors/runs/${run.id}`);
})();
