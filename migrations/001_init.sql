-- Budget amounts per revenue/expense account and month, in the account's currency.
CREATE TABLE budget_lines (
    month        DATE        NOT NULL CHECK (extract(day FROM month) = 1),
    account_code TEXT        NOT NULL CHECK (length(account_code) BETWEEN 1 AND 32),
    currency     TEXT        NOT NULL CHECK (currency IN ('CAD', 'USD')),
    amount_cents BIGINT      NOT NULL CHECK (amount_cents >= 0),
    note         TEXT        NOT NULL DEFAULT '' CHECK (length(note) <= 500),
    updated_by   TEXT        NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (month, account_code)
);

-- AI forecasts for a month. They are suggestions: nothing changes until a
-- person applies them (status pending -> applied) or rejects them.
CREATE TABLE forecasts (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    month        DATE        NOT NULL CHECK (extract(day FROM month) = 1),
    status       TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected')),
    summary      TEXT        NOT NULL DEFAULT '',
    -- [{ account_code, currency, amount_cents, reason }]
    lines        JSONB       NOT NULL DEFAULT '[]',
    model        TEXT        NOT NULL DEFAULT '',
    requested_by TEXT        NOT NULL,
    decided_by   TEXT,
    decided_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX forecasts_month_idx ON forecasts (month, id DESC);
