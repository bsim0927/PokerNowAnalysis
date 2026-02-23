# PokerNow Analysis

Analytics dashboard for PokerNow hand history data stored in Supabase.

## Prerequisites

- Node.js 20.6 or later
- Access to the Supabase project (URL + service role key)

## Setup

```bash
git clone https://github.com/bsim0927/PokerNowAnalysis
cd PokerNowAnalysis
npm install
```

Copy the environment and config templates:

```bash
cp .env.example .env
cp config.example.js config.js
```

Edit `.env` and fill in your Supabase credentials:

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
```

`config.js` can be left as-is — it points the dashboard at `http://localhost:3456`, which is where the API server runs by default.

## Running

```bash
npm run build
npm start
```

Then open **http://localhost:3457** in your browser.

| Port | What it serves |
|------|---------------|
| 3456 | API server (Supabase queries + PokerNow game lookup) |
| 3457 | Dashboard (`poker_dashboard.html`) |

## Development (no build step)

```bash
npm run dev
```

Uses `tsx` to run TypeScript directly. Requires Node 20.6+ for `--env-file`.
