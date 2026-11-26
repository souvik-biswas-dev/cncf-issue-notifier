# CNCF Issue Notifier (focused v3)

A small GitHub Actions service that watches **10 selected repositories** and emails you every newly opened issue it sees. It polls every **5 minutes** (GitHub Actions' minimum scheduled interval), uses the built-in `GITHUB_TOKEN`, and persists deduplication state through the Actions cache.

> **Timing:** this is polling, not a GitHub webhook. GitHub may delay scheduled workflow runs, so an email is not guaranteed to arrive within exactly five minutes. Use **Actions → CNCF issue notifier → Run workflow** for an immediate manual check.

## Repositories monitored

| Area | GitHub repository |
|---|---|
| Kubernetes SIG CLI | [`kubernetes/kubectl`](https://github.com/kubernetes/kubectl) |
| OpenTelemetry Collector | [`open-telemetry/opentelemetry-collector`](https://github.com/open-telemetry/opentelemetry-collector) |
| Flux | [`fluxcd/flux2`](https://github.com/fluxcd/flux2) |
| Grafana | [`grafana/grafana`](https://github.com/grafana/grafana) |
| Kyverno | [`kyverno/kyverno`](https://github.com/kyverno/kyverno) |
| Prometheus | [`prometheus/prometheus`](https://github.com/prometheus/prometheus) |
| containerd | [`containerd/containerd`](https://github.com/containerd/containerd) |
| Helm | [`helm/helm`](https://github.com/helm/helm) |
| Envoy | [`envoyproxy/envoy`](https://github.com/envoyproxy/envoy) |
| Istio | [`istio/istio`](https://github.com/istio/istio) |

**Kubernetes SIG CLI note:** `kubernetes/kubectl` is the kubectl issue tracker/mirror. Its repository notes that code changes are submitted to `kubernetes/kubernetes`; the monitor watches the kubectl issue tracker specifically.

## What this version does

- Checks the ten repositories every five minutes.
- Emails every newly opened issue found in those repositories; it does not hide issues based on labels, assignees, comment count, keyword score, or AI score.
- Ignores edits to older issues, so an old issue becoming active does not look like a newly raised issue.
- Deduplicates notifications using `state.json`, restored/saved by GitHub Actions cache. Each run scans all issue states (including issues closed between polls), paginates back to the last successful checkpoint, and does not advance that checkpoint if a repository fetch or email delivery fails.
- Uses conditional ETag requests to reduce GitHub API usage when a repository has not changed. Catch-up scans can read up to 2,000 issue records per repository per run; if that safety limit is reached, the run retries the same time window instead of silently skipping it.
- Supports manual runs from the Actions tab.
- Keeps the previous optional scoring/AI code available if `notifyAllNewIssues` is later changed to `false`.

## Required GitHub setup

The workflow uses the automatic `GITHUB_TOKEN` for public GitHub API reads. For email notifications, configure these repository secrets:

1. Open your repository on GitHub → **Settings → Secrets and variables → Actions**.
2. Add `GMAIL_USER` (the Gmail address that sends and receives notifications).
3. Add `GMAIL_APP_PASSWORD` (a Google App Password, not your normal Gmail password).
4. Optional: add `NOTIFY_TO` as a repository variable or environment variable if you want a different destination. By default, mail goes to `GMAIL_USER`.

No Gemini API key is required in this focused configuration.

## Run locally on Ubuntu

Requires Node.js 20+ and npm.

```bash
npm ci
GITHUB_TOKEN="$(gh auth token)" DRY_RUN=1 npm start
```

`DRY_RUN=1` prints matching issue links instead of sending email. The local run writes `state.json` in the current directory; it is intentionally ignored by Git.

Validate the configured repository names:

```bash
GITHUB_TOKEN="$(gh auth token)" npm run validate
```

## Run on GitHub

- Go to **Actions → CNCF issue notifier → Run workflow** to test immediately.
- Scheduled checks run every five minutes on the repository's default branch.
- Check the workflow run logs if no email arrives. Confirm the Gmail secrets are present and that the workflow is enabled.

## Change the monitored repositories

Edit the `repos` array in `config.json`. Keep entries in `owner/repository` format. The `focusRepos` array only controls the focus marker in email; `notifyAllNewIssues: true` controls the all-new-issues behavior.

## Important limitations

- GitHub Actions schedules are best-effort and may start late, especially during periods of high GitHub load. Five minutes is the minimum supported schedule interval, not a delivery-time guarantee.
- The notifier queries `state=all`, so issues closed before the next poll can still be reported. It cannot report an issue that is deleted or made inaccessible before GitHub exposes it to the API.
- The first run checks the last 60 minutes (`firstRunLookbackMinutes`). Later runs use the saved last-successful-run timestamp with a two-minute overlap. After a longer outage, the notifier catches up from that checkpoint instead of truncating history to six hours.
- Do not commit Gmail credentials or personal access tokens. Use GitHub Actions secrets.


## Getting notifications faster than GitHub Actions

GitHub Actions cannot guarantee sub-five-minute starts. The code now catches up safely after delays, but it still runs only when the scheduled workflow starts. For faster and more predictable checks, run this same Node.js notifier as a continuously running process on an always-on VPS/server (or on your Ubuntu laptop while it is powered on and connected), using a systemd service/timer at a one-minute interval. A webhook cannot simply be installed on these upstream projects because you do not administer their repositories; their maintainers would have to configure a webhook for you.
