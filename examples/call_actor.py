# Calls the Emerging-Market Sovereign Debt Auction Monitor Actor via the Apify API and prints
# each delivered record. Install first: pip install apify-client
# Run with: APIFY_TOKEN=your_token python examples/call_actor.py

import os

from apify_client import ApifyClient

client = ApifyClient(os.environ["APIFY_TOKEN"])

run_input = {
    "years": ["2026"],
    "bondTypeFilter": ["LTN", "NTN-F"],
    "yieldChangeThresholdBps": 10,
    "coverageRatioFloor": 0.5,
    "onlyNew": True,
    "maxItems": 50,
}

# V3i5xKy1kf7vL0Rue is the Emerging-Market Sovereign Debt Auction Monitor Actor ID.
run = client.actor("V3i5xKy1kf7vL0Rue").call(run_input=run_input)

items = list(client.dataset(run["defaultDatasetId"]).iterate_items())

for item in items:
    print(
        f"{item['event_type']}: {item['bond_type']} {item['benchmark']} - "
        f"{item['accepted_rate_decimal'] * 100:.4f}% ({item['rate_change_bps']} bps)"
    )

print(f"\nFetched {len(items)} records. Full run: https://console.apify.com/actors/runs/{run['id']}")
