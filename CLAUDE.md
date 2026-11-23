# DIBBS Opportunities — v2 rules
## Goal
Production-shaped version: reliable ingest -> Postgres -> server-side
API (filters, cursor pagination, fuzzy search, caching) -> UI.
Deployed on Vercel; nightly ingest via GitHub Actions.

## Process (every slice)
1. Before code: explain the concept + 2 alternatives + tradeoffs in
   <=5 bullets. Wait for my OK.
2. Plan: files, schema/queries, assumptions.
3. Build ONE slice only. 4. Verify with real data and show evidence.
5. After: list what you did NOT handle.

## Rules
- CORRECTNESS FIRST. Never invent values. Missing = null.
- Ask before adding any dependency. Explain why it's needed.
- Secrets only in .env.local. Never commit secrets, cookies, or cURL dumps.
- Write SQL explicitly (no heavy ORM) so I can read and learn it.
- Tech docs: existence + DIBBS link only. Never display documents.
- Small commits. Never run a full 77-page ingest without asking.