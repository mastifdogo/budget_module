// Parts of the Budget module that need neither Ledger nor a database (tested by `npm test`).

/**
 * Budget amounts for forecast lines that a person applies.
 *
 * A forecast line is an account's OWN postings, but a budget on an account covers its sub-accounts
 * as well (their spending counts against it, and their own budgets aren't added to the total
 * again). So each applied line also carries the applied lines below it: what is written for an
 * account is its own amount plus the amounts of every applied account under it, at any depth
 * (the same as adding each line into its nearest applied ancestor, level by level).
 *
 * @param {{ account_code: string, amount_cents: bigint | number | string }[]} lines one per account
 * @param {(code: string) => string[]} ancestorsOf the accounts above a code
 * @returns {Map<string, bigint>} account code → budget to write, in cents
 */
export function rollUpLines(lines, ancestorsOf) {
	const total = new Map(lines.map((l) => [l.account_code, 0n]));
	for (const l of lines) {
		const own = BigInt(l.amount_cents);
		total.set(l.account_code, total.get(l.account_code) + own);
		for (const up of new Set(ancestorsOf(l.account_code))) {
			if (up !== l.account_code && total.has(up)) total.set(up, total.get(up) + own);
		}
	}
	return total;
}

// The dashboard notification for accounts over budget. One key for every month, so the next
// month's check replaces or removes last month's.
export const ALERT_KEY = "over-budget";
/** Keys used before 0.4.1, one per month ("over-2026-10"): nothing ever removed a past month's. */
export const isOldAlertKey = (key) => /^over-\d{4}-\d{2}$/.test(String(key));
