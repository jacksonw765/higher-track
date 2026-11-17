# Opportunity Desk

A local dashboard of federal contract opportunities, incumbents, and spending. It watches the agencies and topics in [`focus.config.js`](focus.config.js), stores everything in SQLite, and serves a browser UI on your machine.

Nothing here is a hosted service. Each person runs their own copy, with their own API keys and their own database. See [SETUP.md](SETUP.md) for how to hand someone a copy and get them tracking.

## What it shows

| Section | Source | What you get |
| --- | --- | --- |
| Overview | HigherGov + stored contracts | Due dates, forecasts, weekly posting volume, demand by agency and topic, contracts ending within 18 months |
| Opportunities | HigherGov | Notices for the watched agencies and saved searches, scored against the focus topics |
| Agencies | HigherGov contracts + USAspending | Largest contracts per agency, vendor mix, PSC mix, obligation trend |
| Market | USAspending | Government-wide spending for each topic: trend, who buys, who wins, largest awards |
| Grants | Grants.gov | Posted and forecasted grant programs matching each topic’s keywords |
| Research | OpenAI (optional) | A written report on an opportunity, contract, company, or free-form question, with web search |

USAspending and Grants.gov are public and need no key. HigherGov is what fills Opportunities and the contract lists. OpenAI is only used when someone opens Research.

## How a refresh works

Press **Refresh data** in the sidebar (or let the server do it on first launch). `lib/collector.js` then:

1. Pulls HigherGov opportunities one day at a time for each agency (`posted_date`, last 120 days) and each saved search (`captured_date`, last 30 days). Days already stored are skipped, except the last 7 days, which are always re-pulled because notices get amended.
2. Pulls each agency’s largest contracts (count set by `contracts` in the focus file). Those lists refresh at most once every 7 days.
3. In parallel, rebuilds the USAspending profiles and the Grants.gov list.

HigherGov bills by **records returned**, and a standard subscription includes 10,000 records a month. A single refresh stops itself after 1,500 records (`HG_RECORD_BUDGET`) so one click cannot spend the month. Newest days are fetched first; anything left over waits for the next refresh. The sidebar quota bar counts records this app has pulled. HigherGov does not report usage back through the API, so calls made outside this dashboard are missing from that bar. Use **Correct** to type in the figure from the HigherGov usage page.

**Full re-sync** ignores the “already fetched” log and downloads the whole window again. It spends more of the monthly allowance.

The browser always reads SQLite. A refresh writes the database, then the server rebuilds the snapshot the UI loads from `GET /api/snapshot`.

## Layout

```
focus.config.js    What to watch: agencies, saved searches, topics
server.js          HTTP server, refresh trigger, static files
lib/config.js      Keys, paths, and tunables (env vars override defaults)
lib/collector.js   Network → SQLite, and SQLite → the snapshot the UI renders
lib/highergov.js   HigherGov client (opportunity + contract)
lib/usaspending.js USAspending spending profiles
lib/grants.js      Grants.gov search
lib/taxonomy.js    Scores a notice against the topics in focus.config.js
lib/research.js    OpenAI research reports
lib/db.js          SQLite schema and queries
public/            Dashboard (no build step)
data/              Created on first run. Not part of a handoff.
key                API keys, one per line. Not part of a handoff.
```

`lib/taxonomy.js` scores each notice against every topic. Title matches count double, description matches count once, and a matching PSC or NAICS prefix adds a small nudge. A topic is applied once its score clears the threshold in `classify()`.

## Keys

`lib/config.js` reads keys in this order:

1. `HG_API_KEY` and `OPENAI_API_KEY` environment variables, if set.
2. Otherwise a file named `key` in the project root (or the path in `HG_API_KEY_FILE`).

The file is one secret per line, in any order. A line starting with `sk-` is the OpenAI key. Any other non-comment line is the HigherGov key. Lines starting with `#` are ignored, and a `NAME=value` prefix is stripped.

```
# HigherGov key from the API screen
hg_live_example
# OpenAI key (optional; turns Research on)
sk-example
```

The `key` file, `data/`, `.env`, and `node_modules/` are gitignored. Do not send them with a copy of the project.

## Run

Requires Node.js 20 or newer. `better-sqlite3` compiles a small native module on install, so a normal Node install with build tools is enough (on macOS, the Xcode command line tools).

```bash
npm install
npm start
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). The server binds to `127.0.0.1` only. If the database has never been refreshed, the first start begins a refresh immediately. After that it serves stored data until you press **Refresh data**.

## Changing what it tracks

Edit [`focus.config.js`](focus.config.js) and restart the server, then refresh. That file is the only place agencies and topics are defined. The comments at the top of each section say what each field does. [SETUP.md](SETUP.md) walks through adding an agency, a saved search, and a topic.

## Environment variables

| Variable | Default | Effect |
| --- | --- | --- |
| `PORT` | `4173` | Port the dashboard listens on |
| `HOST` | `127.0.0.1` | Bind address. Leave this as localhost. |
| `DASHBOARD_TZ` | `America/New_York` | Timezone for “today” and the optional daily refresh |
| `DB_PATH` | `data/opportunities.db` | SQLite file |
| `HG_API_KEY` | — | HigherGov key, if you are not using the `key` file |
| `OPENAI_API_KEY` | — | OpenAI key, if you are not using the `key` file |
| `HG_API_KEY_FILE` | `./key` | Alternate path to the key file |
| `OPENAI_MODEL` | `gpt-5.5` | Model used for Research. It must support the Responses API and web search. |
| `AUTO_REFRESH_HOUR` | off | Set to `0`–`23` to also refresh once a day at that hour |
| `HG_LOOKBACK_DAYS` | `120` | How far back agency notices are pulled |
| `HG_SEARCH_LOOKBACK_DAYS` | `30` | How far back saved-search notices are pulled |
| `HG_REFETCH_RECENT_DAYS` | `7` | Recent days re-pulled on every refresh |
| `HG_CONTRACT_REFRESH_DAYS` | `7` | Minimum days between contract-list refreshes |
| `HG_RECORD_BUDGET` | `1500` | HigherGov records allowed in one refresh |
| `HG_MONTHLY_ALLOWANCE` | `10000` | Figure the quota bar treats as the monthly cap |
| `HG_CONCURRENCY` | `4` | Parallel HigherGov day-queries |
| `HG_TIMEOUT_MS` | `45000` | Per-request timeout for HigherGov |
| `LANDSCAPE_FY` | `3` | Fiscal years of USAspending history in the agency and market profiles |
| `TREND_START_FY` | `2019` | First fiscal year of the longer trend charts |
