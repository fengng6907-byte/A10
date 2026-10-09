# A10 Financial Intelligence

Local-first XAU/USD analysis, risk calculator, trade journal and US stock price monitoring. It never connects to a broker or submits orders.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000. The app starts in **sample data mode** and creates a local SQLite database under `data/` on first use. Sample prices are illustrative and dated; they are never represented as live quotes.

Open **Stock intelligence** in the navigation for the seeded watchlist, price alert rules, queue status and alert history.

Copy `.env.example` to `.env.local` to configure providers. Set `MARKET_DATA_MODE=live` and `TWELVE_DATA_API_KEY` for live XAU/USD candles. The app errors visibly if a selected live provider cannot return enough candles. Optionally set `OPENAI_API_KEY` for AI explanations; without it, deterministic rule-based explanations remain available. Keys stay on the server.

## Stock monitoring (Phases 1–3)

The stock module seeds MSFT, GOOGL, V, AVGO, JNJ, PG, ALAB, RKLB and PLTR once. You can add or remove tickers; there is no fixed universe constraint in the data model. The `EquityDataProvider` interface supports quotes and daily bars, with sample and Twelve Data adapters. The [Twelve Data quote API](https://twelvedata.com/docs/markets/market-state) supplies quote timestamps, volume and 52-week range; plan entitlements determine freshness.

To use live stock monitoring, set `STOCK_DATA_MODE=live`, `TWELVE_DATA_API_KEY`, and `STOCK_QUOTE_ACCESS` in `.env.local`. Set `STOCK_QUOTE_ACCESS` to `REALTIME`, `DELAYED` or `EOD` **only after confirming your data subscription**. If omitted, quote quality is `UNVERIFIED`, and no investment alert fires. The app marks stale quotes and never treats sample prices as live opportunities. Provider request budgets and the monitoring cadence are configurable.

Run the durable worker in a **second terminal**:

```bash
npm run worker
```

The separate worker reads due jobs from SQLite, claims them with a lock, records every run, retries transient failures with backoff and monitors only during regular US market hours. A UI refresh can run one queued monitoring job manually. NYSE regular hours, US daylight saving and standard holidays are handled by `src/stocks/session.ts`; the exchange can announce exceptional closures, so check the [official NYSE calendar](https://www.nyse.com/trade/hours-calendars) before relying on unattended monitoring.

Price rules include above/below target, percentage moves, 52-week levels, unusual volume, opening gaps, a configured price range and optional volume confirmation. Rules require a fresh declared quote class. Events are deduplicated by rule and provider quote timestamp, disarm after triggering, and rearm after the configured buffer and cooldown. Triggered alerts appear **in the app** with quote time, provider, session and source URL.

## Moomoo OpenAPI market data

US equities now support Moomoo's gateway-free REST API as the primary provider. This integration uses `https://webapi.moomoo.com`; it does not require the older OpenD gateway. XAU/USD remains on the existing gold provider in `src/lib/market.ts` and is never replaced with an ETF or futures proxy.

The local `.env.local` selects Moomoo with no automatic fallback. To use Twelve Data as a fallback, set `STOCK_FALLBACK_PROVIDER=twelvedata` and configure `TWELVE_DATA_API_KEY`. `sample` is also supported as an explicitly labeled fallback and can never trigger a verified price alert.

### Connect read-only OAuth

1. Start the app and open **Stock monitoring**.
2. Choose **Connect Moomoo**. The server dynamically registers an OAuth public client when `MOOMOO_CLIENT_ID` is blank, creates a PKCE S256 challenge, and redirects to Moomoo's hosted authorization page.
3. Approve the Moomoo authorization. The callback requires `quote:read` and rejects any `trade:*` scope. Moomoo may bundle `quote:write` and opaque `accid:*` identifiers into the grant; this app reports those as ignored and never calls quote-write, account, or trading endpoints. The application never asks for or receives the brokerage password.
4. Run **Test TSLA + MSFT** in the UI or `npm run moomoo:test`. The test bypasses the quote cache, authenticates a server-side WebSocket, attempts a US basic quote subscription, and prints a redacted REST response with the source and receipt timestamps.
5. A successful US quote subscription records `REALTIME` entitlement locally. A permission or quota rejection remains visible with Moomoo's returned code and message. `MOOMOO_US_QUOTE_ACCESS` is an optional manual override for separately verified account evidence; it is normally left blank.

Access and refresh tokens are encrypted with AES-256-GCM in SQLite. Local development creates an ignored `data/.moomoo-token-key`; production requires a random 32-byte base64 `MOOMOO_TOKEN_ENCRYPTION_KEY`. Tokens are not stored in environment variables, sent to the browser, or written to logs. The OAuth refresh token remains server-side.

### Data behavior and entitlements

The provider batches every current watchlist ticker through `POST /api/v1.0/quote/stock-quote`, reads the exchange's `data_time`, calculates price changes from `prev_close_price`, and gets up to 370 adjusted daily candles from `/api/v1.0/quote/{symbol}/history-kline`. Requests have a timeout, bounded retry with backoff, configurable four-request-per-second throttle, and a short SQLite cache. The monitoring job stores the same verified quotes consumed by price alerts, research market-cap calculations, and daily briefings.

The UI reports `LIVE`, `DELAYED`, `MARKET CLOSED`, `STALE`, or `DISCONNECTED`. A quote is `LIVE` during the regular session only when the account's authenticated US basic quote subscription succeeds (or an explicit verified override exists) and its exchange timestamp is within the freshness threshold. Unknown access remains `DELAYED`; old regular-session data is `STALE`; valid data outside the regular session is `MARKET CLOSED`. Stale, sample, and unverified quotes cannot generate price alerts.

Moomoo documents that subscription permissions and quotas vary by account, market, category, data type, and quote permission level. The current API does not expose the account's LV1/LV2/LV3 label as a public field. The app therefore reports the capability it can verify: whether an authenticated US basic quote subscription is accepted and whether quote pushes arrive. Order-book depth is a separate permission and is not requested. If the probe returns insufficient permission, obtain a US stock basic quote entitlement for the connected Moomoo SG account; if it returns a quota error, release other subscriptions or obtain more subscription quota according to the account plan.

Moomoo's market-data terms limit the data to the authorized user's personal use and prohibit redistribution or dissemination without the applicable provider's prior written consent. This local application caches only the user's research data and does not expose a public quote feed. Review and obtain the appropriate market-data license before making provider data available to other users.

Set `MOOMOO_STREAMING_ENABLED=true` only for the local persistent worker. It opens one server-side WebSocket, authenticates with the server-held bearer token, batches all watched symbols on that connection, refreshes the channel every five minutes, and stores pushes through the existing quote and alert pipeline. Browser WebSockets are intentionally absent, so credentials never reach frontend JavaScript. Vercel Functions are unsuitable for this persistent socket; keep streaming disabled there and use the supported short REST polling jobs. No production schedule is activated.

Official references: [Moomoo REST and OAuth getting started](https://open.moomoo.com/api/overview/getting-started), [stock quote endpoint](https://open.moomoo.com/api/quote/realtime/stock-quote), [historical K-line endpoint](https://open.moomoo.com/api/quote/basic-data/history-kline), [WebSocket authentication](https://open.moomoo.com/api/quote/push/auth), [WebSocket subscriptions](https://open.moomoo.com/api/quote/push/subscribe), [WebSocket quota behavior](https://open.moomoo.com/api/quote/push/rate-limit), and [market-data terms](https://www.moomoo.com/terms).

### Deployment boundary

The local web scripts bind to `127.0.0.1` by default. Vercel can auto-detect and build the Next.js application without a custom deployment configuration. On Vercel, the default SQLite path uses writable `/tmp` storage so server routes can run, but that storage is ephemeral and can reset between function instances or deployments. Persistent watchlists, OAuth grants, alerts, reports, and job locks require a durable server database before production use. The existing Phase 3 price monitor still supports its local worker; persistent WebSocket monitoring is not suitable for Vercel Functions. Add authentication before exposing account-specific data on a public network. Do not treat sample mode or a stopped price worker as active monitoring.

Run `npm test`, `npm run typecheck` and `npm run build` before deployment. Tests cover session timing, daylight saving, holiday closures, alert thresholds, cooldown, rearming, deduplication, provider integration and persistent job retry behavior.

## Financial research, discovery and briefings (Phases 4–7)

Open **Research** from the sidebar. The added pipeline preserves the GOLD AI COPILOT, watchlist and Phase 3 price-alert code.

### Collection and evidence

Set `SEC_USER_AGENT` to an application name and contact email before a live scan. The collector uses the official SEC submissions and Company Facts endpoints, limits itself to eight requests per second, processes 10-K, 10-Q, 8-K and S-1 filings plus amendments, and keeps accession numbers as deduplication keys. SEC 8-K and S-1 filings are also recorded as verified announcements. XBRL normalization stores revenue, net income, diluted EPS, gross profit, operating income, operating cash flow, capital expenditure, derived free cash flow, cash, debt and shares. Derived free cash flow is calculated only when operating cash flow and capital expenditure share the same period and unit.

Configure issuer and permitted news feeds with `IR_FEEDS_JSON` and `NEWS_FEEDS_JSON`. Each value is a JSON array of `{ticker?, url, publisher}`. Only HTTP(S) feeds are accepted; local/private destinations are rejected. The collector stores short excerpts, publisher, original URL and publication time, labels opinion-style news, and deduplicates by both feed identity and content hash. It never attempts to bypass access controls. `IPO_METADATA_JSON` accepts only verified listing facts with a source URL; missing listing dates or IPO prices remain missing.

Financial changes compare actual fiscal periods. Quarterly data is compared both sequentially and against the same fiscal quarter one year earlier; annual data is compared year over year. Later filings for the same period are marked as restatements. Missing values are never replaced with zero.

### Discovery formulas

The quality model allocates 25 points to cash/debt financial health, 25 to positive earnings and cash flow plus margin, 20 to revenue growth and acceleration, 20 to P/S and positive P/E valuation, and 10 to cited competitive evidence. The growth model allocates 25 to year-over-year revenue growth, 20 to cited market opportunity, 20 to cash runway, 15 to cited differentiation, 15 to P/S valuation and 5 to cited execution evidence.

Each component is deterministic. Quantitative ratios are written into the stored component explanation. Qualitative points are awarded only when the assumption and collected source IDs are present. A missing component receives `null`, not zero. The displayed score is normalized over available components, while **data completeness** reports the percentage of the 100-point model supported by available inputs. Screening gates require both a score and minimum completeness. Recent IPO candidates use a verified listing date or a recent S-1; this category does not imply attractiveness.

### AI research controls

Full reports are generated only for qualifying or explicitly requested companies. Deterministic code builds the financial indicators and evidence package first. The model receives source IDs and must return schema-validated JSON with executive summary, business model, financial performance, catalysts, competitive position, valuation, bull/base/bear cases, risks, events and conclusion. Any nonexistent source ID rejects the report. Source text is treated as untrusted data. Reports are cached by evidence hash and historical reports are retained. Model, tokens, configured cost estimate and generation status are stored.

The alert pass optionally uses a lightweight model to classify new material financial changes. With no AI key it skips that stage and keeps deterministic materiality. The full-report stage requires `OPENAI_API_KEY`; failed and invalid generations are recorded rather than converted into invented research.

### Notifications and briefing

Research alerts use category/event fingerprints, per-group cooldowns, materiality thresholds and persistent delivery rows. The in-app center tracks read state and history. Email is opt-in and uses the included Resend adapter only when an address, `RESEND_API_KEY` and `NOTIFICATION_EMAIL_FROM` are configured. Failed email sends retry with bounded exponential backoff and stop after five attempts.

The daily briefing uses Asia/Singapore dates and covers stored prior-session quote moves, watchlist disclosures, discoveries, financial changes, risks and three priority research items. It explicitly says when no meaningful discoveries exist. Generated briefings are retained by Singapore calendar date.

### Local batch commands

```bash
npm run scan:financials
npm run scan:financials -- --tickers=MSFT,AAPL --limit=2
npm run scan:discover
npm run research:generate -- --tickers=MSFT
npm run alerts:process
npm run briefing:daily
```

Each run has a persistent status row, a 15-minute stale-lock recovery window and bounded batch size. Repeated delivery or collection is safe because sources, filings, screenings, reports and notifications have stable unique keys. The same tasks are available as authenticated GET/POST handlers at `/api/research/run/{task}`. In production they require `Authorization: Bearer $CRON_SECRET`; local development allows manual calls when no secret is set.

### Future Vercel scheduling

No `vercel.json` is included, so no production schedule is active. Vercel cron uses UTC. An eventual 08:00 Asia/Singapore briefing would use `0 0 * * *` while Singapore remains UTC+8. Current Vercel documentation limits Hobby cron schedules to once per day with invocation occurring sometime within the selected hour; Pro supports per-minute schedules and per-minute precision. Hobby functions can be configured up to 60 seconds and Pro functions up to 300 seconds, so keep SEC work in the existing resumable batches. Cron delivery can happen more than once, which is why all handlers are idempotent and guarded by stored run state.

Reference documentation: [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces), [SEC developer fair access](https://www.sec.gov/about/developer-resources), [Vercel cron jobs](https://vercel.com/docs/cron-jobs), and [Vercel cron usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing).

## Strategy and safeguards

- 4H direction requires EMA 50/200 and three clear swing highs and lows to agree; tangled or mixed structure is neutral.
- 1H identifies recent swing support/resistance and previous-day levels. 15M confirms a pullback only after a rejection candle and short-term swing break.
- ATR 14 is calculated on 15M candles. Stops use the 1H structural swing; ATR checks stop realism.
- Risk, lot rounding, margin, leverage, reward:risk and limits are calculated in TypeScript. AI can only explain the fixed result.
- A setup is blocked for neutral/misaligned trend, missing risk capacity, insufficient reward:risk, invalid lot/margin/leverage or overly tight stop. Journal plans are also checked server-side.
- Daily and weekly limits use UTC dates and realized journal P&L. Open planned risk also reduces the daily risk budget. Update the account balance in Settings to reflect current equity. V1 does not import broker fills or account transactions.

## Important limitations

The mock data and rule engine are for local workflow demonstration, not a validated trading model. Live API data may be delayed or provider-dependent. The AI explanation has no authority to change decisions, calculations, or risk rules. News risk is unknown in V1. This tool does not predict returns or place trades.

## Project layout

`src/lib/market.ts` — gold market provider; `indicators.ts` and `strategy.ts` — gold analysis; `risk.ts` — gold position sizing and limits; `ai.ts` — optional gold explanation; `db.ts` — shared local SQLite connection. `src/stocks/` contains stock providers, session calculations, alert evaluation, persistence and jobs; `src/worker.ts` is the independent process. `src/app/api` contains server routes, `src/app/page.tsx` the gold workspace, and `src/app/stocks/page.tsx` the stock monitoring page.
