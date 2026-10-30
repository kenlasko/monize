/* Monize marketing site — vanilla JS, no dependencies */
(function(){

/* ================= Monize site — assets/js/app.js ================= */
(function(){
'use strict';

/* ---------- where screenshots come from ----------
   Primary: local copies in assets/img/screenshots (run scripts/fetch-assets.sh)
   Fallback: the project wiki on GitHub, so the site works before/without that step. */
var LOCAL   = 'assets/img/screenshots/';
var WIKI    = 'https://raw.githubusercontent.com/wiki/kenlasko/monize/images/';
var REPORAW = 'https://raw.githubusercontent.com/kenlasko/monize/main/';
var DEMO    = 'https://demo.monize.net';
var GH      = 'https://github.com/kenlasko/monize';

var $  = function(s,r){ return (r||document).querySelector(s); };
var $$ = function(s,r){ return Array.prototype.slice.call((r||document).querySelectorAll(s)); };

/* ---------- DOM building ----------
   Nothing on this page assigns a built-up string to innerHTML. Every node is
   constructed here, and every piece of copy arrives as a text node, so no
   value from the content model below can ever be parsed as markup (CWE-79).
   el(tag, className, ...children): a child is a Node, a string (becomes text),
   an array of either, or null (skipped). */
function add(parent,child){
  if(child==null) return;
  if(Object.prototype.toString.call(child)==='[object Array]'){
    for(var i=0;i<child.length;i++) add(parent,child[i]);
    return;
  }
  parent.appendChild(child.nodeType ? child : document.createTextNode(String(child)));
}
/* Every tag this page builds, each constructed from a literal. A parameterised
   `document.createElement(t)` is a dynamic HTML sink to any scanner reading the
   file -- it cannot know the argument is hardcoded at all ~20 call sites -- and
   the map costs nothing while making the vocabulary explicit and failing loudly
   on a typo instead of silently creating an <HTMLUnknownElement>. */
var TAGS = {
  b:          function(){ return document.createElement('b'); },
  button:     function(){ return document.createElement('button'); },
  code:       function(){ return document.createElement('code'); },
  details:    function(){ return document.createElement('details'); },
  div:        function(){ return document.createElement('div'); },
  figcaption: function(){ return document.createElement('figcaption'); },
  figure:     function(){ return document.createElement('figure'); },
  h3:         function(){ return document.createElement('h3'); },
  h4:         function(){ return document.createElement('h4'); },
  i:          function(){ return document.createElement('i'); },
  img:        function(){ return document.createElement('img'); },
  p:          function(){ return document.createElement('p'); },
  small:      function(){ return document.createElement('small'); },
  span:       function(){ return document.createElement('span'); },
  summary:    function(){ return document.createElement('summary'); }
};
var el = function(t,c){
  var make = Object.prototype.hasOwnProperty.call(TAGS,t) && TAGS[t];
  if(!make) throw new Error('el: unknown tag "'+t+'" -- add it to TAGS');
  var n=make();
  if(c) n.className=c;
  for(var i=2;i<arguments.length;i++) add(n,arguments[i]);
  return n;
};
/* Empty a node. Replaces `node.innerHTML=''`, which is the same sink even when
   the string is a literal, and reads as one to anyone scanning for it. */
function clear(n){ while(n.firstChild) n.removeChild(n.firstChild); return n; }
/* Empty a node and put these children in it -- the replacement for every
   `node.innerHTML = <something built>` this file used to do. */
function fill(n){
  clear(n);
  for(var i=1;i<arguments.length;i++) add(n,arguments[i]);
  return n;
}
/* Emphasis in the sample copy is written as *asterisks*, not <b> tags, so the
   answer text stays plain data. Returns an array of text nodes and <b>s. */
function rich(s){
  return String(s).split('*').map(function(part,i){
    return i%2 ? el('b',null,part) : document.createTextNode(part);
  });
}
/* The coin rain is decorative, but Math.random is the wrong default to leave
   lying around in a file people copy from (CWE-330). Float in [0,1). */
function rnd(){
  var a=new Uint32Array(1); crypto.getRandomValues(a); return a[0]/4294967296;
}

/* Replace an image with the "Screenshot pending" placeholder. `label` is what
   the placeholder names -- always a name this file already owns, never the
   attribute that was read, so the placeholder cannot echo back text the page
   cannot vouch for. */
function missShot(img,label){
  if(img.dataset.miss||img.id) return; img.dataset.miss='1';
  var ph=el('div','shotmiss', el('span',null,'Screenshot pending'), el('code',null,label));
  if(img.parentNode) img.parentNode.replaceChild(ph,img);
}
function wireShot(img){
  var raw = img.getAttribute('data-shot'); if(raw==null||raw==='') return img;
  /* A name that is not in the vocabulary is a mistake in the page's own data,
     not a URL: say so rather than fetching whatever the attribute asked for. */
  var n = shotName(raw); if(!n){ missShot(img,'unknown screenshot'); return img; }
  img.loading='lazy'; img.decoding='async';
  delete img.dataset.fb; delete img.dataset.miss;
  img.onerror=function(){
    if(!img.dataset.fb){ img.dataset.fb='1'; img.src=shotUrl(WIKI,n); return; }
    missShot(img,n+'.png');
  };
  img.src = shotUrl(LOCAL,n);
  return img;
}
function shot(name,alt){
  var i=el('img'); i.alt=alt||''; i.setAttribute('data-shot',name); return wireShot(i);
}
function full(name){
  var n=shotName(name); if(!n) return null;
  var i=$('[data-shot="'+n+'"]');
  return (i&&i.dataset.fb) ? shotUrl(WIKI,n) : shotUrl(LOCAL,n);
}

/* ---------- content ---------- */
var FCATS = [['all','Everything'],['accounts','Accounts'],['tx','Transactions'],['inv','Investments'],
 ['budget','Budgets'],['reports','Reports'],['ai','AI'],['sec','Security'],['import','Import'],['host','Self-hosting']];

var FEATURES = [
 ['accounts','🏦','Ten account types','Chequing, savings, cash, credit cards, lines of credit, loans, mortgages, investment, asset and other — with brokerage and investment-cash sub-types, each with its own currency, limits and interest rate.'],
 ['accounts','📅','Credit-card cycles','Configurable due dates and statement settlement dates, surfaced right on the dashboard so nothing sneaks up on you.'],
 ['accounts','✅','Reconciliation','Tick off cleared transactions against a statement and settle the difference, the way you always did it.'],
 ['tx','✂️','Splits and transfers','One purchase across several categories, and true double-entry transfers between any two accounts — including accounts shared with someone else.'],
 ['tx','🏷️','Tags','Cross-category labels like “Vacation 2026”, “Tax deductible” or “Reimbursable” that cut across your category tree.'],
 ['tx','🤝','Smart payees','Auto-categorisation rules, wildcard aliases so “AMZN MKTP CA*1234” becomes Amazon, and one-click merging of duplicates.'],
 ['tx','⚡','Bulk everything','Filter-based bulk update and bulk delete, plus copy, attachments and multi-currency amounts with automatic exchange-rate capture.'],
 ['budget','🎯','Budgets that learn','Zero-based or rollover budgets, auto-generated from your own spending history, with velocity tracking and a live “safe to spend today” figure.'],
 ['budget','🔔','Proactive alerts','Threshold notifications, per-category health scoring and flex groups for the categories you deliberately keep loose.'],
 ['inv','📈','Real portfolios','Stocks, ETFs, mutual funds, bonds, options, GICs and crypto across North American, European and Asian exchanges — NYSE, NASDAQ, AMEX, TSX, TSX-V, CSE, LSE, XETRA, Euronext Paris, ASX, Tokyo and HKEX — with buys, sells, dividends, interest, splits and transfers.'],
 ['inv','🔄','Daily prices','Automatic price updates from Yahoo Finance, manual price editing, and backfill from your own transaction history when market data is missing.'],
 ['inv','🌍','Multi-currency','Forty-plus currencies with daily FX rates, per-account currency, automatic conversion for reporting and a currency-exposure report.'],
 ['reports','📊','46 built-in reports','Spending, income, net worth, tax, debt, investment, budget, bills, insights and maintenance — all aggregated server-side.'],
 ['reports','🛠️','Custom report builder','Build your own with flexible filters and pick the chart: pie, bar, line, area or plain table.'],
 ['reports','🔮','Projections','Debt payoff timelines, loan amortisation schedules, an overpayment simulator and a Monte Carlo portfolio simulation.'],
 ['ai','💬','Plain-English answers','“How much did I spend on dining last month?” Eighteen tools do the querying; the model just explains the result.'],
 ['ai','🧠','Spending insights','Anomalies, trends, subscriptions, new recurring charges, budget pace and seasonal patterns, flagged by severity.'],
 ['ai','🔌','MCP server','Connect Claude Desktop or any MCP client straight to your own ledger.'],
 ['import','📥','Import anything','CSV, OFX/QFX and QIF with smart column auto-matching, saved presets and automatic payee matching.'],
 ['import','🗂️','Whole-file migration','Read a Microsoft Money .mny or a multi-account Quicken QIF in one pass — then reconcile every balance against the source file.'],
 ['sec','🔐','Serious auth','OIDC single sign-on, TOTP two-factor with backup codes and trusted devices, refresh-token rotation and personal access tokens.'],
 ['sec','🆘','Emergency access','Nominate trusted contacts who are automatically sent a magic link if you go inactive for a long stretch.'],
 ['sec','💾','Encrypted backups','Manual and scheduled backups, optionally wrapped in AES-256-GCM keyed by your password — safe to sync off-site.'],
 ['host','🐳','Docker or Kubernetes','Docker Compose stacks for dev, prod, demo and E2E, plus Helm charts and health probes for a cluster.'],
 ['host','📱','Installable PWA','Add it to a phone home screen or a desktop dock: own window, cached shell, native-ish feel.'],
 ['host','🌐','Twenty-two locales','Seventeen languages — English (with US, Canadian and UK variants), Deutsch, Español, Français, हिन्दी, Bahasa Indonesia, Italiano, 日本語, 한국어, Nederlands, Polski, Português, Português do Brasil, Русский, Türkçe, Українська, Tiếng Việt, 简体中文 and 繁體中文 — including server messages and emails.'],
 ['accounts','👨‍👩‍👧','Shared access','Give a spouse, accountant or bookkeeper scoped access, or share a chequing account jointly so it appears natively in their own list.'],
 ['host','🔓','AGPL-3.0, no tiers','No subscription, no upsell, no telemetry, no “premium” paywall around your own numbers.']
];

var TOUR = [
 {id:'dashboard', em:'🏠', name:'Dashboard', url:'/dashboard',
  desc:'A customisable overview: favourite accounts, what is due next, net worth, top movers and where the money went.',
  shots:'dashboard-overview:The whole overview in one scroll|dashboard-net-worth:Net worth across the past 12 months|dashboard-upcoming-bills:What is leaving your account next|dashboard-top-movers:Today\u2019s biggest gainers and losers|dashboard-expenses-pie:Expenses by category|dashboard-income-expenses-bar:Income versus expenses'},
 {id:'accounts', em:'🏦', name:'Accounts', url:'/accounts',
  desc:'Every kind of account in one grouped list, with net worth, assets and liabilities totalled at the top.',
  shots:'accounts-list:Grouped by type, with running subtotals|create-account-form:Creating an account|account-reconciliation:Reconciling against a statement'},
 {id:'transactions', em:'💸', name:'Transactions', url:'/transactions',
  desc:'A fast register with balance history, deep filters, splits, tags, attachments and bulk operations.',
  shots:'transactions-page:The transaction register|transaction-form:Entering a transaction|split-transaction:One purchase, several categories|transaction-filters:Filter by account, payee, tag, amount, date or attachment'},
 {id:'bills', em:'🔔', name:'Bills & Deposits', url:'/bills',
  desc:'Recurring bills, deposits and transfers — with a cash-flow forecast that shows your lowest balance before it happens.',
  shots:'bills-deposits-page:Bills, deposits and forecast together|cash-flow-forecast:Forecast 7 days to a year ahead|bills-list:Every schedule, with auto-entry status|scheduled-transaction-form:Setting up a recurrence'},
 {id:'investments', em:'📈', name:'Investments', url:'/investments',
  desc:'Portfolio value, simple and time-weighted returns, allocation by security, country or asset class, and full transaction history.',
  shots:'investments-page:Portfolio summary and allocation|portfolio-holdings:Holdings broken out by account|investment-transaction-form:Buy, sell, dividend, interest or split|securities-list:Securities and price history'},
 {id:'budgets', em:'\uD83C\uDFAF', name:'Budgets', url:'/budgets',
  desc:'Zero-based or rollover budgets, seeded from your own spending history and tracked against actuals in real time.',
  mock:1, shots:''},
 {id:'reports', em:'📊', name:'Reports', url:'/reports',
  desc:'Forty-six built-in reports in ten categories, favouritable and searchable, plus a builder for the ones you invent.',
  shots:'reports-page:The report catalogue|report-spending-category:Spending by category|report-income-expenses:Income versus expenses|report-net-worth:Net worth over time|report-chart-table:Flip any report between chart and table|custom-report-builder:Custom report builder'},
 {id:'ai', em:'🤖', name:'AI Assistant', url:'/ai',
  desc:'Ask questions in plain language, get streamed answers, and let Monize flag anomalies on its own.',
  shots:'ai-chat:Natural-language queries, answered from your own data|ai-settings:Bring your own provider, model and API key'},
 {id:'import', em:'📥', name:'Import', url:'/import',
  desc:'A four-step wizard for CSV, OFX/QFX and QIF — or a full Microsoft Money file in one go.',
  shots:'import-upload-step:Step 1: drop in your files|import-select-account:Step 2: choose the destination account|import-create-account:Create missing accounts on the fly|import-map-accounts:Map every account in a whole-file import|import-map-categories:Map categories to your own tree|import-map-securities:Map securities and tickers|import-review-step:Step 3: review before committing|import-complete-step:Step 4: balances reconciled against the source'},
 {id:'organise', em:'🗂️', name:'Organise', url:'/tags',
  desc:'Hierarchical categories, payees with rules and aliases, tags, institutions, securities and currencies.',
  shots:'tags-page:Tags for cross-category labelling|currencies-page:Currencies and daily exchange rates'},
 {id:'settings', em:'⚙️', name:'Settings & admin', url:'/settings',
  desc:'Preferences, language, two-factor authentication, trusted devices, SSO and user administration.',
  shots:'settings-page:Preferences, language and security|2fa-setup:TOTP two-factor setup|trusted-devices:Trusted device management|oidc-login:Single sign-on via OIDC|admin-user-management:Admin user management'}
];

var REPORTS = 'Spending by Category|Spending;Spending by Payee|Spending;Monthly Spending Trend|Spending;Monthly Breakdown|Spending;Year Over Year Comparison|Spending;Income vs Expenses|Income;Income by Source|Income;Cash Flow Statement|Income;Net Worth Over Time|Net Worth;Account Balances|Net Worth;Tax Summary|Tax;Debt Payoff Timeline|Debt;Loan Amortization Schedule|Debt;Credit Utilization|Debt;Loan Overpayment Simulator|Debt;Investment Performance|Investment;Gains, Dividends & Interest|Investment;Sector Weightings|Investment;Realized Gains & Losses|Investment;Portfolio Value Over Time|Investment;Investment Transaction History|Investment;Security Type Allocation|Investment;Geographic/Exchange Allocation|Investment;Dividend Yield & Growth|Investment;Security Performance|Investment;Currency Exposure|Investment;Monte Carlo Simulation|Investment;GEM Strategy|Investment;Recurring Expenses Tracker|Insights;Spending Anomalies|Insights;Weekend vs Weekday Spending|Insights;Monthly Comparison|Insights;Foreign Currency Transaction Fees|Insights;Uncategorized Transactions|Maintenance;Duplicate Transaction Finder|Maintenance;Budget vs Actual|Budget;Budget Health Score|Budget;Seasonal Spending Patterns|Budget;Budget Trend|Budget;Category Performance|Budget;Savings Rate|Budget;Health Score History|Budget;Flex Group Analysis|Budget;Seasonal Spending Map|Budget;Upcoming Bills Calendar|Bills;Bill Payment History|Bills';

var RCOLOR = {Spending:'#3b82f6',Income:'#22c55e','Net Worth':'#a855f7',Tax:'#f59e0b',Debt:'#ef4444',
 Investment:'#4fa091',Insights:'#ec4899',Maintenance:'#94a3b8',Budget:'#eab308',Bills:'#06b6d4'};

/* Answers are plain text. *Asterisks* mark the emphasised runs; rich() turns
   those into <b> elements, so no markup is stored in the copy itself. */
var QA = [
 ['How much did I spend last month?','You spent *$3,214.66* across 47 transactions in July — about 8% below your 6-month average. The biggest movers were Groceries ($612), Travel ($1,279) and Fuel ($208).'],
 ['What are my top 5 expense categories this year?','Year to date: *Rent/Mortgage $16,590*, Groceries $4,118, Travel $2,589, Fuel $1,046 and Car Insurance $1,110. Those five are 86% of all spending.'],
 ['What are my current account balances?','Chequing *$4,236.14* · Emergency Fund $21,000 · Vacation Fund $5,600 · Wallet $150 · Visa Rewards +$130.55 · Mastercard −$2,006.44 · Mortgage −$377,024.55. Net worth: *$494,187.44*.'],
 ['Compare my spending this month vs last month','August is pacing at $1,882 versus $3,215 for the whole of July. Restaurants are up 34%, but Travel is down $1,110 now that the trip has settled.'],
 ['Show my net worth trend for the last 12 months','Net worth moved from $408.2K to *$490.8K* — up $82.6K (+20.2%). Growth came mostly from mortgage principal repayment and a +$72.9K swing in the portfolio.'],
 ['How much have I saved this year compared to my income?','Income $33,843, expenses $26,349, so you have banked *$7,494* — a *22.1%* savings rate, comfortably ahead of your 15% target.']
];

/* Each sample is a list of [className, text] tokens rather than a blob of
   pre-highlighted HTML: '' is unstyled, 'c' comment, 'k' key, 's' string.
   The text is literal -- no entities to unescape, because nothing is parsed. */
var CODE = [
 ['Docker Compose',[
  ['c','# 1 — grab it'],
  ['','\ngit clone https://github.com/kenlasko/monize.git\ncd monize\n\n'],
  ['c','# 2 — configure'],
  ['','\ncp .env.example .env\n'],
  ['c','#   POSTGRES_PASSWORD=…'],
  ['','\n'],
  ['c','#   JWT_SECRET=$(openssl rand -base64 32)'],
  ['','\n'],
  ['c','#   PUBLIC_APP_URL=https://money.example.com'],
  ['','\n\n'],
  ['c','# 3 — run it'],
  ['','\ndocker compose -f docker-compose.prod.yml up -d\n\n'],
  ['c','# frontend published on :3000 (FRONTEND_PORT)'],
  ['','\n'],
  ['c','# backend stays internal on :3000 (BACKEND_PORT)']
 ]],
 ['Kubernetes',[
  ['c','# Helm charts ship in the repo'],
  ['','\nhelm install monize ./helm\n\n'],
  ['c','# health probes for your cluster'],
  ['','\n'],
  ['k','livenessProbe'],
  ['',':  /api/v1/health/live\n'],
  ['k','readinessProbe'],
  ['',': /api/v1/health/ready\n\n'],
  ['c','# frontend pod'],
  ['','\n- '],
  ['k','name'],
  ['',': INTERNAL_API_URL\n  '],
  ['k','value'],
  ['',': '],
  ['s','"http://monize-backend-service:3001"'],
  ['','\n- '],
  ['k','name'],
  ['',': PUBLIC_APP_URL\n  '],
  ['k','value'],
  ['',': '],
  ['s','"https://money.example.com"']
 ]],
 ['Local dev',[
  ['c','# backend'],
  ['','\ncd backend && npm install\ncreatedb monize\npsql monize < ../database/schema.sql\nnpm run start:dev\n\n'],
  ['c','# frontend, second terminal'],
  ['','\ncd frontend && npm install\ncp ../.env.example .env.local\nnpm run dev']
 ]],
 ['Demo stack',[
  ['c','# the same stack that powers demo.monize.net'],
  ['','\ndocker compose -f docker-compose.demo.yml up -d\n\n'],
  ['c','# seeded sample data, DEMO_MODE=true,'],
  ['','\n'],
  ['c','# and a full reset every day at 04:00 UTC']
 ]]
];

var STACK  = ['Next.js 16','React 19','TypeScript','Tailwind CSS','Zustand','Recharts','NestJS','TypeORM','PostgreSQL 16+','Passport.js','Node.js 24'];
var STACK2 = ['Docker Compose','Helm charts','Swagger / OpenAPI','Server-Sent Events','MCP server','SMTP notifications','Yahoo Finance prices','E2E test suite','ZAP security scans'];

var SECURITY = [
 ['🔑','SSO & local auth','OIDC with Authentik, Authelia or Pocket-ID, or bcrypt-hashed local credentials.'],
 ['📲','2FA that sticks','TOTP with backup codes and trusted devices, plus an optional force-2FA policy.'],
 ['🍪','Hardened sessions','JWTs in httpOnly cookies, refresh-token rotation and configurable “remember me”.'],
 ['🛡️','Locked down','Rate limiting, account lockout, breached-password checks, Helmet headers and CORS control.']
];

var FORMATS = [
 ['🗃️','.mny','A whole Microsoft Money file: accounts, splits, transfers, investments, price history, FX rates and scheduled bills.'],
 ['📄','QIF','Quicken and Microsoft Money exports, including a single multi-account file with categories and tags.'],
 ['🏦','OFX / QFX','Direct bank downloads, matched to existing payees automatically.'],
 ['📊','CSV','Anything else, with smart column auto-matching and saved presets per bank.']
];

var FAQ = [
 ['Is Monize free?','Yes. It is open source under the AGPL-3.0 licence — no subscription, no feature tiers and no paywall around your own data. You provide the server.'],
 ['Does Monize connect to my bank automatically?','No, and that is deliberate. Monize is import-driven: CSV, OFX/QFX, QIF or a full Microsoft Money file. Nothing hands your banking credentials to a third-party aggregator.'],
 ['Where does my financial data live?','On whatever machine you run it on, in your own PostgreSQL database. There is no Monize cloud and no telemetry.'],
 ['Do I have to use the AI features?','Not at all — they are off until you add a provider. If you do want them, you can point Monize at a local Ollama model so nothing leaves your network, and only the data needed for a specific question is ever sent.'],
 ['Can I really migrate 30 years of Microsoft Money?','That is the reason it exists. The author imported 30+ years of .mny data and reconciled every balance against the original file with no discrepancies. The documentation has a step-by-step guide.'],
 ['Will it work on my phone?','Yes. The interface is responsive and installable as a Progressive Web App, so it gets its own window and home-screen icon on desktop and mobile.'],
 ['Who wrote it, and should I worry?','It was written almost entirely with AI assistance by a self-described non-programmer — the project says so up front. It has been through repeated security audits, NPM audits and ZAP scans, and supports 2FA and OIDC, but read the caution note in the README and make your own call.'],
 ['Can my partner or accountant see my accounts?','Yes, with scoped shared access. You can also share a single account jointly so it shows up natively in their own account list, and transfer between your accounts and theirs.']
];

var GALCATS = [['all','All'],['dashboard','Dashboard'],['money','Day to day'],['inv','Investing'],['plan','Planning'],['ai','AI'],['import','Migration'],['admin','Security']];
var GALLERY = [
 ['dashboard','dashboard-overview','Dashboard overview'],['dashboard','dashboard-net-worth','Net worth, 12 months'],
 ['dashboard','dashboard-expenses-pie','Expenses by category'],['dashboard','dashboard-income-expenses-bar','Income vs expenses'],
 ['dashboard','dashboard-upcoming-bills','Upcoming bills & deposits'],
 ['money','transactions-page','Transaction register'],['money','transaction-form','New transaction'],
 ['money','split-transaction','Split transaction'],['money','transaction-filters','Transaction filters'],
 ['money','accounts-list','All accounts'],['money','create-account-form','New account'],['money','account-reconciliation','Reconciliation'],
 ['money','tags-page','Tags'],['money','currencies-page','Currencies'],
 ['inv','investments-page','Portfolio summary'],['inv','portfolio-holdings','Holdings by account'],
 ['inv','securities-list','Securities'],['inv','investment-transaction-form','Investment transaction'],
 ['plan','bills-deposits-page','Bills & deposits'],['plan','cash-flow-forecast','Cash-flow forecast'],
 ['plan','bills-list','Every schedule'],['plan','scheduled-transaction-form','New schedule'],
 ['plan','reports-page','Report catalogue'],['plan','report-net-worth','Net worth report'],
 ['plan','report-spending-category','Spending by category'],['plan','report-income-expenses','Income vs expenses'],
 ['plan','custom-report-builder','Custom report builder'],['plan','report-chart-table','Chart or table'],
 ['ai','ai-chat','AI assistant'],['ai','ai-settings','AI provider settings'],
 ['import','import-upload-step','Import: upload'],['import','import-select-account','Import: choose account'],
 ['import','import-map-accounts','Import: map accounts'],['import','import-map-categories','Import: map categories'],
 ['import','import-map-securities','Import: map securities'],['import','import-review-step','Import: review'],
 ['import','import-complete-step','Import: reconciled'],
 ['admin','settings-page','Settings'],['admin','2fa-setup','Two-factor setup'],
 ['admin','trusted-devices','Trusted devices'],['admin','oidc-login','OIDC sign-in'],
 ['admin','admin-user-management','User administration']
];

var MARQUEE = ['Chequing','Savings','Credit cards','Lines of credit','Loans','Mortgages','Brokerage','Investment cash',
 'Assets','Cash','Multi-currency','QIF import','OFX / QFX','Microsoft Money .mny','Split transactions','Tags',
 'Recurring bills','Cash-flow forecast','Budget wizard','Net worth history','Monte Carlo','MCP server','OIDC SSO','TOTP 2FA','Encrypted backups','PWA'];

/* ---------- names that are allowed to become URLs ----------
   A screenshot name reaches this file twice: once from the content model above,
   and once back out of the DOM, because `data-shot` is where the name is parked
   between a paint and the click that opens the lightbox. An attribute the page
   reads is text the page cannot vouch for -- whoever wrote it, the read cannot
   tell -- and the five places that used to concatenate one straight into an
   `img.src` turned any attribute on the page into a request to a URL the site
   never chose (CWE-79/CWE-601, "DOM text reinterpreted as HTML").

   So a name is *looked up*, never trusted. What comes back is the literal from
   the content model rather than the string that was read, which is the same
   move TAGS makes for tag names: an entry that is not in the vocabulary
   produces nothing at all instead of producing something unexpected. Adding a
   screenshot means adding it to TOUR or GALLERY, which is where the site is
   edited anyway.

   Concatenation is what the resolvers are for. Nothing else in this file may
   build a URL out of a name -- `frontend/src/test/website-dom-safety.test.ts`
   fails on a `.src` assignment containing a `+`. */
var SHOTS = (function(){
  var names=Object.create(null), i, j, parts;
  function put(n){ if(n) names[n]=n; }
  for(i=0;i<TOUR.length;i++){
    parts = TOUR[i].shots ? TOUR[i].shots.split('|') : [];
    for(j=0;j<parts.length;j++) put(parts[j].split(':')[0]);
  }
  for(i=0;i<GALLERY.length;i++) put(GALLERY[i][1]);
  return names;
})();
/* The header and footer logos fall back to the copy in the app repo. The key
   is what `data-fallback` carries in the markup, not the path -- a path in an
   attribute is a path the page would follow wherever it pointed. */
var REPO_FILES = (function(){
  var m=Object.create(null); m.logo='frontend/public/icons/monize-logo.svg'; return m;
})();
/* Each returns null for anything outside its vocabulary. Callers treat null as
   "there is nothing to load" -- they never assign it to a src, because
   `src = null` is a request for the URL "null". */
function shotName(v){ return (typeof v==='string' && SHOTS[v]) || null; }
function shotUrl(base,v){ var n=shotName(v); return n && base+n+'.png'; }
function repoUrl(v){
  var p = (typeof v==='string' && REPO_FILES[v]) || null;
  return p && REPORAW+p;
}

$$('img[data-shot]').forEach(wireShot);

var BUDGET=[
 {m:'April 2026',style:'Zero-Based \u00b7 Monthly',spent:3450.37,total:6123.50,days:26,safe:235.52,
  rows:[['Rent/Mortgage',2370,2370],['Groceries',612.18,700],['Restaurants',210.95,180],['Fuel',208.27,260],['Travel',0,300],['Streaming Services',48.97,60]]},
 {m:'March 2026',style:'Rollover \u00b7 Monthly',spent:4183.07,total:5950.00,days:0,safe:0,
  rows:[['Rent/Mortgage',2370,2370],['Groceries',744.02,700],['Restaurants',162.40,180],['Fuel',188.11,240],['Travel',669.57,600],['Streaming Services',48.97,60]]}
];

window.__MZ = {LOCAL:LOCAL,WIKI:WIKI,REPORAW:REPORAW,DEMO:DEMO,GH:GH,$:$,$$:$$,el:el,clear:clear,fill:fill,rich:rich,rnd:rnd,wireShot:wireShot,shot:shot,full:full,shotName:shotName,shotUrl:shotUrl,repoUrl:repoUrl,
 FCATS:FCATS,FEATURES:FEATURES,TOUR:TOUR,REPORTS:REPORTS,RCOLOR:RCOLOR,QA:QA,CODE:CODE,
 STACK:STACK,STACK2:STACK2,SECURITY:SECURITY,FORMATS:FORMATS,FAQ:FAQ,GALCATS:GALCATS,GALLERY:GALLERY,MARQUEE:MARQUEE,BUDGET:BUDGET};
})();

})();
(function(){

/* ---------- behaviour ---------- */
(function(){
'use strict';
var M=window.__MZ, $=M.$, $$=M.$$, el=M.el, shot=M.shot, clear=M.clear, fill=M.fill, rich=M.rich, rnd=M.rnd;

/* theme */
var root=document.documentElement, saved=null;
try{ saved=localStorage.getItem('mz-theme'); }catch(e){}
if(saved) root.setAttribute('data-theme',saved);
else if(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) root.setAttribute('data-theme','light');
function paintTheme(){ var t=root.getAttribute('data-theme')==='light'; var b=$('#theme'); if(b) b.textContent=t?'☀':'☾'; }
paintTheme();
$('#theme').addEventListener('click',function(){
  var next = root.getAttribute('data-theme')==='light' ? 'dark' : 'light';
  root.setAttribute('data-theme',next); paintTheme();
  try{ localStorage.setItem('mz-theme',next); }catch(e){}
});

/* mobile nav */
$('#burger').addEventListener('click',function(){ $('#nav').classList.toggle('open'); });
$$('#nav a').forEach(function(a){ a.addEventListener('click',function(){ $('#nav').classList.remove('open'); }); });

/* scroll progress, sticky header, active section */
var secs=$$('main section[id]');
function onScroll(){
  var h=document.documentElement, max=h.scrollHeight-h.clientHeight;
  $('#prog').style.width = (max>0 ? (h.scrollTop/max)*100 : 0)+'%';
  $('#hdr').classList.toggle('stuck', h.scrollTop>8);
  var cur=null;
  secs.forEach(function(s){ if(s.getBoundingClientRect().top<=140) cur=s.id; });
  $$('#nav a').forEach(function(a){ a.classList.toggle('on', a.getAttribute('href')==='#'+cur); });
}
addEventListener('scroll',onScroll,{passive:true}); onScroll();

/* reveal on scroll */
var io = ('IntersectionObserver' in window) ? new IntersectionObserver(function(es){
  es.forEach(function(e){ if(e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); } });
},{threshold:.12}) : null;
function watch(n){ if(io) io.observe(n); else n.classList.add('in'); }
$$('.rv').forEach(watch);

/* ---------- lists that become a horizontal strip on a phone ----------
   The layout is .strip in styles.css. Two things follow from it that CSS cannot
   do, so every strip is registered here and repainted through rewind():

   - a scroll offset survives its contents being replaced, clamped to whatever
     the new content allows, so filtering twenty-eight cards down to two left the
     strip parked at the end of the two. Moving the strip's own scrollLeft cannot
     move anything but the strip, which is why this is not scrollIntoView.
   - nothing inside a feature card or a gallery figure is focusable, so on the
     browsers that do not make a scroller focusable by themselves the strip is
     unreachable from a keyboard: it takes a tab stop and a name while there is
     something to scroll to. Asking the element whether it can scroll, rather
     than repeating `640px` here, keeps the two files from disagreeing after a
     breakpoint moves. */
var strips=[];
function asStrip(node,label){ strips.push([node,label]); return node; }
function syncStrips(){
  strips.forEach(function(s){
    var n=s[0];
    if(n.scrollWidth-n.clientWidth>1){
      n.setAttribute('tabindex','0');
      n.setAttribute('role','group');
      n.setAttribute('aria-label',s[1]);
    }else{
      n.removeAttribute('tabindex');
      n.removeAttribute('role');
      n.removeAttribute('aria-label');
    }
  });
}
function rewind(node){ node.scrollLeft=0; syncStrips(); }
addEventListener('resize',syncStrips,{passive:true});

/* count-up stats */
var statsDone=false;
function runStats(){
  if(statsDone) return; statsDone=true;
  $$('#stats b').forEach(function(b){
    var to=+b.getAttribute('data-to'), sfx=b.getAttribute('data-suffix')||'', t0=performance.now(), dur=1100;
    (function step(t){
      var p=Math.min(1,(t-t0)/dur), e=1-Math.pow(1-p,3);
      b.textContent=Math.round(to*e)+sfx;
      if(p<1) requestAnimationFrame(step);
    })(t0);
  });
}
if(io){ var so=new IntersectionObserver(function(es){ if(es[0].isIntersecting){ runStats(); so.disconnect(); } },{threshold:.4}); so.observe($('#stats')); } else runStats();

/* marquee */
var mq=$('#marq'), mtxt=M.MARQUEE.concat(M.MARQUEE);
mtxt.forEach(function(t){ mq.appendChild(el('span',null,t)); });

/* live star count (best effort, falls back to the baked-in number) */
fetch('https://api.github.com/repos/kenlasko/monize').then(function(r){ return r.json(); }).then(function(d){
  if(d && d.stargazers_count) $('#stars').textContent='★ '+d.stargazers_count;
}).catch(function(){});

/* ---------- features ---------- */
var fchips=$('#fchips'), fgrid=asStrip($('#fgrid'),'Features — scroll sideways for more'), fcat='all';
M.FCATS.forEach(function(c){
  var b=el('button','chip'+(c[0]==='all'?' on':''),c[1]);
  b.addEventListener('click',function(){ fcat=c[0]; $$('.chip',fchips).forEach(function(x){x.classList.remove('on');}); b.classList.add('on'); paintF(); });
  fchips.appendChild(b);
});
function paintF(){
  clear(fgrid);
  M.FEATURES.filter(function(f){ return fcat==='all'||f[0]===fcat; }).forEach(function(f,i){
    var c=el('div','card rv', el('div','ico',f[1]), el('h3',null,f[2]), el('p',null,f[3]));
    c.style.transitionDelay=Math.min(i*35,420)+'ms';
    fgrid.appendChild(c); watch(c);
  });
  rewind(fgrid);
}
paintF();

/* ---------- interactive tour ---------- */
var rail=$('#rail'), thumbs=$('#thumbs'), ti=0, si=0, timer=null;
function shots(t){ return t.shots ? t.shots.split('|').map(function(p){ var k=p.split(':'); return {n:k[0],c:k[1]}; }) : []; }
M.TOUR.forEach(function(t,i){
  var b=el('button',i===0?'on':'', el('span','em',t.em), t.name);
  b.addEventListener('click',function(){ ti=i; si=0; paintTour(); });
  rail.appendChild(b);
});
var bmi=0;
function mny(v){ return '$'+v.toLocaleString('en-CA',{minimumFractionDigits:2,maximumFractionDigits:2}); }
/* A progress bar: the fill width is the only thing that varies, so it is set as
   a style property rather than interpolated into a style attribute string. */
function bar(cls,pct){
  var i=el('i'); i.style.width=Math.min(100,pct)+'%';
  return el('div','bar'+cls, i);
}
function kpi(label,value,cls){ return el('div', null, el('span',null,label), el('b',cls||null,value)); }
function budgetMock(){
  var b=M.BUDGET[bmi], pct=Math.round(b.spent/b.total*1000)/10;
  var sw=el('div','mock-sw', M.BUDGET.map(function(x,i){
    var btn=el('button', i===bmi?'on':'', x.m); btn.setAttribute('data-b',i); return btn;
  }));
  var head=el('div','mock-hd',
    el('div',null, el('h4',null,b.m+' Budget'), el('span','tiny',b.style+' \u00b7 Active')), sw);
  var kpis=el('div','mock-kpi',
    kpi('Spent',mny(b.spent)),
    kpi('Budget',mny(b.total)),
    kpi(b.days?'Safe to spend today':'Period closed',
        b.days?mny(b.safe):mny(b.total-b.spent)+' left','up'));
  var note=el('p','tiny', pct+'% of plan used'+(b.days?' \u00b7 '+b.days+' days left':''));
  note.style.margin='9px 0 4px';
  var rows=el('div','mock-rows', b.rows.map(function(r){
    var p=Math.round(r[1]/r[2]*100), over=r[1]>r[2];
    return el('div','mock-row',
      el('div',null, el('div','nm',r[0]), bar(over?' over':'',p)),
      el('div','amt'+(over?' down':''), mny(r[1]), el('small',null,'of '+mny(r[2])+' \u00b7 '+p+'%')));
  }));
  return el('div','mock', head, kpis, bar(b.spent>b.total?' over':'',pct), note, rows);
}
function paintTour(){
  var t=M.TOUR[ti], ss=shots(t), stBody=$('#stBody');
  $$('button',rail).forEach(function(b,i){ b.classList.toggle('on',i===ti); });
  $('#stTitle').textContent=t.name; $('#stDesc').textContent=t.desc; $('#stUrl').textContent='demo.monize.net'+t.url;
  clear(thumbs);
  if(!ss.length){
    stBody.classList.add('is-mock'); fill(stBody, budgetMock());
    $$('.mock-sw button',stBody).forEach(function(b){ b.addEventListener('click',function(){ bmi=+b.getAttribute('data-b'); paintTour(); }); });
    return;
  }
  stBody.classList.remove('is-mock');
  if(!$('#stImg')){ var ni=el('img'); ni.id='stImg'; ni.alt=''; fill(stBody, ni); }
  var im=$('#stImg');
  ss.forEach(function(s,i){
    var b=el('button',i===si?'on':''); b.appendChild(shot(s.n,s.c)); b.title=s.c;
    b.addEventListener('click',function(){ si=i; paintTour(); });
    thumbs.appendChild(b);
  });
  var cur=ss[si];
  im.setAttribute('data-shot',cur.n); im.removeAttribute('data-fb'); im.alt=cur.c; M.wireShot(im);
  im.style.animation='none'; void im.offsetWidth; im.style.animation='';
  centreThumb(si);
}
/* Scroll the filmstrip, never the page. scrollIntoView() moves every scrollable
   ancestor up to the document, so calling it from the first paint -- when the
   tour is still far below the fold -- drags the whole page down to the tour
   section, which is why the site used to open halfway down on a phone. Nudging
   the strip's own scrollLeft cannot move anything but the strip. */
function centreThumb(i){
  var th=thumbs.children[i]; if(!th) return;
  var t=th.getBoundingClientRect(), c=thumbs.getBoundingClientRect();
  var delta=(t.left+t.width/2)-(c.left+c.width/2);
  if(thumbs.scrollBy) thumbs.scrollBy({left:delta,behavior:'smooth'});
  else thumbs.scrollLeft+=delta;
}
paintTour();
$('#stBody').addEventListener('click',function(){ var ss=shots(M.TOUR[ti]); openLB(ss.map(function(s){return {n:s.n,c:M.TOUR[ti].name+' — '+s.c};}),si); });
function stepTour(d){ var ss=shots(M.TOUR[ti]); if(!ss.length){ ti=(ti+d+M.TOUR.length)%M.TOUR.length; si=0; } else si=(si+d+ss.length)%ss.length; paintTour(); }
$('#autoplay').addEventListener('click',function(){
  var b=this;
  if(timer){ clearInterval(timer); timer=null; b.textContent='⏵ Autoplay'; return; }
  b.textContent='⏸ Pause';
  timer=setInterval(function(){
    var ss=shots(M.TOUR[ti]);
    if(si>=ss.length-1){ si=0; ti=(ti+1)%M.TOUR.length; } else si++;
    paintTour();
  },2600);
});
addEventListener('keydown',function(e){
  if($('#lb').classList.contains('on')) return;
  if(e.key==='ArrowLeft') stepTour(-1); else if(e.key==='ArrowRight') stepTour(1);
});

/* ---------- reports explorer ---------- */
var reps=M.REPORTS.split(';').map(function(r){ var p=r.split('|'); return {n:p[0],c:p[1]}; });
var repGrid=asStrip($('#repGrid'),'Reports — scroll sideways for more');
var rcats=['All'].concat(Object.keys(M.RCOLOR)), rcat='All', rq='';
$('#repCount').textContent=reps.length;
rcats.forEach(function(c){
  var b=el('button','chip'+(c==='All'?' on':''),c+(c==='All'?' ('+reps.length+')':''));
  b.addEventListener('click',function(){ rcat=c; $$('.chip',$('#repChips')).forEach(function(x){x.classList.remove('on');}); b.classList.add('on'); paintR(); });
  $('#repChips').appendChild(b);
});
$('#repSearch').addEventListener('input',function(){ rq=this.value.toLowerCase().trim(); paintR(); });
function paintR(){
  var g=clear(repGrid);
  var list=reps.filter(function(r){
    return (rcat==='All'||r.c===rcat) && (!rq || r.n.toLowerCase().indexOf(rq)>-1 || r.c.toLowerCase().indexOf(rq)>-1);
  });
  list.forEach(function(r){
    var dot=el('span','d'); dot.style.background=M.RCOLOR[r.c];
    var n=el('div','rep', dot, el('span',null, el('b',null,r.n), el('small',null,r.c)));
    g.appendChild(n);
  });
  $('#repMsg').textContent = list.length ? 'Showing '+list.length+' of '+reps.length+' reports' : 'No report matches that — but the custom report builder will.';
  rewind(repGrid);
}
paintR();

/* ---------- AI chat ---------- */
var msgs=$('#msgs'), busy=false;
function push(cls,body){ var m=el('div','msg '+cls,body); msgs.appendChild(m); msgs.scrollTop=msgs.scrollHeight; return m; }
push('ai','Hi — I can answer questions about your spending, income, balances and net worth. Pick one below and I will run the numbers.');
M.QA.forEach(function(qa){
  var b=el('button',null,qa[0]);
  b.addEventListener('click',function(){
    if(busy) return; busy=true;
    push('me',qa[0]);
    var t=push('ai', el('span','typing', el('i'), el('i'), el('i')));
    setTimeout(function(){ fill(t, rich(qa[1])); msgs.scrollTop=msgs.scrollHeight; busy=false; },900);
  });
  $('#sugg').appendChild(b);
});

/* ---------- migration stepper ---------- */
var MSTEPS=[['Upload','import-upload-step','Drop in one or many files: .mny, QIF, OFX/QFX or CSV.'],
 ['Choose','import-select-account','Pick the destination account, or create it on the fly.'],
 ['Map','import-map-categories','Map accounts, categories and securities onto your own structure.'],
 ['Review','import-review-step','See exactly what will be created before anything is written.'],
 ['Reconcile','import-complete-step','Every balance is checked back against the source file.']];
var mi=0;
MSTEPS.forEach(function(s,i){
  var b=el('button',i===0?'on':'', el('span','n',i+1), s[0]);
  b.addEventListener('click',function(){ mi=i; paintM(); });
  $('#mSteps').appendChild(b);
});
function paintM(){
  var s=MSTEPS[mi];
  $$('button',$('#mSteps')).forEach(function(b,i){ b.classList.toggle('on',i===mi); });
  var im=$('#mImg'); im.setAttribute('data-shot',s[1]); im.removeAttribute('data-fb'); im.alt=s[2]; M.wireShot(im);
  $('#mCap').textContent=s[2];
}
paintM();
$('#mImg').addEventListener('click',function(){ openLB(MSTEPS.map(function(s){return {n:s[1],c:s[2]};}),mi); });
M.FORMATS.forEach(function(f){
  $('#fmtCards').appendChild(el('div','card', el('div','ico',f[0]), el('h3',null,f[1]), el('p',null,f[2])));
});

/* ---------- code tabs ---------- */
var ci=0;
M.CODE.forEach(function(c,i){
  var b=el('button',i===0?'on':'',c[0]);
  b.addEventListener('click',function(){ ci=i; paintC(); });
  $('#codeTabs').appendChild(b);
});
var cp=el('button','cp','⧉ Copy');
cp.addEventListener('click',function(){
  var txt=$('#codeBody').textContent;
  if(navigator.clipboard) navigator.clipboard.writeText(txt);
  cp.textContent='✓ Copied'; setTimeout(function(){ cp.textContent='⧉ Copy'; },1400);
});
$('#codeTabs').appendChild(cp);
function paintC(){
  $$('#codeTabs button:not(.cp)').forEach(function(b,i){ b.classList.toggle('on',i===ci); });
  fill($('#codeBody'), M.CODE[ci][1].map(function(tok){
    return tok[0] ? el('span',tok[0],tok[1]) : document.createTextNode(tok[1]);
  }));
}
paintC();
M.STACK.forEach(function(s){ $('#stack').appendChild(el('span',null,s)); });
M.STACK2.forEach(function(s){ $('#stack2').appendChild(el('span',null,s)); });
M.SECURITY.forEach(function(s){
  $('#secGrid').appendChild(el('div','card', el('div','ico',s[0]), el('h3',null,s[1]), el('p',null,s[2])));
});

/* ---------- FAQ ---------- */
M.FAQ.forEach(function(f){
  $('#faqList').appendChild(el('details',null, el('summary',null,f[0]), el('div','body',f[1])));
});

/* ---------- gallery ---------- */
var gal=asStrip($('#gal'),'Screenshots — scroll sideways for more'), gcat='all';
M.GALCATS.forEach(function(c){
  var b=el('button','chip'+(c[0]==='all'?' on':''),c[1]);
  b.addEventListener('click',function(){ gcat=c[0]; $$('.chip',$('#galChips')).forEach(function(x){x.classList.remove('on');}); b.classList.add('on'); paintG(); });
  $('#galChips').appendChild(b);
});
function paintG(){
  var g=clear(gal);
  var list=M.GALLERY.filter(function(x){ return gcat==='all'||x[0]===gcat; });
  list.forEach(function(x,i){
    var f=el('figure'); f.appendChild(shot(x[1],x[2])); f.appendChild(el('figcaption',null,x[2]));
    f.addEventListener('click',function(){ openLB(list.map(function(y){return {n:y[1],c:y[2]};}),i); });
    g.appendChild(f);
  });
  rewind(gal);
}
paintG();

/* also allow the loose figures elsewhere to open */
$$('figure.card img[data-shot], #reports figure img[data-shot]').forEach(function(im){
  im.parentNode.style.cursor='zoom-in';
  im.parentNode.addEventListener('click',function(){ openLB([{n:im.getAttribute('data-shot'),c:im.alt}],0); });
});

/* ---------- lightbox ---------- */
var lb=$('#lb'), lbImg=$('#lbImg'), lbCap=$('#lbCap'), set=[], idx=0;
/* Names are resolved on the way in, so everything paintLB() reaches for is a
   key from the content model and never the attribute a caller read it out of.
   A name outside the vocabulary has no picture behind it, so it is dropped
   rather than carried as far as an src; if that empties the set there is
   nothing to show and the lightbox does not open. */
function openLB(list,i){
  set = list.map(function(x){ return {n:M.shotName(x.n), c:x.c}; })
            .filter(function(x){ return x.n; });
  if(!set.length) return;
  idx = Math.min(Math.max(i,0), set.length-1);
  lb.classList.add('on'); document.body.style.overflow='hidden'; paintLB();
}
function closeLB(){ lb.classList.remove('on'); document.body.style.overflow=''; }
function paintLB(){
  var s=set[idx]; lbImg.src=M.full(s.n); lbImg.alt=s.c||'';
  lbImg.onerror=function(){ lbImg.onerror=null; lbImg.src=M.shotUrl(M.WIKI,s.n); };
  lbCap.textContent=(s.c||'')+'  ·  '+(idx+1)+' / '+set.length;
  var solo=set.length<2; $('#lbP').style.display=solo?'none':''; $('#lbN').style.display=solo?'none':'';
}
function moveLB(d){ idx=(idx+d+set.length)%set.length; paintLB(); }
$('#lbX').addEventListener('click',closeLB);
$('#lbP').addEventListener('click',function(e){ e.stopPropagation(); moveLB(-1); });
$('#lbN').addEventListener('click',function(e){ e.stopPropagation(); moveLB(1); });
lb.addEventListener('click',function(e){ if(e.target===lb) closeLB(); });
addEventListener('keydown',function(e){
  if(!lb.classList.contains('on')) return;
  if(e.key==='Escape') closeLB(); else if(e.key==='ArrowLeft') moveLB(-1); else if(e.key==='ArrowRight') moveLB(1);
});

/* ---------- logo fallback + easter egg ---------- */
$$('img[data-fallback]').forEach(function(im){
  im.addEventListener('error',function(){
    if(im.dataset.fb) return;
    var url=M.repoUrl(im.getAttribute('data-fallback'));
    if(!url) return;
    im.dataset.fb='1'; im.src=url;
  });
});
var taps=0, tapT=0;
$('#brand').addEventListener('click',function(e){
  var now=Date.now(); taps = (now-tapT<600) ? taps+1 : 1; tapT=now;
  if(taps>=3){ taps=0; e.preventDefault(); rain(); }
});
function rain(){
  var chars=['💰','🪙','💵','📈','🏦'];
  for(var i=0;i<26;i++){
    (function(i){
      setTimeout(function(){
        var c=el('div','coin',chars[i%chars.length]);
        c.style.left=rnd()*98+'vw';
        c.style.animationDuration=(2.2+rnd()*1.8)+'s';
        document.body.appendChild(c);
        setTimeout(function(){ c.remove(); },4200);
      },i*70);
    })(i);
  }
}
$('#yr').textContent=new Date().getFullYear();
})();

})();
