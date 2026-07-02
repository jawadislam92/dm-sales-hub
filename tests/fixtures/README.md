# Parity fixtures

`bookings.parity.json` is the frozen Bookings snapshot the HUB parity test
(`tests/hub.parity.test.ts`) runs against. It contains **only the 7 columns the
metric engine reads** (rep names, lead status, the two dates, and cash) — no
customer PII — but it is still real internal numbers, so it is **git-ignored**
and not committed until the private repo destination + client approval are
confirmed.

Regenerate it from the prototype snapshot:

```bash
node tools/gen-parity-fixture.mjs [path-to-site_data.json]
```

Default source: `C:/Users/jawad/Downloads/Pavan/dashboard-build/data/site_data.json`

Once the private repo is confirmed, we can commit the fixture directly so the
HUB parity gate runs self-contained in CI.
