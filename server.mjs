// Budget module for Ledger: monthly budgets per revenue/expense account,
// chart data for any account, and AI forecasts of the next month that a
// person applies (or rejects) before they become budget lines.
// API reference: docs/MODULE_LLM_CONTEXT.md in the Ledger repository.

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const PL_TYPES = new Set(["revenue", "expense"]);
const MAX_CENTS = 10n ** 13n; // $100 billion: anything above is a typo

// ---- month helpers ("YYYY-MM") ----
const ymOf = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const thisMonth = () => ymOf(new Date());
function addMonths(ym, n) {
	const [y, m] = ym.split("-").map(Number);
	return ymOf(new Date(Date.UTC(y, m - 1 + n, 1)));
}
const firstDay = (ym) => `${ym}-01`;
function lastDay(ym) {
	const [y, m] = ym.split("-").map(Number);
	return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}
function monthRange(endYm, count) {
	const out = [];
	for (let i = count - 1; i >= 0; i--) out.push(addMonths(endYm, -i));
	return out;
}
const monthName = (ym) =>
	new Date(`${ym}-15T00:00:00Z`).toLocaleString("en", { month: "long", year: "numeric", timeZone: "UTC" });

/** @param {any} ctx */
export default async function register(ctx) {
	const T = {
		lines: `${ctx.schema}.budget_lines`,
		forecasts: `${ctx.schema}.forecasts`,
	};
	const fail = (status, msg) => {
		throw new ctx.HttpError(status, msg);
	};

	// ---- input parsing ----
	function parseMonth(v, field, fallback) {
		if (v === undefined || v === null || v === "") {
			if (fallback !== undefined) return fallback;
			fail(422, `${field} is required (YYYY-MM)`);
		}
		if (typeof v !== "string" || !MONTH_RE.test(v)) fail(422, `${field} must be a month like 2026-11`);
		return v;
	}
	function parseCents(v, field) {
		let n;
		if (typeof v === "number" && Number.isSafeInteger(v)) n = BigInt(v);
		else if (typeof v === "string" && /^\d{1,15}$/.test(v)) n = BigInt(v);
		else fail(422, `${field} must be a whole number of cents`);
		if (n < 0n || n > MAX_CENTS) fail(422, `${field} is out of range`);
		return n;
	}
	const code = (v, field = "account_code") =>
		typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(v) ? v : fail(422, `${field} must be an account code`);
	const idParam = (v) => (/^\d{1,18}$/.test(v) ? v : fail(404, "no such forecast"));

	async function settings() {
		const s = (await ctx.settings.get()) || {};
		const n = (v, lo, hi, d) => (typeof v === "number" && v >= lo && v <= hi ? Math.round(v) : d);
		return {
			historyMonths: n(s.history_months, 3, 24, 12),
			alertPct: n(s.alert_threshold_pct, 50, 200, 100),
			instructions: typeof s.forecast_instructions === "string" ? s.forecast_instructions.trim() : "",
		};
	}

	async function plAccounts({ includeInactive = false } = {}) {
		return (await ctx.ledger.listAccounts({ includeInactive })).filter((a) => PL_TYPES.has(a.type));
	}

	/**
	 * Revenue/expense activity per account for each month (natural sign:
	 * positive spending for expenses, positive income for revenue).
	 * → Map<account_code, bigint[]> aligned with `months`.
	 */
	async function plActuals(months) {
		const statements = await Promise.all(months.map((ym) => ctx.ledger.incomeStatement({ from: firstDay(ym), to: lastDay(ym) })));
		const out = new Map();
		statements.forEach((st, i) => {
			for (const cur of st.currencies || []) {
				for (const line of [...(cur.revenue || []), ...(cur.expenses || [])]) {
					if (!out.has(line.account_code)) out.set(line.account_code, months.map(() => 0n));
					out.get(line.account_code)[i] += BigInt(line.amount_cents);
				}
			}
		});
		return out;
	}

	async function budgetsFor(months) {
		const { rows } = await ctx.db.query(
			`SELECT to_char(month, 'YYYY-MM') AS month, account_code, currency, amount_cents, note, updated_by, updated_at
			   FROM ${T.lines} WHERE month BETWEEN $1::date AND $2::date ORDER BY account_code, month`,
			[firstDay(months[0]), firstDay(months[months.length - 1])],
		);
		return rows;
	}

	async function latestForecast(ym) {
		const { rows } = await ctx.db.query(
			`SELECT id, to_char(month, 'YYYY-MM') AS month, status, summary, lines, model, requested_by, decided_by, decided_at, created_at
			   FROM ${T.forecasts} WHERE month = $1::date AND status <> 'rejected' ORDER BY id DESC LIMIT 1`,
			[firstDay(ym)],
		);
		return rows[0] || null;
	}

	// ---- status ----
	ctx.route("GET", "/status", async (req) => {
		let llm;
		try {
			llm = await ctx.llm.status();
		} catch (e) {
			llm = { configured: false, allowed: false, error: e.message };
		}
		const s = await settings();
		return {
			user: { username: req.user.username, role: req.user.role },
			can_edit: req.user.role !== "viewer",
			llm,
			this_month: thisMonth(),
			history_months: s.historyMonths,
			alert_threshold_pct: s.alertPct,
		};
	});

	// ---- overview: every revenue/expense account, actual vs budget ----
	// GET /overview?month=YYYY-MM  (default: this month)
	ctx.route("GET", "/overview", async (req) => {
		const month = parseMonth(req.query.get("month"), "month", thisMonth());
		const s = await settings();
		const months = monthRange(month, s.historyMonths);
		const next = addMonths(month, 1);
		const [accounts, actuals, budgets, forecast] = await Promise.all([
			plAccounts({ includeInactive: true }),
			plActuals(months),
			budgetsFor([...months, next]),
			latestForecast(next),
		]);
		const budgetMap = new Map(); // code -> Map(month -> cents)
		for (const b of budgets) {
			if (!budgetMap.has(b.account_code)) budgetMap.set(b.account_code, new Map());
			budgetMap.get(b.account_code).set(b.month, b);
		}
		const fcLines = new Map((forecast?.lines || []).map((l) => [l.account_code, l]));
		const rows = [];
		for (const a of accounts) {
			const act = actuals.get(a.code) || months.map(() => 0n);
			const bm = budgetMap.get(a.code) || new Map();
			const hasData = act.some((v) => v !== 0n) || bm.size > 0 || fcLines.has(a.code);
			if (!a.is_active && !hasData) continue;
			rows.push({
				code: a.code,
				name: a.name,
				type: a.type,
				currency: a.currency,
				is_active: a.is_active,
				actual: act,
				budget: months.map((m) => (bm.has(m) ? bm.get(m).amount_cents : null)),
				note: bm.get(month)?.note || "",
				next_budget: bm.has(next) ? bm.get(next).amount_cents : null,
				forecast: fcLines.has(a.code) ? fcLines.get(a.code).amount_cents : null,
			});
		}
		// Totals per currency and type (never across currencies).
		const totals = new Map();
		for (const r of rows) {
			const k = `${r.currency}:${r.type}`;
			if (!totals.has(k))
				totals.set(k, {
					currency: r.currency,
					type: r.type,
					actual: months.map(() => 0n),
					budget: months.map(() => 0n),
					budgeted: months.map(() => false),
					// actual of only the accounts that have a budget that month
					budgeted_actual: months.map(() => 0n),
					next_budget: null,
					forecast: null,
				});
			const t = totals.get(k);
			r.actual.forEach((v, i) => (t.actual[i] += BigInt(v)));
			r.budget.forEach((v, i) => {
				if (v !== null) {
					t.budget[i] += BigInt(v);
					t.budgeted[i] = true;
					t.budgeted_actual[i] += BigInt(r.actual[i]);
				}
			});
			if (r.next_budget !== null) t.next_budget = (t.next_budget ?? 0n) + BigInt(r.next_budget);
			if (r.forecast !== null) t.forecast = (t.forecast ?? 0n) + BigInt(r.forecast);
		}
		const totalList = [...totals.values()].map((t) => ({
			...t,
			budget: t.budget.map((v, i) => (t.budgeted[i] ? v : null)),
			budgeted: undefined,
		}));
		return {
			month,
			months,
			next_month: next,
			accounts: rows,
			totals: totalList,
			forecast: forecast && { id: forecast.id, status: forecast.status, month: forecast.month },
		};
	});

	// ---- chart data for any account ----
	// GET /accounts/:code/history?month=YYYY-MM
	ctx.route("GET", "/accounts/:code/history", async (req) => {
		const accountCode = code(req.params.code, "account");
		const month = parseMonth(req.query.get("month"), "month", thisMonth());
		const s = await settings();
		const months = monthRange(month, s.historyMonths);
		const led = await ctx.ledger.accountLedger(accountCode, { from: firstDay(months[0]), to: lastDay(month) });
		const a = led.account;
		// Natural sign: debit-positive for assets/expenses, credit-positive otherwise.
		const sign = a.type === "asset" || a.type === "expense" ? 1n : -1n;
		const idx = new Map(months.map((m, i) => [m, i]));
		const activity = months.map(() => 0n);
		for (const l of led.lines) {
			const i = idx.get(String(l.entry_date).slice(0, 7));
			if (i !== undefined) activity[i] += (BigInt(l.debit_cents) - BigInt(l.credit_cents)) * sign;
		}
		const balance = [];
		let run = BigInt(led.opening_balance_cents) * sign;
		for (const v of activity) balance.push((run += v));
		const out = {
			account: { code: a.code, name: a.name, type: a.type, currency: a.currency, is_active: a.is_active },
			month,
			months,
			next_month: addMonths(month, 1),
			activity,
			balance,
			opening_balance_cents: BigInt(led.opening_balance_cents) * sign,
			budget: null,
			forecast: null,
		};
		if (PL_TYPES.has(a.type)) {
			const [budgets, fc] = await Promise.all([budgetsFor([...months, out.next_month]), latestForecast(out.next_month)]);
			const bm = new Map(budgets.filter((b) => b.account_code === a.code).map((b) => [b.month, b.amount_cents]));
			out.budget = months.map((m) => (bm.has(m) ? bm.get(m) : null));
			out.next_budget = bm.has(out.next_month) ? bm.get(out.next_month) : null;
			const fl = (fc?.lines || []).find((l) => l.account_code === a.code);
			if (fl) out.forecast = { forecast_id: fc.id, status: fc.status, amount_cents: fl.amount_cents, reason: fl.reason };
		}
		return out;
	});

	// ---- accounts (for the Accounts tab) ----
	ctx.route("GET", "/accounts", async () => {
		const accounts = await ctx.ledger.listAccounts();
		return { data: accounts.map((a) => ({ code: a.code, name: a.name, type: a.type, currency: a.currency, balance_cents: a.balance_cents })) };
	});

	// ---- budget lines ----
	ctx.route("GET", "/budgets", async (req) => {
		const month = parseMonth(req.query.get("month"), "month", thisMonth());
		return { month, data: await budgetsFor([month]) };
	});

	// PUT /budgets {month, account_code, amount_cents, note?}
	ctx.route("PUT", "/budgets", async (req) => {
		const b = req.body ?? {};
		const month = parseMonth(b.month, "month");
		const accountCode = code(b.account_code);
		const cents = parseCents(b.amount_cents, "amount_cents");
		if (b.note !== undefined && (typeof b.note !== "string" || b.note.length > 500)) fail(422, "note must be text up to 500 characters");
		const account = (await plAccounts({ includeInactive: true })).find((a) => a.code === accountCode);
		if (!account) fail(422, `${accountCode} is not a revenue or expense account`);
		const { rows } = await ctx.db.query(
			`INSERT INTO ${T.lines} (month, account_code, currency, amount_cents, note, updated_by)
			 VALUES ($1::date, $2, $3, $4, $5, $6)
			 ON CONFLICT (month, account_code) DO UPDATE
			   SET amount_cents = EXCLUDED.amount_cents, currency = EXCLUDED.currency,
			       note = COALESCE($7, ${T.lines}.note), updated_by = EXCLUDED.updated_by, updated_at = now()
			 RETURNING to_char(month, 'YYYY-MM') AS month, account_code, currency, amount_cents, note, updated_by, updated_at`,
			[firstDay(month), accountCode, account.currency, cents, (b.note ?? "").trim(), req.user.username, b.note === undefined ? null : b.note.trim()],
		);
		if (month === thisMonth()) checkAlerts().catch((e) => ctx.log.warn("budget alert check failed", { error: e.message }));
		return rows[0];
	});

	// DELETE /budgets/:month/:code
	ctx.route("DELETE", "/budgets/:month/:code", async (req) => {
		const month = parseMonth(req.params.month, "month");
		const accountCode = code(req.params.code);
		const { rowCount } = await ctx.db.query(`DELETE FROM ${T.lines} WHERE month = $1::date AND account_code = $2`, [firstDay(month), accountCode]);
		if (rowCount === 0) fail(404, "no budget for that account and month");
		if (month === thisMonth()) checkAlerts().catch(() => {});
	});

	// POST /budgets/copy {from, to}: copy one month's budget to another, keeping lines already set there.
	ctx.route("POST", "/budgets/copy", async (req) => {
		const b = req.body ?? {};
		const from = parseMonth(b.from, "from");
		const to = parseMonth(b.to, "to");
		if (from === to) fail(422, "from and to must be different months");
		const { rowCount } = await ctx.db.query(
			`INSERT INTO ${T.lines} (month, account_code, currency, amount_cents, note, updated_by)
			 SELECT $2::date, account_code, currency, amount_cents, note, $3 FROM ${T.lines} WHERE month = $1::date
			 ON CONFLICT (month, account_code) DO NOTHING`,
			[firstDay(from), firstDay(to), req.user.username],
		);
		return { copied: rowCount };
	});

	// ---- AI forecasts (suggestions until a person applies them) ----
	const forecastCols = `id, to_char(month, 'YYYY-MM') AS month, status, summary, lines, model, requested_by, decided_by, decided_at, created_at`;

	ctx.route("GET", "/forecasts", async (req) => {
		const status = req.query.get("status");
		if (status && !["pending", "applied", "rejected"].includes(status)) fail(422, "status must be pending, applied or rejected");
		const { rows } = await ctx.db.query(
			`SELECT ${forecastCols} FROM ${T.forecasts} WHERE ($1::text IS NULL OR status = $1) ORDER BY id DESC LIMIT 50`,
			[status || null],
		);
		return { data: rows };
	});

	ctx.route("GET", "/forecasts/:id", async (req) => {
		const { rows } = await ctx.db.query(`SELECT ${forecastCols} FROM ${T.forecasts} WHERE id = $1`, [idParam(req.params.id)]);
		if (!rows[0]) fail(404, "no such forecast");
		return rows[0];
	});

	const FORECAST_SCHEMA = {
		type: "object",
		properties: {
			summary: { type: "string", description: "2-4 sentences on the overall outlook for the month." },
			lines: {
				type: "array",
				items: {
					type: "object",
					properties: {
						account_code: { type: "string" },
						amount_cents: { type: "integer", minimum: 0, description: "Forecast total for the month in integer cents, natural sign (positive)." },
						reason: { type: "string", description: "One short sentence: why this amount." },
					},
					required: ["account_code", "amount_cents", "reason"],
				},
			},
		},
		required: ["summary", "lines"],
	};

	// POST /forecasts {month?: "YYYY-MM"}  (default: next month)
	ctx.route("POST", "/forecasts", async (req) => {
		const b = req.body ?? {};
		if (typeof b !== "object" || Array.isArray(b)) fail(422, "body must be an object");
		const today = thisMonth();
		const target = parseMonth(b.month, "month", addMonths(today, 1));
		if (target < today || target > addMonths(today, 3)) fail(422, "forecasts can be made for this month or up to 3 months ahead");
		const st = await ctx.llm.status();
		if (!st.configured) fail(409, "No AI provider is set up. An admin can add one under Settings → AI.");
		if (!st.allowed) fail(409, "The Budget module isn't allowed to use AI yet. An admin can allow it under Settings → AI.");

		const s = await settings();
		const histEnd = addMonths(target, -1) > today ? today : addMonths(target, -1);
		const months = monthRange(histEnd, s.historyMonths);
		const [accounts, actuals, budgets] = await Promise.all([plAccounts(), plActuals(months), budgetsFor([...months, target])]);
		if (accounts.length === 0) fail(409, "There are no active revenue or expense accounts to forecast.");
		const byCode = new Map(accounts.map((a) => [a.code, a]));
		const budgetOf = new Map(budgets.map((b) => [`${b.month}|${b.account_code}`, b.amount_cents]));
		const now = new Date();
		const daysIn = Number(lastDay(today).slice(8));
		const history = accounts
			.map((a) => {
				const act = actuals.get(a.code) || months.map(() => 0n);
				return {
					account_code: a.code,
					name: a.name,
					type: a.type,
					currency: a.currency,
					monthly_cents: Object.fromEntries(months.map((m, i) => [m, Number(act[i])])),
					budget_cents: Object.fromEntries(
						[...months, target].filter((m) => budgetOf.has(`${m}|${a.code}`)).map((m) => [m, Number(budgetOf.get(`${m}|${a.code}`))]),
					),
				};
			})
			// Accounts that never moved and have no budget add noise only.
			.filter((h) => Object.values(h.monthly_cents).some((v) => v !== 0) || Object.keys(h.budget_cents).length > 0);
		if (history.length === 0) fail(409, `No revenue or expense activity in the last ${s.historyMonths} months to forecast from.`);

		const partial = months.includes(today)
			? `${today} is the current month and only ${now.getUTCDate()} of ${daysIn} days have passed, so its figures are partial.`
			: "";
		const prompt = [
			`Forecast each account's total for ${target} (${monthName(target)}).`,
			`History (amounts are integer cents in each account's own currency, positive = normal for the account type: income for revenue, spending for expense). ${partial}`,
			JSON.stringify(history),
			s.instructions ? `Notes from the bookkeeper:\n${s.instructions}` : "",
			"Return one line per account above that you expect to have activity (skip accounts you expect to be zero). Use the account_code exactly as given. amount_cents is an integer in cents.",
		]
			.filter(Boolean)
			.join("\n\n");
		const res = await ctx.llm.json({
			system:
				"You are a careful bookkeeper forecasting a small organization's monthly revenue and expenses for budgeting. " +
				"Base each figure on recurring patterns, seasonality (same month last year if present), trends and the bookkeeper's notes. " +
				"Do not invent accounts. Be conservative with one-off spikes. Keep each reason under 20 words.",
			prompt,
			schema: FORECAST_SCHEMA,
			maxTokens: 4000,
		});
		const data = res.data || {};
		const seen = new Set();
		const lines = [];
		for (const l of Array.isArray(data.lines) ? data.lines : []) {
			const a = byCode.get(l?.account_code);
			if (!a || seen.has(a.code)) continue;
			const n = Number(l.amount_cents);
			if (!Number.isFinite(n) || n < 0 || n > Number(MAX_CENTS)) continue;
			seen.add(a.code);
			lines.push({
				account_code: a.code,
				name: a.name,
				type: a.type,
				currency: a.currency,
				amount_cents: Math.round(n),
				reason: String(l.reason ?? "").slice(0, 500),
			});
		}
		if (lines.length === 0) fail(502, "The AI's forecast had no usable lines. Try again.");
		const summary = String(data.summary ?? "").slice(0, 4000);
		const { rows } = await ctx.db.query(
			`INSERT INTO ${T.forecasts} (month, summary, lines, model, requested_by) VALUES ($1::date, $2, $3::jsonb, $4, $5) RETURNING ${forecastCols}`,
			[firstDay(target), summary, JSON.stringify(lines), String(res.model || st.model || "").slice(0, 200), req.user.username],
		);
		const f = rows[0];
		await ctx.dashboard
			.todo({
				key: `forecast-${f.id}`,
				title: `Review the AI budget forecast for ${monthName(target)}`,
				body: `${lines.length} accounts. Apply it to set the month's budget, or reject it.`,
				link: `/apps/budget?forecast=${f.id}`,
			})
			.catch((e) => ctx.log.warn("dashboard todo failed", { error: e.message }));
		return ctx.response(201, f);
	});

	// POST /forecasts/:id/apply {lines?: [{account_code, amount_cents}]}
	// A person approves the forecast (optionally edited / a subset) and it becomes the month's budget.
	ctx.route("POST", "/forecasts/:id/apply", async (req) => {
		const id = idParam(req.params.id);
		const b = req.body ?? {};
		const { rows: found } = await ctx.db.query(`SELECT ${forecastCols} FROM ${T.forecasts} WHERE id = $1`, [id]);
		const f = found[0];
		if (!f) fail(404, "no such forecast");
		if (f.status !== "pending") fail(409, `This forecast was already ${f.status}.`);
		const accounts = new Map((await plAccounts({ includeInactive: true })).map((a) => [a.code, a]));
		let chosen;
		if (b.lines === undefined) chosen = f.lines.map((l) => ({ account_code: l.account_code, amount_cents: l.amount_cents }));
		else if (!Array.isArray(b.lines) || b.lines.length > 1000) fail(422, "lines must be a list");
		else chosen = b.lines;
		const seen = new Set();
		const apply = chosen.map((l, i) => {
			const c = code(l?.account_code, `lines[${i}].account_code`);
			const a = accounts.get(c) || fail(422, `${c} is not a revenue or expense account`);
			if (seen.has(c)) fail(422, `${c} appears twice`);
			seen.add(c);
			return { account_code: c, currency: a.currency, amount_cents: parseCents(l.amount_cents, `lines[${i}].amount_cents`).toString() };
		});
		if (apply.length === 0) fail(422, "Pick at least one line to apply, or reject the forecast.");
		// One statement: mark applied only if still pending, and write the lines only then.
		const { rows } = await ctx.db.query(
			`WITH f AS (
			   UPDATE ${T.forecasts} SET status = 'applied', decided_by = $2, decided_at = now()
			    WHERE id = $1 AND status = 'pending' RETURNING id, month
			 ), ins AS (
			   INSERT INTO ${T.lines} (month, account_code, currency, amount_cents, note, updated_by)
			   SELECT f.month, x.account_code, x.currency, x.amount_cents::bigint, 'AI forecast #' || f.id, $2
			     FROM f, jsonb_to_recordset($3::jsonb) AS x(account_code text, currency text, amount_cents text)
			   ON CONFLICT (month, account_code) DO UPDATE
			     SET amount_cents = EXCLUDED.amount_cents, currency = EXCLUDED.currency, note = EXCLUDED.note,
			         updated_by = EXCLUDED.updated_by, updated_at = now()
			   RETURNING 1
			 )
			 SELECT (SELECT count(*) FROM f)::int AS updated, (SELECT count(*) FROM ins)::int AS lines`,
			[id, req.user.username, JSON.stringify(apply)],
		);
		if (rows[0].updated === 0) fail(409, "This forecast was already decided.");
		await ctx.dashboard.complete(`forecast-${id}`).catch(() => {});
		if (f.month === thisMonth()) checkAlerts().catch(() => {});
		return { id: f.id, status: "applied", month: f.month, lines: rows[0].lines };
	});

	ctx.route("POST", "/forecasts/:id/reject", async (req) => {
		const id = idParam(req.params.id);
		const { rows } = await ctx.db.query(
			`UPDATE ${T.forecasts} SET status = 'rejected', decided_by = $2, decided_at = now()
			  WHERE id = $1 AND status = 'pending' RETURNING ${forecastCols}`,
			[id, req.user.username],
		);
		if (!rows[0]) {
			const { rowCount } = await ctx.db.query(`SELECT 1 FROM ${T.forecasts} WHERE id = $1`, [id]);
			fail(rowCount ? 409 : 404, rowCount ? "This forecast was already decided." : "no such forecast");
		}
		await ctx.dashboard.complete(`forecast-${id}`).catch(() => {});
		return rows[0];
	});

	// ---- search: "budget rent" finds the account's chart ----
	ctx.search.provide(async (query, { limit }) => {
		const q = String(query || "").trim().toLowerCase();
		if (q.length < 2) return [];
		const accounts = await ctx.ledger.listAccounts();
		return accounts
			.filter((a) => a.code.toLowerCase().startsWith(q) || a.name.toLowerCase().includes(q))
			.slice(0, Math.min(limit || 5, 5))
			.map((a) => ({ title: `${a.name} · chart`, subtitle: `Budget · ${a.code} · ${a.type}`, href: `/apps/budget?account=${encodeURIComponent(a.code)}` }));
	});

	// ---- over-budget alerts on the dashboard (current organization) ----
	async function checkAlerts() {
		const month = thisMonth();
		const s = await settings();
		const budgets = await budgetsFor([month]);
		const key = `over-${month}`;
		if (budgets.length === 0) {
			await ctx.dashboard.remove(key, "notification").catch(() => {});
			return;
		}
		const [actuals, accounts] = await Promise.all([plActuals([month]), plAccounts({ includeInactive: true })]);
		const types = new Map(accounts.map((a) => [a.code, a]));
		const over = [];
		for (const b of budgets) {
			const a = types.get(b.account_code);
			if (!a || a.type !== "expense") continue;
			const spent = (actuals.get(b.account_code) || [0n])[0];
			const budget = BigInt(b.amount_cents);
			if (budget === 0n ? spent > 0n : spent * 100n >= budget * BigInt(s.alertPct)) over.push({ a, spent, budget });
		}
		if (over.length === 0) {
			await ctx.dashboard.remove(key, "notification").catch(() => {});
			return;
		}
		const money = (c, cur) => `${(Number(c) / 100).toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;
		await ctx.dashboard.notify({
			key,
			title: `${over.length} ${over.length === 1 ? "account is" : "accounts are"} at or over ${s.alertPct}% of budget in ${monthName(month)}`,
			body: over
				.slice(0, 10)
				.map((o) => `${o.a.name}: ${money(o.spent, o.a.currency)} of ${money(o.budget, o.a.currency)}`)
				.join("\n"),
			level: over.some((o) => o.spent > o.budget) ? "warning" : "info",
			link: "/apps/budget",
		});
	}

	const sweep = () =>
		ctx.orgs
			.forEach(() => checkAlerts())
			.catch((e) => ctx.log.warn("budget alert sweep failed", { error: e.message }));
	setTimeout(sweep, 30_000).unref();
	setInterval(sweep, 60 * 60 * 1000).unref();

	ctx.log.info("budget module ready");
}
