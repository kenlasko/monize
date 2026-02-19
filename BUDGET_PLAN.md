# Budget Planner Feature - Implementation Plan

## Vision

A comprehensive budget planner that goes beyond simple "set a limit, track spending." It analyzes your historical spending to auto-generate realistic budgets, adapts to seasonal patterns, tracks spending velocity in real-time, supports flexible rollover strategies per category, and proactively alerts you before you overspend -- not after.

---

## Part 1: Database Schema

### Table: `budgets`

The core budget definition. One per user at a time (though historical budgets are preserved).

```sql
CREATE TABLE budgets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    budget_type VARCHAR(20) NOT NULL DEFAULT 'MONTHLY',
        -- MONTHLY: standard month-by-month budgeting
        -- ANNUAL: yearly budget divided into months
        -- PAY_PERIOD: aligned to income deposits (biweekly/semimonthly)
    period_start DATE NOT NULL,          -- when this budget takes effect
    period_end DATE,                     -- NULL = ongoing
    base_income NUMERIC(20, 4),          -- expected monthly income (for income-linked %)
    income_linked BOOLEAN DEFAULT false, -- if true, category amounts are % of actual income
    strategy VARCHAR(30) NOT NULL DEFAULT 'FIXED',
        -- FIXED: set amounts, unused budget disappears each period
        -- ROLLOVER: unused budget carries to next period per category settings
        -- ZERO_BASED: every dollar must be assigned (income - expenses = 0)
        -- FIFTY_THIRTY_TWENTY: auto-tags categories as needs/wants/savings
    is_active BOOLEAN DEFAULT true,
    currency_code VARCHAR(3) NOT NULL REFERENCES currencies(code),
    config JSONB NOT NULL DEFAULT '{}',
        -- {
        --   includeTransfers: boolean,
        --   excludedAccountIds: string[],
        --   fiscalYearStart: number (1-12),
        --   payFrequency: 'WEEKLY' | 'BIWEEKLY' | 'SEMIMONTHLY' | 'MONTHLY',
        --   payDayOfMonth: number (1-31),
        --   alertDefaults: { warnAt: 80, criticalAt: 95 }
        -- }
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_budgets_user ON budgets(user_id);
CREATE INDEX idx_budgets_user_active ON budgets(user_id, is_active);
```

### Table: `budget_categories`

Per-category budget allocation within a budget. This is where the actual dollar amounts live.

```sql
CREATE TABLE budget_categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    budget_id UUID NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    category_group VARCHAR(20),
        -- NEED, WANT, SAVING (used by 50/30/20 strategy)
        -- NULL for other strategies
    amount NUMERIC(20, 4) NOT NULL,      -- monthly target (or % if income_linked)
    is_income BOOLEAN DEFAULT false,     -- true = income category (for zero-based tracking)
    rollover_type VARCHAR(20) DEFAULT 'NONE',
        -- NONE: resets each period
        -- MONTHLY: unused rolls to next month
        -- QUARTERLY: accumulates for 3 months then resets
        -- ANNUAL: accumulates all year
    rollover_cap NUMERIC(20, 4),         -- max rollover accumulation (NULL = unlimited)
    flex_group VARCHAR(100),             -- group name for flex budgeting (see concept below)
    alert_warn_percent INTEGER DEFAULT 80,    -- % threshold for warning alert
    alert_critical_percent INTEGER DEFAULT 95, -- % threshold for critical alert
    notes TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_budget_categories_budget ON budget_categories(budget_id);
CREATE INDEX idx_budget_categories_category ON budget_categories(category_id);
CREATE INDEX idx_budget_categories_flex ON budget_categories(budget_id, flex_group)
    WHERE flex_group IS NOT NULL;
```

### Table: `budget_periods`

Snapshot of each completed period. Stores actuals + rollover balances for historical tracking.

```sql
CREATE TABLE budget_periods (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    budget_id UUID NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    actual_income NUMERIC(20, 4) DEFAULT 0,
    actual_expenses NUMERIC(20, 4) DEFAULT 0,
    total_budgeted NUMERIC(20, 4) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'OPEN',
        -- OPEN: current period
        -- CLOSED: period ended, actuals finalized
        -- PROJECTED: future period with projections
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(budget_id, period_start)
);

CREATE INDEX idx_budget_periods_budget ON budget_periods(budget_id);
CREATE INDEX idx_budget_periods_dates ON budget_periods(budget_id, period_start, period_end);
```

### Table: `budget_period_categories`

Per-category actuals for each period. This is where rollover math happens.

```sql
CREATE TABLE budget_period_categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    budget_period_id UUID NOT NULL REFERENCES budget_periods(id) ON DELETE CASCADE,
    budget_category_id UUID NOT NULL REFERENCES budget_categories(id) ON DELETE CASCADE,
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    budgeted_amount NUMERIC(20, 4) NOT NULL,   -- original allocation
    rollover_in NUMERIC(20, 4) DEFAULT 0,      -- carried from previous period
    actual_amount NUMERIC(20, 4) DEFAULT 0,    -- actual spending (computed)
    effective_budget NUMERIC(20, 4) NOT NULL,   -- budgeted + rollover_in
    rollover_out NUMERIC(20, 4) DEFAULT 0,     -- carried to next period
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(budget_period_id, budget_category_id)
);

CREATE INDEX idx_bpc_period ON budget_period_categories(budget_period_id);
CREATE INDEX idx_bpc_category ON budget_period_categories(category_id);
```

### Table: `budget_alerts`

Persistent alert records so users can see alert history and configure per-category thresholds.

```sql
CREATE TABLE budget_alerts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    budget_id UUID NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
    budget_category_id UUID REFERENCES budget_categories(id) ON DELETE CASCADE,
    alert_type VARCHAR(30) NOT NULL,
        -- PACE_WARNING: spending velocity exceeds safe daily rate
        -- THRESHOLD_WARNING: hit warn % (default 80%)
        -- THRESHOLD_CRITICAL: hit critical % (default 95%)
        -- OVER_BUDGET: exceeded 100%
        -- FLEX_GROUP_WARNING: flex group approaching limit
        -- SEASONAL_SPIKE: spending significantly above seasonal norm
        -- PROJECTED_OVERSPEND: at current rate, will exceed budget by period end
        -- INCOME_SHORTFALL: actual income below expected
        -- POSITIVE_MILESTONE: underspent target (encouraging feedback)
    severity VARCHAR(20) NOT NULL,       -- 'info', 'warning', 'critical', 'success'
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    data JSONB DEFAULT '{}',
        -- { percent: 85, amount: 450, limit: 500, projectedEnd: 560, daysRemaining: 12, ... }
    is_read BOOLEAN DEFAULT false,
    is_email_sent BOOLEAN DEFAULT false,
    period_start DATE NOT NULL,          -- which budget period this alert belongs to
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_budget_alerts_user ON budget_alerts(user_id);
CREATE INDEX idx_budget_alerts_user_unread ON budget_alerts(user_id, is_read) WHERE is_read = false;
CREATE INDEX idx_budget_alerts_budget_period ON budget_alerts(budget_id, period_start);
```

### Migration

Add triggers for `updated_at` on all new tables:

```sql
CREATE TRIGGER update_budgets_updated_at BEFORE UPDATE ON budgets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_budget_categories_updated_at BEFORE UPDATE ON budget_categories FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_budget_periods_updated_at BEFORE UPDATE ON budget_periods FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_budget_period_categories_updated_at BEFORE UPDATE ON budget_period_categories FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

---

## Part 2: Smart Features (the "Surprise Me" Ideas)

### 2.1 Auto-Budget Generator ("Budget Wizard")

The killer feature. Instead of making users manually enter amounts for 20+ categories, we analyze their historical transactions and suggest realistic targets.

**How it works:**
1. User picks an analysis window (last 3/6/12 months)
2. Backend aggregates spending per category over that period
3. Applies statistical smoothing:
   - **Median** (not average) for each category -- ignores one-time spikes
   - **Seasonal adjustment** -- if analyzing in December, flags that holiday spending is atypical
   - **Recurring detection** -- identifies fixed costs (rent, subscriptions) vs variable (dining, groceries)
4. Presents three budget "profiles":
   - **Comfortable** -- based on 75th percentile of spending (allows some headroom)
   - **On Track** -- based on median spending (realistic)
   - **Aggressive** -- based on 25th percentile (stretch goal for saving more)
5. User can tweak any individual category amount
6. Shows the projected monthly savings for each profile vs their actual income

**Backend endpoint:** `POST /budgets/generate`
- Input: `{ analysisMonths: 3|6|12, strategy: 'FIXED'|'ROLLOVER'|..., profile: 'COMFORTABLE'|'ON_TRACK'|'AGGRESSIVE' }`
- Output: `{ categories: [{ categoryId, categoryName, median, p25, p75, suggested, isFixed, monthlyOccurrences }], totalBudgeted, estimatedIncome, projectedSavings }`

### 2.2 Spending Velocity Tracker

Not just "you've spent $300 of $500" but "you're spending at $20/day; at this pace you'll hit $620 by month end."

**How it works:**
- Calculates daily burn rate: `actualSpent / daysElapsed`
- Projects end-of-period total: `burnRate * totalDaysInPeriod`
- Compares to budget: `projected - budgeted = variance`
- Adjusts for known upcoming bills (from scheduled transactions)
- Shows a "safe daily spend" metric: `(remaining budget - upcoming bills) / days remaining`

**Displayed as:**
- Progress bar with a moving "pace line" (where you should be today vs where you are)
- "You can safely spend $X/day for the rest of the month"
- Color-coded: green (under pace), yellow (near pace), red (over pace)

### 2.3 Flex Groups

Categories grouped together where the total matters, not individual lines. Real life doesn't fit neat boxes -- you might overspend on dining but underspend on entertainment, and that's fine.

**How it works:**
- User assigns categories to named flex groups (e.g., "Fun Money" = Dining + Entertainment + Hobbies)
- Budget tracks individual category spending but evaluates alerts at the group level
- If dining is 120% but entertainment is 40%, and the group total is 85%, no alert fires
- Individual category detail is still visible for insight

### 2.4 Seasonal Intelligence

Detects annual patterns and warns about them proactively.

**How it works:**
- Analyzes 12+ months of data per category
- Identifies months with spending significantly above average (>1.5 standard deviations)
- Stores seasonal profiles: `{ categoryId: "Gifts", highMonths: [11, 12], typicalIncrease: 2.4x }`
- Before a historically expensive month starts, creates a SEASONAL_SPIKE alert: "Last December you spent 2.4x your usual on Gifts. Consider adjusting your budget."
- Auto-suggests temporary budget increases for seasonal categories

### 2.5 Income-Linked Percentage Budgets

For freelancers, gig workers, or anyone with variable income. Budget categories are percentages of actual income rather than fixed amounts.

**How it works:**
- When `income_linked = true`, `budget_categories.amount` stores a percentage (e.g., 30.0 = 30%)
- Each period, the system calculates actual income from income-category transactions
- Effective budget = `(actual_income * percentage) / 100`
- Dashboard shows both the percentage and the resulting dollar amount
- If income drops, budget automatically tightens; if income rises, budget grows proportionally

### 2.6 "What-If" Scenario Planner

A read-only simulation tool. "What if I reduce dining by $100/month and put it toward my vacation fund?"

**How it works:**
- Frontend-only calculation (no backend needed)
- User adjusts category amounts via sliders
- Live preview shows: projected savings change, impact on flex groups, effect on zero-based balance
- Can compare current budget vs proposed changes side-by-side
- "Apply Changes" button saves the adjusted amounts

### 2.7 Budget Health Score

A single 0-100 score summarizing how well the user is sticking to their budget. Gamification that actually helps.

**Scoring algorithm:**
- Start at 100
- Deduct points for each category over budget (proportional to overage)
- Bonus points for categories consistently under budget
- Weight essential categories (needs) higher than discretionary (wants)
- Factor in trend: improving month-over-month adds points
- Display as a colored gauge with labels: "Excellent" (90+), "Good" (70-89), "Needs Attention" (50-69), "Off Track" (<50)

### 2.8 Smart Rollover with Category-Level Rules

Different categories need different rollover strategies:
- **Groceries**: resets monthly (no point accumulating)
- **Clothing**: rolls over monthly with a cap (save up for seasonal shopping)
- **Travel**: accumulates annually (vacation fund)
- **Car Maintenance**: accumulates with no cap (save for repairs)

Each `budget_category` row has its own `rollover_type` and `rollover_cap`.

### 2.9 Upcoming Bills Awareness

Integrates with existing scheduled transactions to show "locked" vs "discretionary" spending.

**How it works:**
- Queries scheduled transactions due in the current period
- Separates budget into: "Already spent" + "Bills coming" + "Truly available"
- Shows this breakdown prominently on the budget dashboard
- "Truly available" = `budget - actual_spent - upcoming_scheduled`
- Prevents the false sense of security when you have $400 left but $350 in bills coming

---

## Part 3: Backend Implementation

### 3.1 Module Structure

```
backend/src/budgets/
  budgets.module.ts
  budgets.controller.ts
  budgets.service.ts
  budget-generator.service.ts      -- auto-budget analysis
  budget-period.service.ts         -- period management & rollover math
  budget-alert.service.ts          -- alert generation & cron
  budget-reports.service.ts        -- budget-specific reporting
  dto/
    create-budget.dto.ts
    update-budget.dto.ts
    create-budget-category.dto.ts
    update-budget-category.dto.ts
    generate-budget.dto.ts         -- auto-budget wizard input
    budget-query.dto.ts            -- query params for reports
  entities/
    budget.entity.ts
    budget-category.entity.ts
    budget-period.entity.ts
    budget-period-category.entity.ts
    budget-alert.entity.ts
```

### 3.2 API Endpoints

```
Budget CRUD:
  POST   /budgets                    -- create a new budget
  GET    /budgets                    -- list user's budgets
  GET    /budgets/:id                -- get budget with categories
  PATCH  /budgets/:id                -- update budget settings
  DELETE /budgets/:id                -- delete budget

Budget Categories:
  POST   /budgets/:id/categories     -- add category to budget
  PATCH  /budgets/:id/categories/:categoryId  -- update category allocation
  DELETE /budgets/:id/categories/:categoryId  -- remove category from budget
  POST   /budgets/:id/categories/bulk -- bulk update all category amounts

Budget Generator:
  POST   /budgets/generate           -- analyze spending & suggest budget
  POST   /budgets/generate/apply     -- create budget from suggestions

Budget Execution (live data):
  GET    /budgets/:id/summary        -- current period summary (actuals vs budget)
  GET    /budgets/:id/velocity       -- spending velocity & projections
  GET    /budgets/:id/categories/:categoryId/transactions -- drilldown to transactions

Budget Periods:
  GET    /budgets/:id/periods        -- list historical periods
  GET    /budgets/:id/periods/:periodId -- period detail with category breakdowns
  POST   /budgets/:id/periods/close  -- manually close current period

Budget Reports:
  GET    /budgets/:id/reports/trend           -- budget vs actual over N months
  GET    /budgets/:id/reports/category-trend  -- per-category trend over time
  GET    /budgets/:id/reports/health-score    -- health score calculation
  GET    /budgets/:id/reports/seasonal        -- seasonal spending patterns
  GET    /budgets/:id/reports/flex-groups     -- flex group status

Budget Alerts:
  GET    /budgets/alerts             -- list unread alerts
  PATCH  /budgets/alerts/:id/read    -- mark alert as read
  PATCH  /budgets/alerts/read-all    -- mark all alerts as read
```

### 3.3 Budget Generator Service (Key Algorithm)

```typescript
// Pseudo-code for the auto-budget analysis
async generateBudget(userId, dto: GenerateBudgetDto) {
  const { analysisMonths, profile } = dto;

  // 1. Get all non-transfer, non-void expense transactions in analysis window
  const endDate = new Date();
  const startDate = subMonths(endDate, analysisMonths);

  const spending = await this.getSpendingByCategory(userId, startDate, endDate);
  const income = await this.getIncomeByCategory(userId, startDate, endDate);

  // 2. For each category, compute monthly distribution
  const categoryAnalysis = spending.map(category => {
    const monthlyAmounts = category.monthlyBreakdown; // array of monthly totals
    const sorted = [...monthlyAmounts].sort((a, b) => a - b);

    return {
      categoryId: category.id,
      categoryName: category.name,
      isIncome: false,
      average: mean(monthlyAmounts),
      median: percentile(sorted, 50),       // "On Track" suggestion
      p25: percentile(sorted, 25),          // "Aggressive" suggestion
      p75: percentile(sorted, 75),          // "Comfortable" suggestion
      min: sorted[0],
      max: sorted[sorted.length - 1],
      stdDev: standardDeviation(monthlyAmounts),
      monthlyOccurrences: monthlyAmounts.filter(m => m > 0).length,
      isFixed: isFixedExpense(monthlyAmounts), // low variance = likely subscription/bill
      seasonalMonths: detectSeasonalPeaks(monthlyAmounts, startDate),
    };
  });

  // 3. Pick suggested amount based on profile
  const suggestions = categoryAnalysis.map(cat => ({
    ...cat,
    suggested: profile === 'COMFORTABLE' ? cat.p75
             : profile === 'AGGRESSIVE' ? cat.p25
             : cat.median,
  }));

  const totalIncome = mean(income.map(i => i.monthlyTotal));
  const totalBudgeted = sum(suggestions.map(s => s.suggested));

  return {
    categories: suggestions,
    estimatedMonthlyIncome: totalIncome,
    totalBudgeted,
    projectedMonthlySavings: totalIncome - totalBudgeted,
    analysisWindow: { startDate, endDate, months: analysisMonths },
  };
}
```

### 3.4 Budget Alert Cron Service

Runs daily at 7 AM UTC (before bill reminders at 8 AM) to generate budget alerts.

```typescript
@Cron('0 7 * * *')  // Daily at 7 AM UTC
async checkBudgetAlerts() {
  // 1. Get all users with active budgets
  // 2. For each budget, compute current period actuals
  // 3. Check each category against thresholds:
  //    a. Threshold alerts (80%, 95%, 100%)
  //    b. Velocity alerts (projected overspend)
  //    c. Flex group alerts
  //    d. Seasonal warnings (upcoming high-spend month)
  //    e. Income shortfall (if income-linked)
  //    f. Positive milestones (10+ days into period and under 50% spent)
  // 4. De-duplicate: don't re-alert for same category + type + period
  // 5. Save alerts to budget_alerts table
  // 6. Send email digest if user has email notifications enabled
}
```

### 3.5 Integration with Existing AI Module

Add a new AI tool `get_budget_status` to the tool executor:

```typescript
// New tool for AI queries
{
  name: 'get_budget_status',
  description: 'Get the current budget status including spending vs targets for each category',
  parameters: {
    period: { type: 'string', description: 'CURRENT, PREVIOUS, or YYYY-MM' }
  }
}
```

This lets users ask the AI assistant questions like:
- "How am I doing on my budget this month?"
- "Which categories am I overspending in?"
- "How much can I still spend on dining this month?"

### 3.6 Email Notifications

Add new email template `budgetAlertTemplate`:

```typescript
export function budgetAlertTemplate(
  firstName: string,
  alerts: BudgetAlertData[],
  healthScore: number,
  appUrl: string,
): string {
  // Summary section with health score gauge
  // Table of alerts by severity (critical first)
  // "View Budget" CTA button
  // "Safe to spend today: $X" footer callout
}
```

**Email triggers:**
- Weekly budget digest (configurable: Monday or Friday)
- Immediate alert on critical threshold (>95%) or over-budget
- Monthly budget summary at period close

---

## Part 4: Frontend Implementation

### 4.1 Page Structure

```
frontend/src/app/(authenticated)/budgets/
  page.tsx                     -- budget list / active budget overview
  [id]/
    page.tsx                   -- budget detail / live dashboard
    edit/
      page.tsx                 -- edit budget settings & categories
  create/
    page.tsx                   -- budget creation wizard (stepped form)
```

### 4.2 Component Structure

```
frontend/src/components/budgets/
  BudgetWizard.tsx             -- multi-step budget creation wizard
  BudgetWizardAnalysis.tsx     -- step 1: pick analysis period, see suggestions
  BudgetWizardCategories.tsx   -- step 2: review & tweak category amounts
  BudgetWizardStrategy.tsx     -- step 3: pick strategy, rollover rules
  BudgetWizardReview.tsx       -- step 4: final review before creation
  BudgetDashboard.tsx          -- main budget view with all widgets
  BudgetSummaryCards.tsx       -- top-line summary cards (income, expenses, remaining, savings)
  BudgetHealthGauge.tsx        -- circular gauge showing 0-100 health score
  BudgetCategoryList.tsx       -- list of categories with progress bars
  BudgetCategoryRow.tsx        -- individual category row (bar + amounts + velocity)
  BudgetProgressBar.tsx        -- colored progress bar with pace marker
  BudgetVelocityWidget.tsx     -- spending velocity + safe daily spend
  BudgetFlexGroupCard.tsx      -- flex group aggregate view
  BudgetUpcomingBills.tsx      -- scheduled transactions impact on remaining budget
  BudgetHeatmap.tsx            -- calendar heatmap of daily spending
  BudgetTrendChart.tsx         -- line chart: budget vs actual over months
  BudgetCategoryTrend.tsx      -- per-category trend comparison
  BudgetScenarioPlanner.tsx    -- what-if slider tool
  BudgetAlertBadge.tsx         -- notification badge for unread alerts
  BudgetAlertList.tsx          -- list of alerts with mark-as-read
  BudgetPeriodSelector.tsx     -- switch between current/historical periods
  BudgetCategoryForm.tsx       -- edit single category allocation
  BudgetForm.tsx               -- edit budget settings
```

### 4.3 Budget Dashboard Layout

The main budget view (`/budgets/[id]`) is a dashboard with a widget-based layout:

```
+---------------------------------------------------------------------+
| Budget: "February 2026"                    [Period: Feb 2026 v] [Edit] |
+---------------------------------------------------------------------+
|                                                                       |
| +------------------+  +-----------+  +----------+  +-----------+     |
| | Total Budget     |  | Spent     |  | Remaining|  | Savings   |     |
| | $5,200.00        |  | $3,100.00 |  | $2,100.00|  | $800.00   |     |
| | 12 categories    |  | 60%       |  | 17 days  |  | On track  |     |
| +------------------+  +-----------+  +----------+  +-----------+     |
|                                                                       |
| +----------------------------+  +-----------------------------+       |
| | Health Score        [85]   |  | Spending Velocity           |       |
| |      ___                   |  | Daily burn: $155/day        |       |
| |    /  85 \    "Good"       |  | Safe to spend: $124/day     |       |
| |    \____/                  |  | Projected month-end: $4,650 |       |
| |                            |  | Budget: $5,200 (on track)   |       |
| +----------------------------+  +-----------------------------+       |
|                                                                       |
| +----------------------------------------------------------------+   |
| | Category Budgets                          [Grid|List] [Sort v] |   |
| |----------------------------------------------------------------|   |
| | Rent          [=========================] $1,500 / $1,500 100% |   |
| |               Fixed | No rollover         Pace: on track       |   |
| |----------------------------------------------------------------|   |
| | Groceries     [================>--------] $420 / $600    70%   |   |
| |               Variable | Resets monthly   Pace: over by $30   |   |
| |----------------------------------------------------------------|   |
| | Dining        [=========>--------------] $180 / $300    60%   |   |
| |               Variable | Flex: Fun Money  Pace: under          |   |
| |----------------------------------------------------------------|   |
| | Entertainment [====>-------------------] $45 / $200     23%   |   |
| |               Variable | Flex: Fun Money  Pace: way under      |   |
| |----------------------------------------------------------------|   |
| | (more categories...)                                           |   |
| +----------------------------------------------------------------+   |
|                                                                       |
| +----------------------------+  +-----------------------------+       |
| | Flex Groups                |  | Upcoming Bills              |       |
| |                            |  |                             |       |
| | Fun Money                  |  | Internet    Feb 25   $80   |       |
| | $225 / $500 (45%)          |  | Insurance   Feb 28   $150  |       |
| | [===========>....]         |  | Phone       Mar 01   $65   |       |
| |  Dining: $180              |  |                             |       |
| |  Entertainment: $45        |  | Total upcoming: $295        |       |
| |                            |  | Truly available: $1,805     |       |
| +----------------------------+  +-----------------------------+       |
|                                                                       |
| +----------------------------------------------------------------+   |
| | Spending Heatmap - February 2026                               |   |
| |  M  T  W  T  F  S  S                                          |   |
| |                 01 02                                           |   |
| |  03 04 05 06 07 08 09    [light to dark shading by amount]    |   |
| |  10 11 12 13 14 15 16                                          |   |
| |  17 18 19 -- -- -- --                                          |   |
| +----------------------------------------------------------------+   |
|                                                                       |
| +----------------------------------------------------------------+   |
| | Budget vs Actual Trend (6 months)                              |   |
| |  $6k |        .---.                                            |   |
| |  $5k |  .---*'    '---*---budgeted                            |   |
| |  $4k | *'        actual---*                                    |   |
| |      +----+----+----+----+----+----                            |   |
| |      Sep  Oct  Nov  Dec  Jan  Feb                              |   |
| +----------------------------------------------------------------+   |
+-----------------------------------------------------------------------+
```

### 4.4 Budget Creation Wizard Flow

**Step 1 - Choose Strategy:**
- Cards for each budget strategy: Fixed, Rollover, Zero-Based, 50/30/20
- Each card explains the strategy with pros/cons
- Pick analysis period (3/6/12 months) for auto-generation
- Pick budget profile (Comfortable/On Track/Aggressive)
- "Analyze My Spending" button triggers the generator

**Step 2 - Review Categories:**
- Table showing each category with: historical median, suggested amount, editable input
- Grouped by: Income categories at top, then expense categories sorted by suggested amount descending
- Each row shows a mini sparkline of monthly spending for that category
- Totals at bottom: Total Income, Total Expenses, Net (savings/deficit)
- Profile toggle at top: switch between Comfortable/On Track/Aggressive to see amounts change
- "Add Category" to include categories not in the suggestions
- For 50/30/20: categories grouped into Needs/Wants/Savings with percentage targets shown

**Step 3 - Configure Options:**
- Rollover rules per category (if rollover strategy selected)
- Flex group assignment
- Alert thresholds (global defaults + per-category overrides)
- Income linking toggle
- Excluded accounts (e.g., investment accounts)

**Step 4 - Review & Create:**
- Full summary: strategy, total budget, projected savings, category count
- Visual preview of how the dashboard will look
- "Create Budget" button

### 4.5 Alert Integration

**In-app alerts (always available):**
- Bell icon badge in the AppHeader showing unread budget alert count
- Alert dropdown panel with severity-colored items
- Click-through to the specific budget category
- "Mark all read" action

**Toast notifications:**
- When the user opens the budget page and new alerts exist since last visit
- Real-time SSE (if AI module SSE pattern exists) or poll on page load

### 4.6 Frontend API Client

```
frontend/src/lib/budgets.ts

  budgetApi = {
    // CRUD
    create, getAll, getById, update, delete,

    // Categories
    addCategory, updateCategory, removeCategory, bulkUpdateCategories,

    // Generator
    generate, applyGenerated,

    // Execution
    getSummary, getVelocity, getCategoryTransactions,

    // Periods
    getPeriods, getPeriodDetail, closePeriod,

    // Reports
    getTrend, getCategoryTrend, getHealthScore, getSeasonalPatterns, getFlexGroupStatus,

    // Alerts
    getAlerts, markAlertRead, markAllAlertsRead,
  }
```

### 4.7 Types

```
frontend/src/types/budget.ts

  - Budget, BudgetCategory, BudgetPeriod, BudgetPeriodCategory, BudgetAlert
  - CreateBudgetData, UpdateBudgetData
  - CreateBudgetCategoryData, UpdateBudgetCategoryData
  - GenerateBudgetRequest, GenerateBudgetResponse
  - BudgetSummary, BudgetVelocity, BudgetHealthScore
  - BudgetTrendPoint, CategoryTrendPoint
  - FlexGroupStatus, SeasonalPattern
  - BudgetStrategy, BudgetType, RolloverType, CategoryGroup, AlertType, AlertSeverity (enums)
```

---

## Part 5: Reports

### 5.1 Built-in Budget Reports

Added to the existing reports page as a "Budget" section:

1. **Budget vs Actual** -- Bar chart showing budgeted amount (outline) vs actual spending (filled) per category. Color-coded: green (under), yellow (near), red (over).

2. **Budget Trend** -- Line chart showing total budgeted vs total actual over the last 6-12 months. Shows whether the user is improving over time.

3. **Category Performance** -- Table showing each category's budget performance over multiple months. Highlights consistently over/under budget categories with trend arrows.

4. **Savings Rate** -- Line chart of `(income - expenses) / income` over time. Shows actual savings rate vs target.

5. **Health Score History** -- Line chart of monthly health scores. Shows trajectory.

6. **Flex Group Analysis** -- For each flex group: stacked bar of component categories, with the group limit shown as a reference line.

7. **Seasonal Spending Map** -- Heatmap grid (12 months x N categories) showing which months have historically high spending per category. Helps users plan ahead.

### 5.2 Integration with Existing Custom Reports

Add a new `BUDGET_VARIANCE` metric to the custom reports engine so users can build their own budget reports with the flexible report builder.

---

## Part 6: Notifications & Alerts

### 6.1 Alert Types

| Alert Type | Trigger | Severity | Email? |
|---|---|---|---|
| PACE_WARNING | Daily burn rate projects >110% of budget by period end | warning | Weekly digest |
| THRESHOLD_WARNING | Category spending reaches warn % (default 80%) | warning | Weekly digest |
| THRESHOLD_CRITICAL | Category spending reaches critical % (default 95%) | critical | Immediate |
| OVER_BUDGET | Category spending exceeds 100% | critical | Immediate |
| FLEX_GROUP_WARNING | Flex group total reaches 90% | warning | Weekly digest |
| SEASONAL_SPIKE | Upcoming month has historically high spending | info | Weekly digest |
| PROJECTED_OVERSPEND | Current velocity projects overspend by >15% | warning | Weekly digest |
| INCOME_SHORTFALL | Actual income <80% of expected (for income-linked budgets) | critical | Immediate |
| POSITIVE_MILESTONE | 50%+ through period and under 60% of budget | success | Weekly digest |

### 6.2 Email Templates

**Immediate alert email:**
- Subject: "Monize: Budget alert - [Category] is [over budget / at 95%]"
- Body: category name, amount spent, budget limit, % used, link to budget dashboard

**Weekly budget digest email:**
- Subject: "Monize: Your weekly budget summary"
- Body: health score, top 3 categories needing attention, safe daily spend for the week, any upcoming seasonal warnings, link to budget dashboard

**Monthly budget summary email:**
- Subject: "Monize: [Month] budget report"
- Body: total budget vs actual, savings achieved, health score, top wins (biggest underspends), areas for improvement, comparison to previous month, link to full report

### 6.3 User Preferences

Add to `user_preferences` or budget config:
- `budget_alert_email`: boolean (receive budget alert emails)
- `budget_digest_day`: 'MONDAY' | 'FRIDAY' (weekly digest day)
- `budget_digest_enabled`: boolean

---

## Part 7: Navigation & Integration

### 7.1 Navigation Updates

Add "Budgets" to the main nav links in `AppHeader.tsx`:

```typescript
const navLinks = [
  { href: '/transactions', label: 'Transactions' },
  { href: '/accounts', label: 'Accounts' },
  { href: '/budgets', label: 'Budgets' },        // NEW
  { href: '/investments', label: 'Investments' },
  { href: '/bills', label: 'Bills & Deposits' },
  { href: '/reports', label: 'Reports' },
];
```

### 7.2 Dashboard Integration

Add a "Budget Status" widget to the main dashboard:
- Mini health score gauge
- Top 3 categories closest to limit
- "Safe to spend today" callout
- Link to full budget dashboard

### 7.3 Transaction Page Integration

When viewing a transaction, show a subtle indicator if the transaction's category is approaching or over its budget limit. This gives context without being intrusive.

---

## Part 8: Implementation Order

The implementation will proceed in logical phases, each delivering usable functionality:

### Phase 1: Foundation (Database + Entities + CRUD)
1. Add schema to `database/schema.sql`
2. Create TypeORM entities (budget, budget-category, budget-period, budget-period-category, budget-alert)
3. Create DTOs with full validation
4. Implement BudgetsService with CRUD operations
5. Implement BudgetsController with all CRUD endpoints
6. Wire up BudgetsModule in app.module.ts
7. Write unit tests for service layer

### Phase 2: Budget Generator
1. Implement BudgetGeneratorService (spending analysis, percentile calculation, seasonal detection)
2. Create generate/apply endpoints
3. Write unit tests for generator algorithms
4. Build frontend wizard components (BudgetWizard, steps 1-4)
5. Create frontend API client (`lib/budgets.ts`)
6. Create frontend types (`types/budget.ts`)

### Phase 3: Budget Dashboard
1. Implement budget summary endpoint (actuals vs budgeted)
2. Implement velocity calculation endpoint
3. Build BudgetDashboard with SummaryCards, CategoryList, ProgressBars
4. Build VelocityWidget with pace indicator
5. Build HealthGauge component
6. Build FlexGroupCard component
7. Build UpcomingBills widget (integrate with scheduled transactions)
8. Add navigation link and route pages

### Phase 4: Period Management & Rollover
1. Implement BudgetPeriodService (period creation, close, rollover calculation)
2. Implement period close cron job (1st of each month)
3. Build PeriodSelector component
4. Build historical period views
5. Write integration tests for rollover logic

### Phase 5: Alerts & Notifications
1. Implement BudgetAlertService with cron job
2. Create budget alert email templates
3. Implement weekly digest email
4. Build AlertBadge in AppHeader
5. Build AlertList dropdown
6. Add budget notification preferences to user settings
7. Write tests for alert threshold logic

### Phase 6: Reports & Analytics
1. Implement BudgetReportsService
2. Build BudgetTrendChart, CategoryTrend, SeasonalMap components
3. Build SpendingHeatmap component
4. Add budget reports section to reports page
5. Build ScenarioPlanner (what-if tool)

### Phase 7: Integration & Polish
1. Add dashboard budget widget
2. Add budget context to transaction list
3. Integrate budget status tool with AI module
4. Add budget data to AI query tools
5. End-to-end tests for critical flows
6. Performance optimization (batch queries, indexes)

---

## Part 9: Testing Strategy

### Unit Tests (80%+ coverage)
- BudgetsService: CRUD operations, ownership checks
- BudgetGeneratorService: percentile calculations, seasonal detection, fixed-expense detection
- BudgetPeriodService: rollover math, period close logic
- BudgetAlertService: threshold checks, velocity projections, deduplication
- BudgetReportsService: trend calculations, health score algorithm
- All DTOs: validation edge cases

### Integration Tests
- Full budget lifecycle: create -> add categories -> execute -> close period -> rollover
- Generator: analysis with real transaction data patterns
- Alert generation: various threshold scenarios
- API endpoint authentication and authorization

### E2E Tests (Playwright)
- Budget wizard: walk through all 4 steps, create budget
- Dashboard: verify summary cards, progress bars, velocity display
- Alert flow: trigger alert, verify badge, mark as read
- Period navigation: switch between months, verify historical data

---

## Part 10: Performance Considerations

1. **Batch queries**: Compute all category actuals in a single aggregation query, not N queries per category
2. **Caching**: Cache the current period summary and invalidate when transactions are created/updated/deleted (hook into transaction service events)
3. **Indexes**: Composite index on `(user_id, category_id, transaction_date)` for fast period aggregation
4. **Pagination**: Alert list is paginated (default 20 per page)
5. **Lazy loading**: Budget reports load on demand (dynamic imports for chart components)
6. **Currency conversion**: Use the existing rate map pattern from built-in reports (single batch fetch)

---

## Summary of Creative Features

| Feature | Why It Matters |
|---|---|
| Auto-Budget Generator | No manual data entry -- realistic targets from day one |
| Three Budget Profiles | Users can choose their comfort level (comfortable/on-track/aggressive) |
| Spending Velocity | Tells you "can I afford coffee today?" not just "am I over budget this month" |
| Flex Groups | Reflects how real spending works -- categories trade off against each other |
| Seasonal Intelligence | Proactive warnings before expensive months, not reactive regret after |
| Income-Linked % | Variable income? Budget automatically adapts to reality |
| Smart Rollover | Different strategies per category (clothing saves up, groceries don't) |
| Budget Health Score | One number that tells you how you're doing -- gamification that helps |
| What-If Planner | Try changes risk-free before committing |
| Spending Heatmap | Visual pattern recognition -- see which days/weeks are expensive |
| Upcoming Bills Awareness | "Truly available" is more honest than "remaining budget" |
| Safe Daily Spend | The most actionable metric: "You can spend $X today and stay on track" |
| Positive Milestones | Celebrates wins, not just warns about problems -- keeps users motivated |

---

## Implementation Checklist

### Phase 1: Foundation (Database + Entities + CRUD) -- COMPLETE

- [x] Add budget tables to `database/schema.sql` (budgets, budget_categories, budget_periods, budget_period_categories, budget_alerts)
- [x] Create migration `database/migrations/015_add_budget_tables.sql` with all indexes and triggers
- [x] Create TypeORM entity: `budget.entity.ts` with BudgetType, BudgetStrategy enums
- [x] Create TypeORM entity: `budget-category.entity.ts` with RolloverType, CategoryGroup enums
- [x] Create TypeORM entity: `budget-period.entity.ts`
- [x] Create TypeORM entity: `budget-period-category.entity.ts`
- [x] Create TypeORM entity: `budget-alert.entity.ts` with AlertType, AlertSeverity enums
- [x] Create DTO: `create-budget.dto.ts` with validation (SanitizeHtml, max lengths, enum checks)
- [x] Create DTO: `update-budget.dto.ts` with partial update support
- [x] Create DTO: `create-budget-category.dto.ts`
- [x] Create DTO: `update-budget-category.dto.ts`
- [x] Create DTO: `bulk-update-budget-categories.dto.ts`
- [x] Create DTO: `generate-budget.dto.ts` with profile enums (COMFORTABLE, ON_TRACK, AGGRESSIVE)
- [x] Implement BudgetsService CRUD: create, findAll, findOne, update, remove
- [x] Implement BudgetsService category management: addCategory, updateCategory, removeCategory, bulkUpdateCategories
- [x] Implement BudgetsService summary: getSummary with category breakdown and actuals (including split transactions)
- [x] Implement BudgetsService velocity: getVelocity with daily burn rate, projections, safe daily spend
- [x] Implement BudgetsService alerts: getAlerts, markAlertRead, markAllAlertsRead
- [x] Implement BudgetsController with 18 endpoints (CRUD, categories, summary, velocity, periods, alerts)
- [x] Implement BudgetPeriodService: findAll, findOne, closePeriod, getOrCreateCurrentPeriod, createPeriodForBudget
- [x] Implement rollover calculation supporting all types (NONE, MONTHLY, QUARTERLY, ANNUAL) with caps
- [x] Create BudgetsModule and register in app.module.ts
- [x] Write unit tests: `budgets.service.spec.ts` (25+ test cases, 831 lines)
- [x] Write unit tests: `budgets.controller.spec.ts` (14+ test cases, 317 lines)
- [x] Write unit tests: `budget-period.service.spec.ts` (521 lines, rollover logic tests)

### Phase 2: Budget Generator -- NOT STARTED

- [ ] Implement BudgetGeneratorService with spending analysis algorithm
  - [ ] Historical spending aggregation by category over configurable window (3/6/12 months)
  - [ ] Percentile calculations (p25, p50/median, p75) per category
  - [ ] Fixed expense detection (low variance = subscription/bill)
  - [ ] Seasonal peak detection (>1.5 standard deviations above mean)
  - [ ] Monthly occurrence counting
  - [ ] Income estimation from income-category transactions
  - [ ] Three budget profiles: Comfortable (p75), On Track (median), Aggressive (p25)
  - [ ] Projected savings calculation per profile
- [ ] Add `POST /budgets/generate` endpoint (analyze spending and return suggestions)
- [ ] Add `POST /budgets/generate/apply` endpoint (create budget from accepted suggestions)
- [ ] Register BudgetGeneratorService in BudgetsModule
- [ ] Write unit tests for generator algorithms (percentile math, seasonal detection, fixed-expense detection)
- [ ] Create frontend types: `frontend/src/types/budget.ts` (Budget, BudgetCategory, BudgetPeriod, BudgetPeriodCategory, BudgetAlert, enums, request/response types)
- [ ] Create frontend API client: `frontend/src/lib/budgets.ts` (all API methods)
- [ ] Build BudgetWizard multi-step container component
- [ ] Build BudgetWizardStrategy (Step 1): strategy cards, analysis period picker, profile selector
- [ ] Build BudgetWizardCategories (Step 2): category table with historical data, editable amounts, profile toggle, sparklines
- [ ] Build BudgetWizardStrategy options (Step 3): rollover rules, flex groups, alert thresholds, income linking, excluded accounts
- [ ] Build BudgetWizardReview (Step 4): full summary, visual preview, create button
- [ ] Create budget creation page: `frontend/src/app/(authenticated)/budgets/create/page.tsx`

### Phase 3: Budget Dashboard -- COMPLETE

**Backend (complete):**
- [x] Implement budget summary endpoint with category actuals
- [x] Implement velocity calculation endpoint with pace tracking

**Frontend (complete):**
- [x] Create budget detail/dashboard page: `frontend/src/app/budgets/[id]/page.tsx`
- [x] Create budget edit page: `frontend/src/app/budgets/[id]/edit/page.tsx`
- [x] Build BudgetDashboard main container component
- [x] Build BudgetSummaryCards (total budget, spent, remaining, savings)
- [x] Build BudgetHealthGauge (circular 0-100 gauge with color labels)
- [x] Build BudgetCategoryList (sortable list of categories with progress)
- [x] Build BudgetCategoryRow (progress bar + amounts + velocity per category)
- [x] Build BudgetProgressBar (colored bar with pace marker)
- [x] Build BudgetVelocityWidget (burn rate, safe daily spend, projected end)
- [x] Build BudgetFlexGroupCard (aggregate flex group view)
- [x] Build BudgetUpcomingBills (scheduled transactions impact, "truly available" calculation)
- [x] Build BudgetHeatmap (calendar heatmap of daily spending)
- [x] Build BudgetTrendChart (line chart: budget vs actual over months)
- [x] Build BudgetPeriodSelector (switch between current/historical periods)
- [x] Build BudgetCategoryForm (edit single category allocation)
- [x] Build BudgetForm (edit budget settings)
- [x] Add "Budgets" to AppHeader navigation links (between Accounts and Investments)

### Phase 4: Period Management & Rollover -- COMPLETE

**Backend:**
- [x] Implement BudgetPeriodService with full period lifecycle
- [x] Implement period creation with automatic category allocations
- [x] Implement period close with actuals computation
- [x] Implement rollover calculation for all types (NONE, MONTHLY, QUARTERLY, ANNUAL) with caps
- [x] Implement next period auto-creation with rollover carry-forward
- [x] Controller endpoints: list periods, get period detail, close period
- [x] Add cron job for automatic period closing (1st of each month) via BudgetPeriodCronService
- [x] Write integration tests for full period lifecycle (create -> execute -> close -> rollover -> next)

**Frontend:**
- [x] Build BudgetPeriodSelector component (period navigation dropdown)
- [x] Build BudgetPeriodDetail component (historical period detail views with rollover summary)
- [x] Wire PeriodSelector to load historical period data via getPeriodDetail API
- [x] Show current period dashboard (BudgetDashboard) or historical period view (BudgetPeriodDetail) based on selection

### Phase 5: Alerts & Notifications -- COMPLETE

Note: Alert entity, repository, and basic retrieval/marking endpoints exist from Phase 1. Alert generation logic added in this phase.

- [x] Implement BudgetAlertService with daily cron job (7 AM UTC)
  - [x] Threshold alerts: warn at configurable % (default 80%), critical at 95%, over at 100%
  - [x] Velocity/pace alerts: projected overspend >110% by period end
  - [x] Flex group alerts: group total reaching 90%
  - [ ] Seasonal spike warnings: upcoming historically expensive month (deferred -- requires historical data analysis)
  - [x] Projected overspend alerts: current velocity projects >15% over budget
  - [x] Income shortfall alerts: actual income <80% of expected (income-linked budgets)
  - [x] Positive milestone alerts: 50%+ through period and under 60% of budget
  - [x] De-duplication: prevent re-alerting for same category + type + period
- [x] Create budget alert email templates (immediate alert + weekly digest)
- [x] Implement immediate alert emails (critical threshold / over-budget / income shortfall)
- [x] Implement weekly budget digest email (configurable Monday/Friday)
- [ ] Implement monthly budget summary email at period close (deferred to Phase 7)
- [x] Build BudgetAlertBadge component in AppHeader (unread count badge)
- [x] Build BudgetAlertList dropdown component (severity-colored, mark-as-read, click-through)
- [x] Add budget notification preferences to user settings (budget_digest_enabled, budget_digest_day)
- [x] Write tests for alert threshold logic and de-duplication (43 backend + 28 frontend + 7 settings tests)

### Phase 6: Reports & Analytics -- COMPLETE

- [x] Implement BudgetReportsService
  - [x] Budget vs Actual trend over N months
  - [x] Per-category trend over time
  - [x] Health score calculation (0-100 algorithm with deductions/bonuses)
  - [x] Seasonal spending pattern analysis
  - [x] Flex group status aggregation
- [x] Add report endpoints to controller:
  - [x] `GET /budgets/:id/reports/trend`
  - [x] `GET /budgets/:id/reports/category-trend`
  - [x] `GET /budgets/:id/reports/health-score`
  - [x] `GET /budgets/:id/reports/seasonal`
  - [x] `GET /budgets/:id/reports/flex-groups`
- [x] Build BudgetTrendChart component (bar + line chart in BudgetVsActualReport with variance line)
- [x] Build BudgetCategoryTrend component (per-category trend comparison with toggle and summary table)
- [x] Build BudgetSeasonalPatternsReport (bar chart with high-month highlighting, replaces heatmap)
- [x] Build BudgetScenarioPlanner component (what-if slider tool, frontend-only calculation)
- [x] Add "Budget" section to existing reports page (3 reports: vs actual, health score, seasonal)
- [x] Add BUDGET_VARIANCE metric to custom reports engine
- [x] Write unit tests for health score algorithm and trend calculations (32 backend + 19 frontend tests)

### Phase 7: Integration & Polish -- COMPLETE (except E2E tests)

- [x] Add budget status widget to main dashboard (top 3 categories by usage, safe daily spend, days remaining)
- [x] Add budget context indicator to transaction list (colored dot when category approaching/over limit)
- [x] Implement `get_budget_status` AI tool in ToolExecutorService (current/previous/specific period)
- [x] Connect budget tool to AI query system via tool definitions + ToolExecutorService integration
- [x] Implement monthly budget summary email at period close (deferred from Phase 5)
  - [x] budgetMonthlySummaryTemplate in email-templates.ts
  - [x] sendMonthlySummaryEmails in BudgetPeriodCronService (triggers after period close)
  - [x] Per-user email preference check (budgetDigestEnabled)
- [x] Add `GET /budgets/dashboard-summary` endpoint for dashboard widget
- [x] Add `POST /budgets/category-budget-status` endpoint for transaction list context
- [x] Extract shared budget-date.utils.ts (getCurrentMonthPeriodDates, getMonthPeriodDates, etc.)
- [x] Extract shared frontend budget-colors.ts utility (budgetPercentColor, budgetProgressBarColor, etc.)
- [x] Add partial index idx_budget_periods_open for OPEN period lookups
- [x] Wire BudgetsModule into AiModule for get_budget_status tool
- [x] Security review: all endpoints verified (auth guards, userId derivation, parameterized queries, input validation, HTML escaping in email templates)
- [x] Unit tests: budget-date.utils, getDashboardSummary, getCategoryBudgetStatus, get_budget_status AI tool, BudgetPeriodCronService monthly email, email template, BudgetStatusWidget frontend component
- [ ] E2E tests (Playwright) -- deferred:
  - [ ] Budget wizard: walk through all 4 steps and create budget
  - [ ] Dashboard: verify summary cards, progress bars, velocity display
  - [ ] Alert flow: trigger alert, verify badge, mark as read
  - [ ] Period navigation: switch between months, verify historical data
- [x] Performance optimization: batch queries verified, partial index added for OPEN periods
