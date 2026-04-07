# RFP Response Tool — Fiduciary Experts

## Project
- **Purpose:** AI-powered RFP response generator for investment advisory proposals
- **GitHub:** Fiduciary-Experts/rfp-response-tool
- **Branch:** master

## Architecture
- `index.html` — Main web UI (3 tabs: Knowledge Base, New RFP, Review & Edit)
- `styles.css` — Professional styling with Fiduciary Experts branding
- `app.js` — Frontend logic (document parsing, KB management, prompt generation, Word export)
- `assets/` — Logo and branding assets

## Key Details
- **AI:** Copy/paste workflow — tool generates prompts, user pastes into Claude chat, pastes response back (no API key needed)
- **Document Input:** Word (.docx) via mammoth.js, PDF via pdf.js — all client-side
- **Document Output:** Word (.docx) via docx.js — branded with FE logo, colors, formatting
- **Storage:** Knowledge base stored in localStorage with JSON export/import
- **Branding:** Primary #1a3a5c (dark blue), Accent #c8a951 (gold)

## Workflow
1. Upload past RFP responses → Copy generated prompt into Claude → Paste response back → Review/approve → Knowledge Base
2. Upload new RFP → Copy analysis prompt into Claude → Paste response → See prospect profile + questions
3. Generate responses via Claude prompt/paste → Review → Edit inline → Regenerate with feedback → Export to branded Word doc
