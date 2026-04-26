# n8n

Workflow automation for homelab tasks that are useful but not critical path.

## Weekly Homelab Report

The first useful workflow is a weekly report for the portfolio site. n8n writes
full report data to `/reports/internal` and a deliberately small public summary
to `/reports/public`.

The landing nginx container serves only `/reports/public` at
`https://khe.ee/reports/`. Internal reports are not mounted into nginx.

This keeps generated report data outside the normal `khe-sites` deployment
directory. GitHub Actions can keep replacing `/srv/data/sites/khe` without
deleting the latest report, and generated internal data is not public by
default.

### Host setup

Run once on the Docker VM:

```bash
mkdir -p /srv/data/reports/khe/internal /srv/data/reports/khe/public
chown 1000:1000 /srv/data/reports/khe
chown 1000:1000 /srv/data/reports/khe/internal /srv/data/reports/khe/public
```

Then restart the affected stacks:

```bash
cd /home/khe/homelab/services/ai/n8n
docker compose up -d

cd /home/khe/homelab/services/apps/landing
docker compose up -d
```

### Cloudflare credential

Create a Cloudflare API token for the GraphQL Analytics API:

- Permission: `Account` -> `Account Analytics` -> `Read`
- Account resources: the KHE account
- Zone resources: all zones, or only `khe.ee`

You also need the Cloudflare account ID. In the Cloudflare dashboard URL, it is
the hex string after `https://dash.cloudflare.com/`.

In n8n, store the token as an HTTP Header Auth credential:

- Header name: `Authorization`
- Header value: `Bearer <token>`

### Workflow shape

Use these nodes:

1. Schedule Trigger
   - Weekly, Monday 08:00, timezone `Europe/Tallinn`
2. HTTP Request: Cloudflare Web Analytics
   - Method: `POST`
   - URL: `https://api.cloudflare.com/client/v4/graphql`
   - Auth: the Cloudflare HTTP Header Auth credential above
   - Header: `Content-Type: application/json`
   - Body: JSON
3. Code: Build reports
   - Build a full internal report for your own review.
   - Build a public portfolio summary from a strict allowlist.
   - Do not include IP addresses, user agents, or visitor-level data.
4. Convert to File
   - Operation: Convert to JSON
   - File name: `weekly-homelab.json`
   - Format JSON: on
5. Read/Write Files from Disk
   - Operation: Write File to Disk
   - File path and name: `/reports/internal/weekly-homelab.json`
   - Input binary field: `data`
6. Convert to File
   - Operation: Convert to JSON
   - File name: `portfolio-metrics.json`
   - Format JSON: on
7. Read/Write Files from Disk
   - Operation: Write File to Disk
   - File path and name: `/reports/public/portfolio-metrics.json`
   - Input binary field: `data`

### Cloudflare GraphQL body

Use a 7 day range and filter by host instead of beacon token. The beacon token
is not necessarily the same as Cloudflare's internal `siteTag`.

```json
{
  "query": "query WeeklyRum($accountTag: string!, $start: Time!, $end: Time!) { viewer { accounts(filter: { accountTag: $accountTag }) { kheTotal: rumPageloadEventsAdaptiveGroups(limit: 1, filter: { datetime_geq: $start, datetime_leq: $end, requestHost: \"khe.ee\", bot: 0 }) { count sum { visits } } kheTopPages: rumPageloadEventsAdaptiveGroups(limit: 8, orderBy: [count_DESC], filter: { datetime_geq: $start, datetime_leq: $end, requestHost: \"khe.ee\", bot: 0 }) { count sum { visits } dimensions { requestPath } } gamesTotal: rumPageloadEventsAdaptiveGroups(limit: 1, filter: { datetime_geq: $start, datetime_leq: $end, requestHost: \"games.khe.ee\", bot: 0 }) { count sum { visits } } gamesTopPages: rumPageloadEventsAdaptiveGroups(limit: 8, orderBy: [count_DESC], filter: { datetime_geq: $start, datetime_leq: $end, requestHost: \"games.khe.ee\", bot: 0 }) { count sum { visits } dimensions { requestPath } } } } }",
  "variables": {
    "accountTag": "replace-with-cloudflare-account-id",
    "start": "2026-04-20T00:00:00Z",
    "end": "2026-04-27T00:00:00Z"
  }
}
```

In n8n, generate `start` and `end` dynamically in a Code node or expressions.
Keep the internal report schema stable:

```json
{
  "generatedAt": "2026-04-27T08:00:00+03:00",
  "period": {
    "start": "2026-04-20T00:00:00Z",
    "end": "2026-04-27T00:00:00Z"
  },
  "sites": [
    {
      "host": "khe.ee",
      "pageViews": 0,
      "visits": 0,
      "topPages": []
    },
    {
      "host": "games.khe.ee",
      "pageViews": 0,
      "visits": 0,
      "topPages": []
    }
  ]
}
```

Keep the public schema smaller:

```json
{
  "generatedAt": "2026-04-27T08:00:00+03:00",
  "periodDays": 7,
  "sites": [
    {
      "host": "khe.ee",
      "pageViews": 0,
      "visits": 0
    },
    {
      "host": "games.khe.ee",
      "pageViews": 0,
      "visits": 0
    }
  ],
  "source": "Cloudflare Web Analytics + n8n"
}
```

Do not put top referrers, countries, user agents, internal service state,
container names, ports, versions, or logs in the public file.

### Uptime data

Keep Uptime Kuma alerts in Kuma. For this report, use only a summary signal:

- first pass: add a manual `uptimeSummary` field in the Code node
- later: read from the public status page API once the status page slug is fixed

If uptime data becomes public, publish only a broad aggregate such as
`publicServicesHealthy: true` or `publicUptimePercent: 99.9`.

Do not query Kuma's SQLite database from n8n. That couples the workflow to
Kuma internals and makes backup/restore behavior harder to reason about.

### References

- Cloudflare GraphQL Analytics API: https://developers.cloudflare.com/analytics/graphql-api/
- Cloudflare Analytics API token setup: https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/
- Cloudflare Web Analytics metrics: https://developers.cloudflare.com/web-analytics/data-metrics/high-level-metrics/
- n8n Read/Write Files from Disk: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.readwritefile/
