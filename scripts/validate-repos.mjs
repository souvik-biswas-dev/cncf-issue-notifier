// Checks every repo in config.json: missing, renamed, archived, inactive.
//   GITHUB_TOKEN=xxx npm run validate          -> report only
//   GITHUB_TOKEN=xxx npm run validate -- --fix -> also rewrites config.json
import fs from "node:fs";

const file = new URL("../config.json", import.meta.url);
const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
const FIX = process.argv.includes("--fix");
const headers = { Accept: "application/vnd.github+json", "User-Agent": "cncf-issue-notifier",
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
if (!process.env.GITHUB_TOKEN) console.warn("No GITHUB_TOKEN: only 60 requests/hour, the check may stop early.\n");

const keep = []; let bad = 0;
for (const repo of cfg.repos) {
  const res = await fetch(`https://api.github.com/repos/${repo}`, { headers });
  if (res.status === 403 || res.status === 429) { console.log(`?  ${repo}: rate limited, stopping (re-run later)`); keep.push(repo); continue; }
  if (res.status === 404) { console.log(`✗  ${repo}: NOT FOUND`); bad++; continue; }
  if (!res.ok) { console.log(`?  ${repo}: HTTP ${res.status}`); keep.push(repo); continue; }
  const r = await res.json();
  const days = Math.round((Date.now() - Date.parse(r.pushed_at)) / 86_400_000);
  if (r.archived) { console.log(`✗  ${repo}: ARCHIVED`); bad++; continue; }
  if (r.full_name.toLowerCase() !== repo.toLowerCase()) { console.log(`→  ${repo}: renamed to ${r.full_name}`); keep.push(r.full_name); bad++; continue; }
  if (days > 120) console.log(`!  ${repo}: no push for ${days} days (kept)`);
  keep.push(repo);
}
console.log(`\n${bad} problem repo(s) of ${cfg.repos.length}.`);
if (FIX) { cfg.repos = [...new Set(keep)]; fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n"); console.log("config.json updated."); }
else if (bad) console.log("Run again with --fix to clean config.json automatically.");
