# Project rules
- Next.js + TypeScript strict. Main view "Opportunities" renders at "/"
  (replace starter app/page.tsx).
- No new dependencies without asking me first.
- Data: scripts/ingest.ts pulls the latest DIBBS RFQ posting date ->
  data/solicitations.json. App reads it via app/api/solicitations/route.ts.
- Sources:
  - Dates: https://www.dibbs.bsm.dla.mil/Rfq/RfqDates.aspx?category=issue
  - Day:   https://www.dibbs.bsm.dla.mil/RFQ/RfqRecs.aspx?category=issue&TypeSrch=dt&Value=MM-DD-YYYY
  - Row link: https://www.dibbs.bsm.dla.mil/rfq/rfqrec.aspx?sn=<SOL#>
- CORRECTNESS FIRST. Never invent or guess values. Missing = null, shown "—".
  If a fetch fails, say so.
- Tech docs: show only whether they exist + link to DIBBS. Never download
  or display documents.
- Before coding: plan, files, assumptions. After: list what you did NOT handle.