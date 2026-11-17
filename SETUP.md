# Setup guide

This is how to give someone else a copy of the dashboard and have them start tracking their own agencies and topics. They need their own HigherGov account (an administrator on that account creates the API key) and, only if they want the Research tab, their own OpenAI key. USAspending and Grants.gov need nothing.

Do not send your `key` file, your `data/` folder, or `node_modules/`. The key spends your HigherGov record allowance and your OpenAI credit. The database is your history, and it is rebuilt from the APIs on first refresh.

## 1. Send the project

Send the source only. From the project folder:

```bash
zip -r opportunity-desk.zip . \
  -x "node_modules/*" "data/*" "key" ".env" ".git/*"
```

A git clone works the same way. Those paths are listed in `.gitignore`, so a normal clone already leaves them out. The recipient creates their own `key` file and their own database.

## 2. Install and start

They need [Node.js 20 or newer](https://nodejs.org). On macOS, install the Xcode command line tools if `npm install` complains about compiling `better-sqlite3` (`xcode-select --install`).

```bash
cd opportunity-desk
npm install
npm start
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173). Leave the server running in that terminal. It only listens on this computer.

The first launch with an empty database starts a refresh on its own. Until a HigherGov key is in place, that refresh still loads USAspending and Grants.gov, and the server log says the HigherGov key is missing. Opportunities and contracts stay empty until the key is added and the server is restarted.

## 3. Create a HigherGov API key

HigherGov is required for opportunities and for the contract lists under Agencies. A standard subscription includes API access and **10,000 records per month**. This app counts every record it receives and stops a single refresh at 1,500 so the allowance lasts.

Only an **account administrator** can create a key.

1. Sign in at [highergov.com](https://www.highergov.com).
2. Click the gear icon in the upper right and choose **API**. HigherGov’s own write-up is [HigherGov API](https://docs.highergov.com/import-and-export/highergov-api).
3. Click **Generate Key**.
4. Copy the full key immediately. HigherGov shows it once on that screen. If it is lost, generate another key; do not reuse someone else’s.

Put the key in a file named `key` in the project root, as its own line:

```
paste-the-highergov-key-here
```

Or set it in the environment instead of a file:

```bash
export HG_API_KEY="paste-the-highergov-key-here"
npm start
```

Restart the server after adding the key. Press **Refresh data**. The first full window (120 days of notices for every watched agency, plus contracts) can take a few minutes and will use a noticeable share of the monthly 10,000 records. Later refreshes only ask for days that are new or were amended in the last week.

The sidebar quota bar is this app’s own count. It does not see requests made in a browser, a script, or another tool with the same key. If the number drifts from what HigherGov shows, click **Correct** and enter the records used this month.

## 4. Create an OpenAI API key (optional)

Skip this if Research can stay off. Opportunities, agencies, market, and grants all work without it.

Research calls the [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses) with web search, using model `gpt-5.5` unless `OPENAI_MODEL` is set. The key’s project needs billing enabled, and the model has to be available on that account.

1. Sign in at [platform.openai.com](https://platform.openai.com).
2. Open [API keys](https://platform.openai.com/api-keys).
3. Create a secret key and copy it. It starts with `sk-`.
4. Add it as another line in `key`. Order does not matter. A line that starts with `sk-` is always treated as OpenAI, so it is never sent to HigherGov.

```
paste-the-highergov-key-here
sk-paste-the-openai-key-here
```

Restart the server. The Research tab turns on once the server log no longer says the OpenAI key is missing. Each report is a paid API call.

## 5. Choose what to track

Everything agency-specific lives in [`focus.config.js`](focus.config.js). Edit it, restart `npm start`, and press **Refresh data**.

### Agencies

Each entry becomes a page under Agencies and a stream of notices under Opportunities.

```js
{
  key: 479,                       // number at the end of the agency's HigherGov URL
  label: 'CISA',                  // short name in the UI
  name: 'Cybersecurity and Infrastructure Security Agency',
  aliases: ['CISA', 'Cybersecurity and Infrastructure Security Agency'],
  usaspending: 'Cybersecurity and Infrastructure Security Agency',
  role: 'funding',                // 'funding' or 'awarding'
  contracts: 100,                 // largest contracts to keep; 0 skips contracts
},
```

- **key.** Open the agency on HigherGov. The agency key is the number at the end of that page’s URL.
- **aliases.** Other offices sometimes post work for this agency. Any alias listed here is flagged as a mention on notices that belong to a different watched agency. Short acronyms are matched in uppercase only (`DISA` matches, `disa` does not).
- **usaspending.** The exact sub-agency name USAspending uses, which drives the spending charts. Look the office up on [usaspending.gov](https://www.usaspending.gov) and copy the name as it appears. Leave it out if you only want HigherGov notices.
- **role.** `funding` if the agency mostly pays for work that other offices award (CISA, USCYBERCOM). `awarding` if it is the contracting shop (DHS OCPO, DISA). This decides which HigherGov contract filter and which USAspending agency filter is used.
- **contracts.** How many of the largest awards to store, ordered by potential value. Each award is a HigherGov record, so a long list costs allowance on the refresh that pulls it. The list is kept for 7 days before it is fetched again.

### Keyword coverage (saved searches)

HigherGov’s API has no free-text search. To watch a keyword that is not tied to one agency, build the search on the HigherGov website and paste its id here.

1. On HigherGov, run the search you want (for example a keyword, NAICS, or set-aside search).
2. Save it, or just copy the `searchID` query parameter from the page URL: `https://www.highergov.com/contract-opportunity/?searchID=AbC123…`
3. Add it to `savedSearches`:

```js
savedSearches: [
  { id: 'AbC123…', label: 'Cyber keywords' },
],
```

Saved searches are pulled for the last 30 days (`HG_SEARCH_LOOKBACK_DAYS`), using the date HigherGov captured the notice. Supported search fields are the ones HigherGov documents for `search_id` on the opportunity endpoint (keywords, agency, NAICS, PSC, set-aside, dates, and the rest listed in their [API docs](https://docs.highergov.com/import-and-export/highergov-api)).

### Topics

Topics do not add API calls by themselves. They label notices you have already downloaded, and they supply the keywords for the Market and Grants tabs.

Copy a block in `topics`, give it a new `id`, `label`, and `color`, and edit:

- **terms.** Each row is `[pattern, weight, label]`. `pattern` is a JavaScript regular expression, or an array of them (any one matching counts). Title hits score double. Weight `3` is a strong signal, `1` is a weak one. A topic is applied once the combined score reaches 3, so a single weak hit will not tag a notice.
- **psc / naics.** Code prefixes that add a small bonus when they match. `/^DJ/` matches any PSC starting with DJ.
- **usaspendingKeywords.** Words sent to USAspending for the government-wide market view. Keep the list tight. Broad words pull in unrelated awards, and each keyword set is one profile rebuild on every refresh.
- **grantsKeywords.** Words sent to Grants.gov. Same idea: a few specific phrases, not a whole taxonomy.

The four topics already in the file (cybersecurity, AI and data science, analytics, data platforms) are a starting point. Delete the ones you do not want. Removing a topic stops it from being scored and drops its market and grant queries. Notices already stored stay in the database until they age out of the look-back window.

## 6. Check that tracking is working

After the first refresh finishes:

- The sidebar status line shows when data was last refreshed. If the refresh was incomplete, a notice at the top of the page lists the warnings, and the same lines are printed in the server terminal.
- **Opportunities** lists notices for the agencies and saved searches. Empty here, with a key configured, usually means the agency key is wrong or the look-back window has nothing posted.
- **Agencies** shows contracts after that agency’s contract pull succeeds. A funding agency with the wrong `role` will come back with the wrong award set.
- **Market** and **Grants** fill in even when the HigherGov key is missing. An empty market chart for one topic usually means the USAspending keywords returned nothing in the fiscal-year window.

Save notices you care about with the save control on the opportunity. Those flags live in the local database only.

## What not to share

| Path | Why it stays behind |
| --- | --- |
| `key` | HigherGov and OpenAI secrets |
| `data/` | Your SQLite database, including saved notices and research reports |
| `.env` | Same secrets, if you used environment variables in a file |
| `node_modules/` | Reinstalled with `npm install` |

Each person generates keys on their own accounts. Two people sharing one HigherGov key also share the 10,000-record monthly allowance.
