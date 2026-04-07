# RFP Response Tool — Fiduciary Experts

## Project
- **Purpose:** AI-powered RFP response generator for investment advisory proposals
- **GitHub:** Fiduciary-Experts/rfp-response-tool
- **Branch:** master

## Architecture
- `index.html` — Main web UI (3 tabs: Knowledge Base, New RFP, Review & Edit)
- `styles.css` — Professional styling with Fiduciary Experts branding
- `app.js` — Frontend logic (document parsing, KB management, response generation, Word export)
- `api/claude.js` — Vercel serverless function proxying Claude API calls
- `assets/` — Logo and branding assets
- `knowledge-base/` — Placeholder for future server-side KB storage

## Key Details
- **AI:** Claude API (claude-sonnet-4-20250514) via Vercel serverless proxy
- **Document Input:** Word (.docx) via mammoth.js, PDF via pdf.js — all client-side
- **Document Output:** Word (.docx) via docx.js — branded with FE logo, colors, formatting
- **Storage:** Knowledge base stored in localStorage with JSON export/import
- **Branding:** Primary #1a3a5c (dark blue), Accent #c8a951 (gold)

## Workflow
1. Upload past RFP responses → AI extracts Q&A pairs → Review/approve → Knowledge Base
2. Upload new RFP → AI analyzes prospect profile + questions → Generate tailored responses
3. Review responses → Edit inline → Regenerate with feedback → Export to branded Word doc

## Environment Variables (Vercel)
- `ANTHROPIC_API_KEY` — Required for Claude API access
