import assert from "node:assert/strict";
import { test } from "node:test";
import { ALERT_KEY, isOldAlertKey, rollUpLines } from "../lib.mjs";

// 5000 Food ─ 5010 Groceries ─ 5011 Organic
//           └ 5020 Restaurants          6000 Rent (no sub-accounts)
const PARENT = { 5010: "5000", 5020: "5000", 5011: "5010" };
const ancestorsOf = (code) => {
	const out = [];
	for (let p = PARENT[code]; p; p = PARENT[p]) out.push(p);
	return out;
};
const roll = (amounts) => Object.fromEntries(rollUpLines(Object.entries(amounts).map(([account_code, amount_cents]) => ({ account_code, amount_cents })), ancestorsOf));

test("a parent's budget covers its applied sub-accounts", () => {
	// The parent's own 100 with children of 400 and 200: its budget is 700, not 100.
	assert.deepEqual(roll({ 5000: 10000n, 5010: 40000n, 5020: 20000n }), { 5000: 70000n, 5010: 40000n, 5020: 20000n });
});

test("every level carries what is below it", () => {
	assert.deepEqual(roll({ 5000: 10000n, 5010: 40000n, 5011: 5000n, 5020: 20000n, 6000: 150000n }), {
		5000: 75000n, 5010: 45000n, 5011: 5000n, 5020: 20000n, 6000: 150000n,
	});
});

test("a line goes to its nearest applied ancestor when the one between isn't applied", () => {
	assert.deepEqual(roll({ 5000: 10000n, 5011: 5000n }), { 5000: 15000n, 5011: 5000n });
});

test("lines without an applied parent are written as they are", () => {
	assert.deepEqual(roll({ 5010: 40000n, 5020: 20000n, 6000: 150000n }), { 5010: 40000n, 5020: 20000n, 6000: 150000n });
	assert.deepEqual(roll({}), {});
});

test("amounts stay exact integers whatever they arrive as", () => {
	const out = rollUpLines(
		[
			{ account_code: "5000", amount_cents: "9007199254740993" }, // above Number.MAX_SAFE_INTEGER
			{ account_code: "5010", amount_cents: 1 },
			{ account_code: "5020", amount_cents: 0n },
		],
		ancestorsOf,
	);
	assert.equal(out.get("5000"), 9007199254740994n);
	assert.equal(out.get("5010"), 1n);
	assert.equal(out.get("5020"), 0n);
});

test("the alert has one key; the old per-month keys are recognised", () => {
	assert.equal(isOldAlertKey("over-2026-10"), true);
	assert.equal(isOldAlertKey("over-1999-01"), true);
	assert.equal(isOldAlertKey(ALERT_KEY), false);
	assert.equal(isOldAlertKey("forecast-12"), false);
	assert.equal(isOldAlertKey("over-2026-10-x"), false);
});
