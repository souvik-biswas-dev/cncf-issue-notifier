# CNCF Issue Notifier

Polls ~80 CNCF repos every 10 min, scores new issues against your skills, emails a digest via Gmail.

## Setup
1. Create a new GitHub repo, push this folder.
2. Gmail: enable 2-Step Verification, then create an App Password at https://myaccount.google.com/apppasswords
3. Repo → Settings → Secrets and variables → Actions → add:
   - `GMAIL_USER` = your gmail address
   - `GMAIL_APP_PASSWORD` = the 16-char app password
   - `GEMINI_API_KEY` = (optional) enables AI 1–10 suitability scoring
4. Actions tab → "CNCF issue notifier" → Run workflow to test.

## Tune
Edit `config.json`: `repos`, `skillKeywords`, `minScore`, `preferLabels`.
Local test: `npm i && DRY_RUN=1 GITHUB_TOKEN=xxx npm start`
