-- MoneyMate - Database Schema
-- PostgreSQL Schema for Microsoft Money replacement

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users and Authentication
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE, -- NULL allowed for OIDC users without email
    password_hash VARCHAR(255), -- NULL for OIDC-only users
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    auth_provider VARCHAR(50) DEFAULT 'local', -- 'local', 'oidc'
    oidc_subject VARCHAR(255) UNIQUE,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP
);

-- Currencies
CREATE TABLE currencies (
    code VARCHAR(3) PRIMARY KEY, -- ISO 4217 code (USD, CAD, EUR, etc)
    name VARCHAR(100) NOT NULL,
    symbol VARCHAR(10) NOT NULL,
    decimal_places SMALLINT DEFAULT 2,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Exchange Rates (historical data)
CREATE TABLE exchange_rates (
    id BIGSERIAL PRIMARY KEY,
    from_currency VARCHAR(3) REFERENCES currencies(code),
    to_currency VARCHAR(3) REFERENCES currencies(code),
    rate NUMERIC(20, 10) NOT NULL,
    rate_date DATE NOT NULL,
    source VARCHAR(50), -- API source name
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(from_currency, to_currency, rate_date)
);

CREATE INDEX idx_exchange_rates_date ON exchange_rates(rate_date DESC);
CREATE INDEX idx_exchange_rates_currencies ON exchange_rates(from_currency, to_currency);

-- Account Types
CREATE TYPE account_type AS ENUM (
    'CHEQUING',
    'SAVINGS',
    'CREDIT_CARD',
    'LOAN',
    'MORTGAGE',
    'INVESTMENT',
    'CASH',
    'LINE_OF_CREDIT',
    'ASSET',
    'OTHER'
);

-- Accounts
CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_type account_type NOT NULL,
    account_sub_type VARCHAR(50), -- 'INVESTMENT_CASH', 'INVESTMENT_BROKERAGE' for linked investment pairs
    linked_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL, -- links cash <-> brokerage accounts
    name VARCHAR(255) NOT NULL,
    description TEXT,
    currency_code VARCHAR(3) NOT NULL REFERENCES currencies(code),
    account_number VARCHAR(100), -- masked/encrypted
    institution VARCHAR(255),
    opening_balance NUMERIC(20, 4) DEFAULT 0,
    current_balance NUMERIC(20, 4) DEFAULT 0,
    credit_limit NUMERIC(20, 4), -- for credit cards
    interest_rate NUMERIC(8, 4), -- for loans, mortgages, savings
    is_closed BOOLEAN DEFAULT false,
    closed_date DATE,
    is_favourite BOOLEAN DEFAULT false,
    -- Loan-specific fields
    payment_amount NUMERIC(20, 4), -- payment amount per period for loans
    payment_frequency VARCHAR(20), -- 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'
    payment_start_date DATE, -- when loan payments start
    source_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL, -- account payments come from
    principal_category_id UUID, -- category for principal portion (FK added after categories table)
    interest_category_id UUID, -- category for interest portion (FK added after categories table)
    scheduled_transaction_id UUID, -- linked scheduled transaction for payments (FK added after scheduled_transactions table)
    -- Asset-specific fields
    asset_category_id UUID, -- category for tracking value changes on asset accounts (FK added after categories table)
    date_acquired DATE, -- date the asset was acquired (for net worth historical accuracy)
    -- Mortgage-specific fields
    is_canadian_mortgage BOOLEAN DEFAULT false, -- Canadian mortgages use semi-annual compounding for fixed rates
    is_variable_rate BOOLEAN DEFAULT false, -- Variable rate mortgages use monthly compounding
    term_months INTEGER, -- Mortgage term length in months (e.g., 60 for 5-year term)
    term_end_date DATE, -- When the current term ends (for renewal reminders)
    amortization_months INTEGER, -- Total amortization period in months (e.g., 300 for 25 years)
    original_principal NUMERIC(20, 4), -- Original mortgage amount for reference
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_accounts_user ON accounts(user_id);
CREATE INDEX idx_accounts_type ON accounts(account_type);
CREATE INDEX idx_accounts_account_sub_type ON accounts(account_sub_type);
CREATE INDEX idx_accounts_linked_account_id ON accounts(linked_account_id);
CREATE INDEX idx_accounts_asset_category ON accounts(asset_category_id);
CREATE INDEX idx_accounts_term_end_date ON accounts(term_end_date) WHERE account_type = 'MORTGAGE' AND term_end_date IS NOT NULL;
CREATE INDEX idx_accounts_interest_category ON accounts(interest_category_id);
CREATE INDEX idx_accounts_principal_category ON accounts(principal_category_id);
CREATE INDEX idx_accounts_scheduled_transaction ON accounts(scheduled_transaction_id);
CREATE INDEX idx_accounts_source_account ON accounts(source_account_id);

-- Categories for transactions
CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES categories(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    icon VARCHAR(50),
    color VARCHAR(7), -- hex color
    is_income BOOLEAN DEFAULT false,
    is_system BOOLEAN DEFAULT false, -- system categories can't be deleted
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, name, parent_id)
);

CREATE INDEX idx_categories_user ON categories(user_id);
CREATE INDEX idx_categories_parent ON categories(parent_id);

-- Payees
CREATE TABLE payees (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    default_category_id UUID REFERENCES categories(id),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, name)
);

CREATE INDEX idx_payees_user ON payees(user_id);

-- Transactions
CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    transaction_date DATE NOT NULL,
    payee_id UUID REFERENCES payees(id),
    payee_name VARCHAR(255), -- can be different from payee.name
    category_id UUID REFERENCES categories(id), -- category for non-split transactions
    amount NUMERIC(20, 4) NOT NULL, -- positive for income/deposits, negative for expenses
    currency_code VARCHAR(3) NOT NULL REFERENCES currencies(code),
    exchange_rate NUMERIC(20, 10) DEFAULT 1, -- rate at transaction time
    description TEXT,
    reference_number VARCHAR(100), -- check number, confirmation number, etc
    is_cleared BOOLEAN DEFAULT false, -- LEGACY: replaced by status field
    is_reconciled BOOLEAN DEFAULT false, -- LEGACY: replaced by status field
    reconciled_date DATE,
    status VARCHAR(20) DEFAULT 'UNRECONCILED', -- 'UNRECONCILED', 'CLEARED', 'RECONCILED', 'VOID'
    is_split BOOLEAN DEFAULT false, -- indicates this is a split transaction
    parent_transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE, -- for split children
    is_transfer BOOLEAN DEFAULT false, -- indicates this is part of an account-to-account transfer
    linked_transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL, -- links the paired transfer transaction
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_transactions_user ON transactions(user_id);
CREATE INDEX idx_transactions_account ON transactions(account_id);
CREATE INDEX idx_transactions_date ON transactions(transaction_date DESC);
CREATE INDEX idx_transactions_payee ON transactions(payee_id);
CREATE INDEX idx_transactions_category ON transactions(category_id);
CREATE INDEX idx_transactions_parent ON transactions(parent_transaction_id);
CREATE INDEX idx_transactions_linked ON transactions(linked_transaction_id);
CREATE INDEX idx_transactions_cleared ON transactions(is_cleared); -- LEGACY
CREATE INDEX idx_transactions_reconciled ON transactions(is_reconciled); -- LEGACY
CREATE INDEX idx_transactions_user_cleared ON transactions(user_id, is_cleared); -- LEGACY

-- Transaction Splits (details for split transactions)
CREATE TABLE transaction_splits (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    category_id UUID REFERENCES categories(id),
    transfer_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL, -- target account for transfer splits
    linked_transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL, -- linked transaction in target account
    amount NUMERIC(20, 4) NOT NULL,
    memo TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_transaction_splits_transaction ON transaction_splits(transaction_id);
CREATE INDEX idx_transaction_splits_category ON transaction_splits(category_id);
CREATE INDEX idx_transaction_splits_transfer_account ON transaction_splits(transfer_account_id);
CREATE INDEX idx_transaction_splits_linked ON transaction_splits(linked_transaction_id);

-- Scheduled Transactions (recurring payments / bills & deposits)
CREATE TABLE scheduled_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL, -- display name for the scheduled transaction
    payee_id UUID REFERENCES payees(id),
    payee_name VARCHAR(255),
    category_id UUID REFERENCES categories(id),
    amount NUMERIC(20, 4) NOT NULL,
    currency_code VARCHAR(3) NOT NULL REFERENCES currencies(code),
    description TEXT,
    frequency VARCHAR(20) NOT NULL, -- 'ONCE', 'DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'
    next_due_date DATE NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE,
    occurrences_remaining INTEGER, -- if set, countdown of remaining occurrences
    total_occurrences INTEGER, -- original total if using occurrence limit
    is_active BOOLEAN DEFAULT true,
    auto_post BOOLEAN DEFAULT false, -- automatically create transaction when due
    reminder_days_before INTEGER DEFAULT 3,
    last_posted_date DATE, -- when the transaction was last posted
    is_split BOOLEAN DEFAULT false, -- indicates amounts are split across categories
    is_transfer BOOLEAN DEFAULT false, -- indicates this is an account-to-account transfer
    transfer_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL, -- destination account for transfers
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_scheduled_transactions_user ON scheduled_transactions(user_id);
CREATE INDEX idx_scheduled_transactions_next_due ON scheduled_transactions(next_due_date);
CREATE INDEX idx_scheduled_transactions_active ON scheduled_transactions(is_active);
CREATE INDEX idx_scheduled_transactions_transfer_account ON scheduled_transactions(transfer_account_id);

-- Scheduled Transaction Splits
CREATE TABLE scheduled_transaction_splits (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    scheduled_transaction_id UUID NOT NULL REFERENCES scheduled_transactions(id) ON DELETE CASCADE,
    category_id UUID REFERENCES categories(id),
    transfer_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL, -- target account for transfer splits
    amount NUMERIC(20, 4) NOT NULL,
    memo TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_scheduled_transaction_splits_scheduled ON scheduled_transaction_splits(scheduled_transaction_id);
CREATE INDEX idx_scheduled_transaction_splits_category ON scheduled_transaction_splits(category_id);
CREATE INDEX idx_scheduled_transaction_splits_transfer_account ON scheduled_transaction_splits(transfer_account_id);

-- Add deferred foreign keys for loan accounts (after categories and scheduled_transactions tables exist)
ALTER TABLE accounts ADD CONSTRAINT fk_accounts_principal_category
    FOREIGN KEY (principal_category_id) REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD CONSTRAINT fk_accounts_interest_category
    FOREIGN KEY (interest_category_id) REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD CONSTRAINT fk_accounts_scheduled_transaction
    FOREIGN KEY (scheduled_transaction_id) REFERENCES scheduled_transactions(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD CONSTRAINT fk_accounts_asset_category
    FOREIGN KEY (asset_category_id) REFERENCES categories(id) ON DELETE SET NULL;

-- Scheduled Transaction Overrides (for modifying individual occurrences)
CREATE TABLE scheduled_transaction_overrides (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    scheduled_transaction_id UUID NOT NULL REFERENCES scheduled_transactions(id) ON DELETE CASCADE,
    original_date DATE NOT NULL, -- The original calculated occurrence date this override replaces
    override_date DATE NOT NULL, -- The actual date for this occurrence (may differ if date was changed)
    amount NUMERIC(20, 4),
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    description TEXT,
    is_split BOOLEAN,
    splits JSONB, -- JSON array of split overrides: [{categoryId, amount, memo}]
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(scheduled_transaction_id, override_date) -- NOTE: DB uses override_date, not original_date
);

CREATE INDEX idx_sched_txn_overrides_sched_txn_id ON scheduled_transaction_overrides(scheduled_transaction_id);
CREATE INDEX idx_sched_txn_overrides_date ON scheduled_transaction_overrides(override_date);

-- Securities (stocks, bonds, mutual funds, ETFs)
CREATE TABLE securities (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    symbol VARCHAR(20) NOT NULL UNIQUE, -- ticker symbol
    name VARCHAR(255) NOT NULL,
    security_type VARCHAR(50), -- 'STOCK', 'ETF', 'MUTUAL_FUND', 'BOND', etc
    exchange VARCHAR(50), -- 'NYSE', 'NASDAQ', 'TSX', 'TSXV', etc
    currency_code VARCHAR(3) NOT NULL REFERENCES currencies(code),
    is_active BOOLEAN DEFAULT true,
    skip_price_updates BOOLEAN DEFAULT false, -- for auto-generated symbols that can't be looked up
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_securities_symbol ON securities(symbol);
CREATE INDEX idx_securities_exchange ON securities(exchange);

-- Security Prices (historical)
CREATE TABLE security_prices (
    id BIGSERIAL PRIMARY KEY,
    security_id UUID NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
    price_date DATE NOT NULL,
    open_price NUMERIC(20, 4),
    high_price NUMERIC(20, 4),
    low_price NUMERIC(20, 4),
    close_price NUMERIC(20, 4) NOT NULL,
    volume BIGINT,
    source VARCHAR(50), -- API source
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(security_id, price_date)
);

CREATE INDEX idx_security_prices_security ON security_prices(security_id);
CREATE INDEX idx_security_prices_date ON security_prices(price_date DESC);

-- Investment Holdings
CREATE TABLE holdings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    security_id UUID NOT NULL REFERENCES securities(id),
    quantity NUMERIC(20, 8) NOT NULL DEFAULT 0,
    average_cost NUMERIC(20, 4), -- average cost per unit
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(account_id, security_id)
);

CREATE INDEX idx_holdings_account ON holdings(account_id);
CREATE INDEX idx_holdings_security ON holdings(security_id);

-- Investment Transactions
CREATE TYPE investment_action AS ENUM (
    'BUY',
    'SELL',
    'DIVIDEND',
    'INTEREST',
    'CAPITAL_GAIN',
    'SPLIT',
    'TRANSFER_IN',
    'TRANSFER_OUT',
    'REINVEST'
);

CREATE TABLE investment_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
    security_id UUID REFERENCES securities(id),
    funding_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
    action investment_action NOT NULL,
    transaction_date DATE NOT NULL,
    quantity NUMERIC(20, 8),
    price NUMERIC(20, 4),
    commission NUMERIC(20, 4) DEFAULT 0,
    total_amount NUMERIC(20, 4) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_investment_transactions_user ON investment_transactions(user_id);
CREATE INDEX idx_investment_transactions_account ON investment_transactions(account_id);
CREATE INDEX idx_investment_transactions_security ON investment_transactions(security_id);
CREATE INDEX idx_investment_transactions_date ON investment_transactions(transaction_date DESC);

-- User Preferences
CREATE TABLE user_preferences (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    default_currency VARCHAR(3) REFERENCES currencies(code),
    date_format VARCHAR(20) DEFAULT 'YYYY-MM-DD',
    number_format VARCHAR(20) DEFAULT 'en-US',
    theme VARCHAR(20) DEFAULT 'light',
    timezone VARCHAR(50) DEFAULT 'UTC',
    notification_email BOOLEAN DEFAULT true,
    notification_browser BOOLEAN DEFAULT true,
    two_factor_enabled BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Custom Reports (user-defined configurable reports)
-- view_type: TABLE, LINE_CHART, BAR_CHART, PIE_CHART
-- timeframe_type: LAST_7_DAYS, LAST_30_DAYS, LAST_MONTH, LAST_3_MONTHS, LAST_6_MONTHS, LAST_12_MONTHS, LAST_YEAR, YEAR_TO_DATE, CUSTOM
-- group_by: NONE, CATEGORY, PAYEE, MONTH, WEEK, DAY
-- filters: { accountIds?: string[], categoryIds?: string[], payeeIds?: string[], searchText?: string }
-- config: {
--   metric: NONE | TOTAL_AMOUNT | COUNT | AVERAGE,
--   includeTransfers: boolean,
--   direction: INCOME_ONLY | EXPENSES_ONLY | BOTH,
--   customStartDate?: string,
--   customEndDate?: string,
--   tableColumns?: (LABEL | VALUE | COUNT | PERCENTAGE | DATE | PAYEE | DESCRIPTION | MEMO | CATEGORY | ACCOUNT)[],
--   sortBy?: LABEL | VALUE | COUNT | PERCENTAGE | DATE | PAYEE | DESCRIPTION | MEMO | CATEGORY | ACCOUNT,
--   sortDirection?: ASC | DESC
-- }
CREATE TABLE custom_reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    icon VARCHAR(50),
    background_color VARCHAR(7),
    view_type VARCHAR(20) NOT NULL DEFAULT 'BAR_CHART',
    timeframe_type VARCHAR(30) NOT NULL DEFAULT 'LAST_3_MONTHS',
    group_by VARCHAR(20) NOT NULL DEFAULT 'CATEGORY',
    filters JSONB NOT NULL DEFAULT '{}',
    config JSONB NOT NULL DEFAULT '{"metric": "TOTAL_AMOUNT", "includeTransfers": false, "direction": "EXPENSES_ONLY"}',
    is_favourite BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_custom_reports_user_id ON custom_reports(user_id);
CREATE INDEX idx_custom_reports_user_favourite ON custom_reports(user_id, is_favourite);
CREATE INDEX idx_custom_reports_user_sort ON custom_reports(user_id, sort_order);

-- Triggers for updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_accounts_updated_at BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_transactions_updated_at BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_scheduled_transactions_updated_at BEFORE UPDATE ON scheduled_transactions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_scheduled_transaction_overrides_updated_at BEFORE UPDATE ON scheduled_transaction_overrides FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_securities_updated_at BEFORE UPDATE ON securities FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_holdings_updated_at BEFORE UPDATE ON holdings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_investment_transactions_updated_at BEFORE UPDATE ON investment_transactions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_user_preferences_updated_at BEFORE UPDATE ON user_preferences FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_custom_reports_updated_at BEFORE UPDATE ON custom_reports FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- NOTE: Account balances (current_balance) are managed by application code
-- (accounts.service.ts, transactions.service.ts, import.service.ts) via updateBalance() calls.
-- No database trigger is used for balance tracking.

-- Insert default currencies
INSERT INTO currencies (code, name, symbol, decimal_places) VALUES
    ('USD', 'US Dollar', '$', 2),
    ('CAD', 'Canadian Dollar', 'CA$', 2),
    ('EUR', 'Euro', '€', 2),
    ('GBP', 'British Pound', '£', 2),
    ('JPY', 'Japanese Yen', '¥', 0),
    ('CHF', 'Swiss Franc', 'CHF', 2),
    ('AUD', 'Australian Dollar', 'A$', 2),
    ('CNY', 'Chinese Yuan', '¥', 2);

-- Monthly Account Balances (cached end-of-month balances for net worth report)
CREATE TABLE monthly_account_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  month DATE NOT NULL,
  balance NUMERIC(20, 4) NOT NULL DEFAULT 0,
  market_value NUMERIC(20, 4),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (account_id, month)
);

CREATE INDEX idx_mab_user_month ON monthly_account_balances(user_id, month);

-- Create indexes for performance
CREATE INDEX idx_transactions_status ON transactions(status);
CREATE INDEX idx_accounts_closed ON accounts(is_closed);
CREATE INDEX idx_scheduled_transactions_account ON scheduled_transactions(account_id);

-- Composite indexes for common query patterns
CREATE INDEX idx_transactions_user_date ON transactions(user_id, transaction_date DESC);
CREATE INDEX idx_transactions_user_account_date ON transactions(user_id, account_id, transaction_date DESC);
CREATE INDEX idx_transactions_user_date_created ON transactions(user_id, transaction_date DESC, created_at DESC, id DESC);
CREATE INDEX idx_transactions_account_date ON transactions(account_id, transaction_date DESC);
CREATE INDEX idx_mab_account_month ON monthly_account_balances(account_id, month);
CREATE INDEX idx_security_prices_security_date ON security_prices(security_id, price_date DESC);