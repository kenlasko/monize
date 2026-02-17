# Monize AI Integration Plan

## Overview

This document outlines the plan for integrating AI capabilities into Monize, covering three major areas:

1. **Multi-Provider AI Service** - Backend abstraction supporting multiple AI providers (Claude, OpenAI, Ollama, etc.)
2. **AI-Powered Financial Features** - Intelligent features leveraging user financial data
3. **MCP Server** - Model Context Protocol server enabling local AI clients to interact with Monize data

---

## Part 1: Multi-Provider AI Architecture

### Design Principles

- **Provider-agnostic**: All AI features work through an abstract interface; swapping providers requires zero feature code changes
- **User-configurable**: Users select their preferred provider and supply their own API keys
- **Fallback support**: Optional fallback chain (e.g., try Claude first, fall back to local Ollama)
- **Privacy-first**: Users control which data leaves their system; local providers (Ollama) keep everything on-device
- **Cost transparency**: Token usage tracking so users understand API costs

### Supported Providers (Initial)

| Provider | Type | Use Case |
|----------|------|----------|
| Anthropic Claude | Cloud API | Primary cloud provider, strong reasoning |
| OpenAI (GPT) | Cloud API | Alternative cloud provider |
| Ollama | Local/Self-hosted | Privacy-focused, no data leaves device |
| OpenAI-compatible | Cloud/Local | Any provider with OpenAI-compatible API (Groq, Together, LM Studio, etc.) |

### Backend Architecture

#### New Module: `/backend/src/ai/`

```
backend/src/ai/
  ai.module.ts                      # NestJS module registration
  ai.controller.ts                  # REST endpoints for AI features
  ai.service.ts                     # Orchestrator: routes requests through provider
  ai-provider.factory.ts            # Factory to instantiate the correct provider
  ai-usage.service.ts               # Token usage tracking and limits

  providers/
    ai-provider.interface.ts        # Abstract interface all providers implement
    anthropic.provider.ts           # Claude API implementation
    openai.provider.ts              # OpenAI API implementation
    ollama.provider.ts              # Ollama local model implementation
    openai-compatible.provider.ts   # Generic OpenAI-compatible endpoint

  context/
    financial-context.builder.ts    # Builds financial context from user data for prompts
    prompt-templates.ts             # Reusable prompt templates for financial tasks
    schema-definitions.ts           # Structured output schemas (tool use / function calling)

  dto/
    ai-config.dto.ts                # Provider configuration DTO
    ai-query.dto.ts                 # User query request DTO
    ai-response.dto.ts              # Standardized response DTO
    categorize-request.dto.ts       # Transaction categorization request
    insight-request.dto.ts          # Financial insight request

  entities/
    ai-provider-config.entity.ts    # Per-user provider configuration (encrypted keys)
    ai-usage-log.entity.ts          # Token usage tracking per request
```

#### Provider Interface

```typescript
interface AiProvider {
  readonly name: string;
  readonly supportsStreaming: boolean;
  readonly supportsToolUse: boolean;

  // Core completion
  complete(request: AiCompletionRequest): Promise<AiCompletionResponse>;

  // Streaming (optional)
  stream?(request: AiCompletionRequest): AsyncIterable<AiStreamChunk>;

  // Structured output via tool use / function calling
  completeWithTools?(
    request: AiCompletionRequest,
    tools: AiToolDefinition[]
  ): Promise<AiToolResponse>;

  // Health check
  isAvailable(): Promise<boolean>;
}

interface AiCompletionRequest {
  systemPrompt: string;
  messages: AiMessage[];
  maxTokens?: number;
  temperature?: number;
  userId: string;   // For usage tracking
}

interface AiCompletionResponse {
  content: string;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  provider: string;
}
```

#### Provider Configuration (Per-User)

Each user configures their AI provider independently. API keys are encrypted at rest using AES-256-GCM with a server-side encryption key.

```
Database table: ai_provider_configs
  id              UUID PRIMARY KEY
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE
  provider        VARCHAR(50) NOT NULL  -- 'anthropic', 'openai', 'ollama', 'openai-compatible'
  is_active       BOOLEAN DEFAULT true
  priority        INTEGER DEFAULT 0     -- For fallback ordering
  model           VARCHAR(100)          -- e.g., 'claude-sonnet-4-20250514', 'gpt-4o', 'llama3'
  api_key_enc     BYTEA                 -- Encrypted API key (null for Ollama)
  base_url        VARCHAR(500)          -- Custom endpoint URL (required for Ollama/compatible)
  config          JSONB                 -- Provider-specific settings (temperature, max tokens, etc.)
  created_at      TIMESTAMP DEFAULT NOW()
  updated_at      TIMESTAMP DEFAULT NOW()
  UNIQUE(user_id, provider, priority)
```

#### Usage Tracking

```
Database table: ai_usage_logs
  id              UUID PRIMARY KEY
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE
  provider        VARCHAR(50) NOT NULL
  model           VARCHAR(100) NOT NULL
  feature         VARCHAR(50) NOT NULL  -- 'categorize', 'insight', 'query', 'forecast'
  input_tokens    INTEGER NOT NULL
  output_tokens   INTEGER NOT NULL
  duration_ms     INTEGER NOT NULL
  created_at      TIMESTAMP DEFAULT NOW()
```

### Environment Variables (New)

```env
# AI Encryption (required if AI features enabled)
AI_ENCRYPTION_KEY=         # 32-byte hex key for encrypting user API keys at rest

# Optional: System-level default provider (users can override)
AI_DEFAULT_PROVIDER=       # 'anthropic', 'openai', 'ollama'
AI_DEFAULT_MODEL=          # Default model for the provider
AI_DEFAULT_API_KEY=        # System-wide API key (if admin wants to provide one)
AI_DEFAULT_BASE_URL=       # For Ollama or compatible endpoints

# Rate limiting for AI endpoints
AI_RATE_LIMIT_PER_MINUTE=10
```

### Frontend: Settings UI

Add an "AI Settings" section under user settings:

```
frontend/src/app/settings/ai/
  page.tsx                          # AI settings page
  components/
    ProviderConfigForm.tsx          # Add/edit provider configuration
    ProviderList.tsx                # List configured providers with status
    UsageDashboard.tsx              # Token usage stats and costs
    ProviderTestButton.tsx          # Test connection button
```

**Settings page features:**
- Add/remove AI providers
- Configure API keys (masked input, encrypted storage)
- Set provider priority for fallback
- Select model per provider
- Test connection button (calls `isAvailable()`)
- View token usage history with estimated costs
- Toggle AI features on/off globally

---

## Part 2: AI-Powered Financial Features

### Feature 1: Smart Transaction Categorization

**Goal**: Automatically suggest or assign categories to uncategorized transactions based on payee name, amount, description, and user's historical patterns.

**How it works:**
1. When a transaction is created without a category (or during QIF import), the AI examines:
   - Payee name and description
   - Amount and transaction type
   - User's existing category assignments for similar transactions
   - User's category tree structure
2. Returns a suggested category (or top 3 suggestions with confidence scores)
3. User confirms or corrects; corrections improve future suggestions

**Implementation:**
- Endpoint: `POST /api/v1/ai/categorize`
- Uses tool/function calling for structured output (category ID + confidence)
- Batch mode for import: `POST /api/v1/ai/categorize-batch` (up to 50 transactions)
- Context builder pulls user's categories, recent similar transactions, and payee defaults
- Falls back to payee default category if AI unavailable

**Prompt strategy:**
- System prompt includes user's full category tree with IDs
- Includes 10-20 recent transactions with same/similar payee as few-shot examples
- Requests structured output: `{ categoryId: string, confidence: number, reasoning: string }`

### Feature 2: Natural Language Financial Queries

**Goal**: Allow users to ask questions about their finances in natural language and get accurate, data-backed answers.

**Example queries:**
- "How much did I spend on dining out last month?"
- "What are my top 5 expense categories this year?"
- "Compare my grocery spending this month vs last month"
- "What's my average monthly electricity bill?"
- "Show me all transactions over $500 in the last 3 months"
- "How much have I saved this year compared to last year?"

**How it works:**
1. User types a question in a chat-like interface
2. AI translates the question into structured data queries using tool/function calling
3. Backend executes the queries against user's actual data
4. AI formats the results into a human-readable response with relevant numbers
5. Optionally suggests a chart or report to visualize the answer

**Implementation:**
- Endpoint: `POST /api/v1/ai/query`
- Streaming endpoint: `GET /api/v1/ai/query/stream` (SSE for real-time responses)
- Tool definitions for: `query_transactions`, `get_account_balances`, `get_spending_by_category`, `get_income_summary`, `get_net_worth_history`, `compare_periods`
- The AI never sees raw transaction data directly; it calls tools that return aggregated results
- Results include source references (which accounts, date ranges, categories were queried)

**Frontend:**
```
frontend/src/app/ai/
  page.tsx                          # AI assistant page
  components/
    ChatInterface.tsx               # Chat-style query interface
    QueryResult.tsx                 # Formatted result display
    SuggestedQueries.tsx            # Quick-action query suggestions
    ResultChart.tsx                 # Inline chart for query results
```

### Feature 3: Spending Insights and Anomaly Detection

**Goal**: Proactively surface interesting patterns, anomalies, and trends in the user's financial data.

**Types of insights:**
- Unusual spending in a category compared to historical average
- Recurring charges that changed in amount
- New recurring charges detected
- Spending velocity alerts (on pace to exceed monthly budget)
- Subscription consolidation opportunities
- Category spending trends (increasing/decreasing over time)
- Seasonal spending pattern recognition

**How it works:**
1. Backend computes aggregate statistics (spending by category, monthly trends, recurring patterns)
2. AI analyzes the aggregates and generates human-readable insights
3. Insights are cached and refreshed periodically (not on every page load)
4. Displayed on dashboard or dedicated insights page

**Implementation:**
- Endpoint: `GET /api/v1/ai/insights` (returns cached insights)
- Background job: Regenerate insights daily or on-demand
- Insight types have templates; AI fills in the specifics
- Each insight includes: title, description, severity (info/warning/alert), related data, suggested action
- Users can dismiss/acknowledge insights

**Database:**
```
Table: ai_insights
  id              UUID PRIMARY KEY
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE
  type            VARCHAR(50)       -- 'anomaly', 'trend', 'subscription', 'budget_pace'
  title           VARCHAR(255)
  description     TEXT
  severity        VARCHAR(20)       -- 'info', 'warning', 'alert'
  data            JSONB             -- Supporting data (amounts, categories, dates)
  is_dismissed    BOOLEAN DEFAULT false
  generated_at    TIMESTAMP
  expires_at      TIMESTAMP         -- Auto-cleanup old insights
  created_at      TIMESTAMP DEFAULT NOW()
```

### Feature 4: Enhanced Cash Flow Forecasting

**Goal**: Improve the existing forecast functionality with AI-powered predictions that account for patterns, seasonality, and irregular expenses.

**Enhancements over current forecasting:**
- Detect seasonal patterns (holiday spending, annual subscriptions, property taxes)
- Account for irregular but predictable expenses (car maintenance, medical)
- Factor in income variability for freelancers/contractors
- Provide confidence intervals, not just point estimates
- Natural language summary of forecast ("You'll likely be short $500 in March due to your annual insurance premium")

**Implementation:**
- Endpoint: `POST /api/v1/ai/forecast`
- Feeds AI: scheduled transactions, 12-month transaction history (aggregated by category/month), account balances
- Returns: month-by-month forecast with confidence ranges, narrative summary, risk flags

### Feature 5: Smart Import Assistance

**Goal**: During QIF or future CSV/OFX import, use AI to improve data quality.

**Capabilities:**
- Match imported payee names to existing payees (fuzzy matching with AI disambiguation)
- Suggest categories for imported transactions
- Detect and flag potential duplicates with explanations
- Map unknown account types to Monize account types
- Clean up messy payee names ("AMZN MKTP US*ABC123" -> "Amazon")

**Implementation:**
- Extends existing import flow with optional AI-assisted step
- Endpoint: `POST /api/v1/ai/import-assist`
- Batch processing for efficiency (single AI call for entire import set)

### Feature 6: Budget Recommendations

**Goal**: Suggest budget amounts based on actual spending history and financial goals.

**Capabilities:**
- Analyze historical spending to suggest realistic budget amounts per category
- Identify categories where the user consistently overspends
- Suggest budget adjustments based on income changes
- Provide "what-if" scenarios ("If you reduce dining out by 20%, you'd save $X/year")

**Implementation:**
- Endpoint: `POST /api/v1/ai/budget-recommend`
- Context: 6-12 months of spending by category, income data, existing budgets (when budget feature exists)

---

## Part 3: MCP Server

### Overview

The MCP (Model Context Protocol) server allows external AI clients (Claude Desktop, other MCP-compatible tools) to interact with Monize data locally. This enables users to query their financial data through their preferred AI interface without Monize needing to build its own chat UI.

### Architecture

The MCP server runs as a separate process (or a mode of the existing backend) and communicates via stdio (for local use) or SSE (for remote use).

```
backend/src/mcp/
  mcp-server.ts                     # MCP server entry point
  mcp-auth.ts                       # Authentication for MCP connections
  tools/
    accounts.tool.ts                # Account-related tools
    transactions.tool.ts            # Transaction query and creation tools
    categories.tool.ts              # Category management tools
    reports.tool.ts                 # Report generation tools
    investments.tool.ts             # Investment and portfolio tools
    budgets.tool.ts                 # Budget-related tools
    net-worth.tool.ts               # Net worth tools
  resources/
    account-list.resource.ts        # Resource: list of accounts
    category-tree.resource.ts       # Resource: category hierarchy
    recent-transactions.resource.ts # Resource: recent transactions
  prompts/
    financial-advisor.prompt.ts     # Prompt: financial analysis context
    transaction-query.prompt.ts     # Prompt: transaction search context
```

### Authentication

MCP connections authenticate via a personal access token (PAT) generated from the Monize UI:

```
Database table: personal_access_tokens
  id              UUID PRIMARY KEY
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE
  name            VARCHAR(100)      -- User-assigned label ("Claude Desktop", "My Laptop")
  token_hash      VARCHAR(64)       -- SHA-256 hash of the token
  last_used_at    TIMESTAMP
  expires_at      TIMESTAMP         -- Optional expiration
  scopes          VARCHAR(500)      -- Comma-separated: 'read', 'write', 'reports'
  created_at      TIMESTAMP DEFAULT NOW()
```

**Token generation flow:**
1. User goes to Settings > API Access
2. Creates a new token with a name and optional scopes
3. Token is shown once (like GitHub PATs)
4. Token is passed to MCP client via environment variable or config file

### MCP Tools

#### Read Tools (scope: `read`)

**`get_accounts`** - List all accounts with balances
- Parameters: `{ type?: AccountType, includeInactive?: boolean }`
- Returns: Account list with names, types, balances, currencies

**`get_account_balance`** - Get detailed balance for a specific account
- Parameters: `{ accountId: string }`
- Returns: Current balance, available balance, credit limit (if applicable)

**`search_transactions`** - Search and filter transactions
- Parameters: `{ query?: string, accountId?: string, categoryId?: string, payeeId?: string, startDate?: string, endDate?: string, minAmount?: number, maxAmount?: number, limit?: number }`
- Returns: Matching transactions with details

**`get_spending_summary`** - Spending breakdown by category
- Parameters: `{ startDate: string, endDate: string, accountIds?: string[] }`
- Returns: Category-wise spending totals and percentages

**`get_income_summary`** - Income breakdown by source
- Parameters: `{ startDate: string, endDate: string }`
- Returns: Income by category/payee

**`get_monthly_trends`** - Month-over-month spending trends
- Parameters: `{ months?: number, categoryIds?: string[] }`
- Returns: Monthly totals for specified categories

**`get_net_worth`** - Current net worth breakdown
- Parameters: `{}`
- Returns: Assets, liabilities, net worth by account

**`get_net_worth_history`** - Net worth over time
- Parameters: `{ months?: number }`
- Returns: Monthly net worth snapshots

**`get_upcoming_bills`** - Scheduled transactions due soon
- Parameters: `{ days?: number }`
- Returns: Bills/payments due within the specified window

**`get_categories`** - Full category tree
- Parameters: `{ type?: 'income' | 'expense' }`
- Returns: Hierarchical category structure

**`get_payees`** - List payees
- Parameters: `{ search?: string }`
- Returns: Payee names with default categories

**`get_portfolio_summary`** - Investment portfolio overview
- Parameters: `{}`
- Returns: Holdings, total value, gains/losses, allocation

**`get_holding_details`** - Details for a specific holding
- Parameters: `{ securityId: string }`
- Returns: Quantity, cost basis, current value, price history

**`compare_periods`** - Compare spending/income between two periods
- Parameters: `{ period1Start: string, period1End: string, period2Start: string, period2End: string, groupBy?: 'category' | 'payee' }`
- Returns: Side-by-side comparison with differences

#### Write Tools (scope: `write`)

**`create_transaction`** - Create a new transaction
- Parameters: `{ accountId: string, amount: number, date: string, payeeId?: string, categoryId?: string, description?: string }`
- Returns: Created transaction details

**`categorize_transaction`** - Assign category to a transaction
- Parameters: `{ transactionId: string, categoryId: string }`
- Returns: Updated transaction

**`create_payee`** - Create a new payee
- Parameters: `{ name: string, defaultCategoryId?: string }`
- Returns: Created payee

#### Report Tools (scope: `reports`)

**`generate_report`** - Run a custom report
- Parameters: `{ type: 'spending_by_category' | 'income_vs_expenses' | 'monthly_trend' | 'net_worth', startDate: string, endDate: string, filters?: object }`
- Returns: Report data in tabular format

**`get_anomalies`** - Find unusual transactions or patterns
- Parameters: `{ months?: number }`
- Returns: Anomalous transactions with explanations

### MCP Resources

Resources provide contextual data that AI clients can read to understand the user's financial setup:

- **`monize://accounts`** - Current account list with types and balances
- **`monize://categories`** - Full category tree
- **`monize://recent-transactions`** - Last 30 days of transactions (summarized)
- **`monize://financial-summary`** - High-level financial snapshot (income, expenses, net worth, budget status)

### MCP Prompts

Pre-built prompts that AI clients can use for common tasks:

- **`financial-review`** - "Review my finances for [period] and provide insights"
- **`budget-check`** - "How am I tracking against my budget this month?"
- **`transaction-lookup`** - "Help me find specific transactions"
- **`spending-analysis`** - "Analyze my spending patterns in [category]"

### MCP Server Deployment Options

#### Option A: Stdio (Local, Recommended)

The MCP server runs as a subprocess launched by the AI client. Best for Claude Desktop and similar local tools.

```json
// claude_desktop_config.json
{
  "mcpServers": {
    "monize": {
      "command": "npx",
      "args": ["monize-mcp-server"],
      "env": {
        "MONIZE_API_URL": "http://localhost:3000",
        "MONIZE_ACCESS_TOKEN": "pat_xxxxxxxxxxxxx"
      }
    }
  }
}
```

#### Option B: SSE (Remote)

For accessing Monize over the network. The MCP server exposes an SSE endpoint.

```
Endpoint: /api/v1/mcp/sse
Authentication: Bearer token (PAT)
```

#### Option C: Embedded in Backend

The MCP server can run as part of the NestJS backend (as a separate entry point), sharing the same database connection and services.

```
npm run start:mcp    # Starts MCP server on stdio
npm run start:mcp:sse # Starts MCP server with SSE transport
```

### MCP Package

Published as a standalone npm package for easy installation:

```
packages/mcp-server/
  package.json                      # "monize-mcp-server"
  src/
    index.ts                        # Entry point
    server.ts                       # MCP server setup
    client.ts                       # Monize API client (calls backend REST API)
    tools/                          # Tool implementations
    resources/                      # Resource implementations
    prompts/                        # Prompt implementations
```

This package connects to Monize's REST API using a PAT, meaning it doesn't need direct database access and can run anywhere.

---

## Part 4: Implementation Phases

### Phase 1: Foundation

**Backend:**
- Create `ai` module with provider interface and factory
- Implement Anthropic Claude provider
- Implement OpenAI provider
- Implement Ollama provider
- Add AI provider configuration entity and endpoints
- Add API key encryption/decryption service
- Add usage tracking entity and service
- Add AI-specific rate limiting

**Frontend:**
- AI settings page (provider configuration, API key management)
- Provider connection testing
- Usage dashboard

**Database:**
- `ai_provider_configs` table
- `ai_usage_logs` table
- Schema updates in `schema.sql`

### Phase 2: Core AI Features

**Smart categorization:**
- Financial context builder (pulls user's categories, recent transactions)
- Categorization endpoint with tool/function calling
- Batch categorization for imports
- Frontend integration in transaction form and import flow

**Natural language queries:**
- Query tool definitions (search transactions, get spending, compare periods)
- Query orchestration endpoint
- Streaming support (SSE)
- Chat interface in frontend

### Phase 3: Insights and Forecasting

**Spending insights:**
- Insights generation service (background job)
- Insights storage and caching
- Dashboard widget for top insights
- Dedicated insights page

**Enhanced forecasting:**
- AI-powered forecast endpoint
- Seasonal pattern detection
- Confidence intervals
- Forecast narrative generation

### Phase 4: MCP Server

**MCP package:**
- Standalone npm package structure
- Monize REST API client
- Personal access token authentication
- All read tools (accounts, transactions, spending, investments)
- Write tools (create transaction, categorize)
- Report tools
- Resources and prompts
- Stdio and SSE transport support

**Backend support:**
- Personal access token CRUD endpoints
- Token generation and hashing
- Scope-based authorization
- Settings UI for token management

---

## Part 5: Security Considerations

### API Key Storage
- User API keys encrypted at rest with AES-256-GCM
- Server-side encryption key via `AI_ENCRYPTION_KEY` environment variable
- Keys never logged or included in error messages
- Keys masked in API responses (show last 4 characters only)

### Data Privacy
- AI context includes only aggregated data by default; raw transaction details are opt-in
- Local provider option (Ollama) keeps all data on-device
- Clear documentation about what data is sent to cloud providers
- Users can review and delete AI usage logs

### MCP Security
- Personal access tokens hashed with SHA-256 before storage
- Token scopes limit what operations MCP clients can perform
- Rate limiting on MCP endpoints
- Audit log for MCP operations
- Token expiration and revocation support

### Prompt Injection Prevention
- User-supplied data (payee names, descriptions) is clearly delimited in prompts
- AI responses are validated against expected schemas before being used
- Tool/function calling used instead of free-text parsing where possible
- Output sanitization before storage or display

---

## Part 6: Testing Strategy

### Unit Tests
- Provider implementations (mock HTTP calls)
- Context builder (verify correct data assembly)
- Encryption/decryption service
- Usage tracking calculations
- MCP tool parameter validation

### Integration Tests
- AI endpoints with mocked provider responses
- Provider configuration CRUD
- Token generation and authentication
- MCP tool execution against test database

### E2E Tests
- Full flow: configure provider -> ask question -> get answer
- Import with AI categorization
- MCP client connection and query execution

---

## Part 7: New Dependencies

### Backend
- `@anthropic-ai/sdk` - Official Anthropic SDK for Claude API
- `openai` - Official OpenAI SDK
- `@modelcontextprotocol/sdk` - Official MCP SDK for building MCP servers
- `ollama` - Ollama client library (or use raw HTTP to avoid dependency)

### MCP Package
- `@modelcontextprotocol/sdk` - MCP SDK
- `axios` - HTTP client for Monize API calls

### Frontend
- No new dependencies expected (uses existing UI components and patterns)
