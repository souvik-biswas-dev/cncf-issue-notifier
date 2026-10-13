# CNCF Issue Notifier (v2)

Checks ~125 CNCF-ecosystem repos every 10 minutes, scores new/updated issues against your skills,
and e-mails you a digest. Runs free on GitHub Actions.

## Setup
1. Create a **public** GitHub repo and push this folder (public = unlimited free Actions minutes).
2. Gmail: turn on 2-Step Verification, then create an App Password: https://myaccount.google.com/apppasswords
3. Repo → Settings → Secrets and variables → Actions → add:
   - `GMAIL_USER`, `GMAIL_APP_PASSWORD`
   - `GEMINI_API_KEY` (optional, enables 1–10 AI suitability score)
4. Actions tab → **Validate repo list** → Run workflow. Read the log, then locally run
   `GITHUB_TOKEN=xxx npm run validate -- --fix` to drop archived/missing repos and fix renamed ones.
5. Actions tab → **CNCF issue notifier** → Run workflow to test.

## Pick your focus repos (important)
Put 2–3 repos in `focusRepos` in `config.json`. Their issues get a score bonus, a ⭐ in the e-mail,
and a lower AI threshold. Selection programs reward depth in one project, not breadth over 125.

## What changed in v2
- Does not lose issues when GitHub rate-limits you or a repo errors (window is kept and retried).
- ETag conditional requests: unchanged repos cost 0 rate limit, so 125+ repos is fine.
- Pages through busy repos (PR/bot noise no longer pushes real issues out of the feed).
- Remembers what it already judged → far fewer Gemini calls; `maxAiPerRun` protects free quota.
- Flags issues where someone already wrote "/assign" or "can I take this?".
- Shows issue age ("opened 4 min ago") - the first person to ask usually gets it.
- Removed noisy keywords (`go`, `node`, `web`, `ui`) that matched almost every Kubernetes issue.
- Removed archived/dead repos, added ~58 more (Headlamp, Meshery, Artifact Hub, k8sgpt, kagent, OTel, ...).
- Best-effort daily keep-alive so GitHub does not disable the schedule after 60 idle days.

## Tune
Edit `config.json`: `repos`, `focusRepos`, `skillKeywords`, `minScore`, `preferLabels`.
Local test: `npm i && DRY_RUN=1 GITHUB_TOKEN=xxx npm start`
