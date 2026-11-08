# Budget, a Ledger module

Monthly budgets for [Ledger](https://github.com/mastifdogo/Bookeeping), with
charts for every account and an AI forecast of next month that you review
before it becomes a budget.

## What it does

- **Budget tab.** Spending or income per currency for the last 12 months
  (bars), this month's budget (a tick on each bar) and next month's AI
  forecast (an orange bar marked `*`). Below that is a table of every revenue
  and expense account with its budget (type an amount, press Enter; clear it
  to remove), the actual figure, a meter showing how much of the budget is used,
  and a 12-month sparkline. **Copy last month's budget** fills in this month
  without overwriting lines you've already set. Use ‹ › to move between
  months.
- **Account charts.** Click any account (from the budget table or the
  **Accounts** tab) to see it per month against its budget and forecast, its
  balance at each month end (a line), and, for balance-sheet accounts, its net
  change per month. Each chart has a *Show as table* view and hover tooltips.
  Ledger's search bar finds them too: type an account name.
- **AI forecast tab.** *Forecast December 2026* sends each revenue/expense
  account's monthly totals for the chosen history, your budgets and the notes
  under Settings → Budget to Ledger's LLM connection. The AI suggests an
  amount and a short reason per account. **Nothing changes until a person
  applies it:** the forecast waits as a pending suggestion (with a dashboard
  to-do) and you can edit amounts, untick lines, then **Apply as budget**
  (writes those lines into that month's budget, replacing existing lines for
  those accounts) or **Reject** it. Earlier forecasts stay listed.
- **Dashboard alerts.** Once an hour, for every organization, and whenever
  this month's budget changes, a notification lists the expense accounts at or
  over the alert threshold of this month's budget.

Amounts are integer cents in each account's own currency. Totals are shown per
currency, never added across CAD and USD. The module never posts journal
entries. It only reads the books through `ctx.ledger`.

## Setup

1. In Ledger: **Settings → Modules**, enter `mastifdogo/budget_module`, Add.
2. For forecasts, an admin sets up an LLM connection under
   **Settings → LLM API** and ticks **Budget** in the list of modules allowed
   to use it. Forecasts use the connection for text. Budgets and
   charts work without it.
3. Optional, under **Settings → Budget**:
   - *Months of history* (3–24, default 12) for charts and forecasts.
   - *Warn when spending reaches* (% of budget, default 100).
   - *Notes for the AI forecast*: known changes, e.g. "Rent rises to $2,100
     from January".

Roles: viewers can see everything; bookkeepers and admins can edit budgets and
request, apply or reject forecasts.

Needs Ledger 0.11.1 or later (per-organization settings).

## API (under `/api/v1/m/budget`)

| Route | |
|---|---|
| `GET /status` | user role, AI status, settings in use |
| `GET /overview?month=YYYY-MM` | revenue/expense accounts and per-currency totals: actual and budget per month, next month's forecast |
| `GET /accounts` | all accounts with balances |
| `GET /accounts/:code/history?month=YYYY-MM` | one account per month: net change, month-end balance, budget, forecast |
| `GET /budgets?month=` · `PUT /budgets` `{month, account_code, amount_cents, note?}` · `DELETE /budgets/:month/:code` | budget lines |
| `POST /budgets/copy` `{from, to}` | copy a month's lines, keeping lines already set |
| `GET /forecasts?status=` · `GET /forecasts/:id` | forecasts |
| `POST /forecasts` `{month?}` | ask the AI (default next month; this month to 3 ahead) → pending forecast |
| `POST /forecasts/:id/apply` `{lines?: [{account_code, amount_cents}]}` | approve (optionally edited) lines into the budget |
| `POST /forecasts/:id/reject` | reject |

## Development

Checks (needs a Ledger checkout and PostgreSQL):

```sh
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
  node <ledger>/.claude/skills/ledger-module/scripts/check-module.ts .
```

Add `--serve 8098` to keep it running and try it in a browser.

## Releasing

Bump `version` in `ledger-module.json` (new features: middle number; fixes:
last number), commit, tag `v<version>`, push the tag and create a GitHub
Release from it. Ledger installs it on its update schedule or with
**Update modules now**. Never edit a released migration. Add the next
`migrations/NNN_name.sql` instead.

## Changes

- **0.0.2**: point to Ledger's renamed **Settings → LLM API** page.
- **0.0.1**: fix AI forecasts with Claude (and strict OpenAI-compatible
  servers), which refused the forecast's JSON schema.
- **0.0.0**: first release: budgets per account and month, account charts,
  AI forecasts with review, dashboard alerts, search.
