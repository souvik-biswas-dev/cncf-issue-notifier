import fs from "node:fs";
import nodemailer from "nodemailer";

const cfg = JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url), "utf8"));
const STATE_FILE = process.env.STATE_FILE || "state.json";
const API = process.env.GITHUB_API || "https://api.github.com";
const DRY = !!process.env.DRY_RUN;
const { GITHUB_TOKEN, GMAIL_USER, GMAIL_APP_PASSWORD, GEMINI_API_KEY } = process.env;
const NOTIFY_TO = process.env.NOTIFY_TO || GMAIL_USER;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const MAX_LOOKBACK_MS = 6 * 3600_000; // never look back further than 6h after a failed run
const focusSet = new Set((cfg.focusRepos || []).map((r) => r.toLowerCase()));

const PROFILE = `Full-stack developer, 2026 CS grad. Strong: Go (Gin), TypeScript/Node, React/Next.js/SvelteKit,
Docker, Kubernetes basics, GraphQL, WebSockets, Redis, Postgres, MongoDB, AWS, Cloudflare Workers, CI/webhooks.
Learning DevOps. Wants beginner-to-intermediate issues he can finish in a few days.`;

// ---------- GitHub helpers ----------
let rateRemaining = Infinity;
async function gh(path, extra = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "cncf-issue-notifier",
      ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
      ...extra,
    },
  });
  const rem = res.headers.get("x-ratelimit-remaining");
  if (rem !== null) rateRemaining = Math.min(rateRemaining, Number(rem));
  return res;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}

// Returns { kind: "ok" | "same" | "gone" | "error", issues?, etag? }
// - "same":  nothing changed since last run (HTTP 304, free: does not use rate limit)
// - "gone":  repo renamed/deleted/blocked -> permanent, skip it (does not block the run)
// - "error": rate limit / network / 5xx -> transient, the run is marked incomplete
async function fetchRepo(repo, sinceMs, oldEtag) {
  const oldest = Date.now() - cfg.maxIssueAgeDays * 86_400_000;
  const out = [];
  let etag = null;
  try {
    for (let page = 1; page <= 3; page++) {
      const headers = page === 1 && oldEtag ? { "If-None-Match": oldEtag } : {};
      const res = await gh(`/repos/${repo}/issues?state=open&sort=updated&direction=desc&per_page=100&page=${page}`, headers);
      if (res.status === 304) return { kind: "same" };
      if ([404, 410, 451].includes(res.status)) { console.warn(`! ${repo}: HTTP ${res.status} (missing/renamed/blocked) - run "npm run validate"`); return { kind: "gone" }; }
      if (!res.ok) { console.warn(`! ${repo}: HTTP ${res.status}`); return { kind: "error" }; }
      if (page === 1) etag = res.headers.get("etag");
      const items = await res.json();
      for (const i of items) {
        if (i.pull_request) continue;
        if (Date.parse(i.updated_at) < sinceMs) continue;
        if (Date.parse(i.created_at) <= oldest || i.comments > cfg.maxComments) continue;
        out.push({ ...i, repo });
      }
      // PRs and bot activity are in this feed too, so busy repos need paging.
      const last = items[items.length - 1];
      if (items.length < 100 || !last || Date.parse(last.updated_at) < sinceMs) break;
    }
    return { kind: "ok", issues: out, etag };
  } catch (e) {
    console.warn(`! ${repo}: ${e.message}`);
    return { kind: "error" };
  }
}

// ---------- scoring ----------
const wordRe = (k) => new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
const skillRes = cfg.skillKeywords.map((k) => [k, wordRe(k)]);

function score(issue) {
  const labels = issue.labels.map((l) => (typeof l === "string" ? l : l.name).toLowerCase());
  if (labels.some((l) => cfg.excludeLabels.includes(l))) return null;
  if (issue.assignee || (issue.assignees && issue.assignees.length)) return null;
  let s = 0; const why = [];
  const beginner = labels.some((l) => cfg.beginnerLabels.includes(l));
  for (const l of labels) {
    const w = cfg.preferLabels[l];
    if (w) { s += w; why.push(`label: ${l}`); }
  }
  const title = issue.title.toLowerCase();
  const body = (issue.body || "").toLowerCase().slice(0, 3000);
  let tHits = 0, bHits = 0;
  for (const [k, re] of skillRes) {
    if (re.test(title)) { tHits++; why.push(`title: ${k}`); }
    else if (re.test(body)) bHits++;
  }
  s += Math.min(tHits * 2, 4) + Math.min(bHits, 3);
  const focus = focusSet.has(issue.repo.toLowerCase());
  if (focus) { s += 3; why.unshift("focus repo"); }
  return { score: s, why, beginner, focus };
}

// Did somebody already say "I'll take this" / "/assign"?  (only called for matches)
const CLAIM_RE = /\/assign\b|\/take\b|\bi('d| would)? (like|love|want) to (work|take|pick|fix|contribute)|\bi('ll| will| can) (take|work|pick|fix|handle|send)|\bworking on (this|it)\b|\bcan i (take|work|pick|be assigned|have)|\bplease assign\b/i;
const BOT_RE = /(\[bot\]|bot|robot)$/i;
async function looksClaimed(issue) {
  if (!cfg.claimCheck || !issue.comments) return false;
  try {
    const res = await gh(`/repos/${issue.repo}/issues/${issue.number}/comments?per_page=15`);
    if (!res.ok) return false;
    const cs = await res.json();
    return cs.some((c) => !BOT_RE.test(c.user?.login || "") && CLAIM_RE.test(c.body || ""));
  } catch { return false; }
}

// ---------- Gemini ----------
// returns: object on success, null on failure (caller decides what to do)
let geminiDown = false;   // set when Gemini fails permanently (404/400/403): stop calling it this run
async function geminiRate(issue) {
  if (geminiDown) return null;
  const prompt = `Candidate profile:\n${PROFILE}\n\nGitHub issue in ${issue.repo}:\nTitle: ${issue.title}\nLabels: ${issue.labels.map((l) => l.name).join(", ")}\nBody:\n${(issue.body || "").slice(0, 2500)}\n\nRate 1-10 how suitable this issue is for this candidate to pick up as an open-source contribution (clear scope, finishable in a few days, matches skills). Reply ONLY JSON: {"score":number,"summary":"one sentence"}`;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json" } }) }
    );
    if (!res.ok) {
      console.warn(`! Gemini HTTP ${res.status}${res.status === 404 ? ` - model "${GEMINI_MODEL}" is retired or wrong; set GEMINI_MODEL` : ""}`);
      if ([400, 403, 404].includes(res.status)) geminiDown = true;
      return null;
    }
    const j = await res.json();
    const text = (j.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
    const r = JSON.parse(text);
    return typeof r.score === "number" ? r : null;
  } catch { return null; }
}

// ---------- email ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ago = (iso) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 90 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

function renderEmail(matches) {
  const rows = matches.map((m) => `
    <div style="border:1px solid ${m.focus ? "#d4a017" : "#ddd"};border-radius:8px;padding:12px;margin:10px 0;font-family:sans-serif">
      <div style="color:#666;font-size:12px">${m.focus ? "⭐ FOCUS · " : ""}${esc(m.repo)} · #${m.number} · opened ${ago(m.created_at)} · match ${m.finalScore}</div>
      <a href="${m.html_url}" style="font-size:16px;font-weight:600;color:#0969da;text-decoration:none">${esc(m.title)}</a>
      <div style="margin:6px 0">${m.labels.map((l) => `<span style="background:#eef;border-radius:10px;padding:2px 8px;font-size:11px;margin-right:4px">${esc(l.name)}</span>`).join("")}</div>
      ${m.claimed ? `<div style="font-size:12px;color:#b45309">⚠ Someone may have already asked to work on this - read the comments first.</div>` : ""}
      ${m.ai ? `<div style="font-size:13px;color:#333">🤖 ${esc(m.ai.summary)} (AI: ${m.ai.score}/10)</div>` : `<div style="font-size:12px;color:#777">${esc(m.why.slice(0, 5).join(", "))}</div>`}
    </div>`).join("");
  return `<div>${rows}<p style="font-size:11px;color:#999">Read CONTRIBUTING.md first. Most CNCF repos need a DCO sign-off (<code>git commit -s</code>) or a CLA. Ask to be assigned (or comment "/assign") before you start.</p></div>`;
}

// ---------- main ----------
async function main() {
  const state = loadState();
  const now = Date.now();
  const sinceMs = Math.max(state.lastRun ? state.lastRun - 60_000 : now - cfg.firstRunLookbackMinutes * 60_000, now - MAX_LOOKBACK_MS);
  const seen = new Set(state.seen || []);
  const judged = state.judged || {};          // issue id -> updated_at we already judged
  const oldEtags = state.etags || {};
  const newEtags = { ...oldEtags };
  let incomplete = false;

  const all = [];
  const BATCH = 8;
  for (let i = 0; i < cfg.repos.length; i += BATCH) {
    if (rateRemaining < 30) { console.warn(`! GitHub rate limit nearly used up (${rateRemaining} left), stopping early`); incomplete = true; break; }
    const chunk = cfg.repos.slice(i, i + BATCH);
    const results = await Promise.all(chunk.map((r) => fetchRepo(r, sinceMs, oldEtags[r])));
    results.forEach((r, idx) => {
      if (r.kind === "ok") { all.push(...r.issues); if (r.etag) newEtags[chunk[idx]] = r.etag; }
      else if (r.kind === "error") incomplete = true;
    });
  }
  console.log(`Fetched ${all.length} updated issues from ${cfg.repos.length} repos (rate limit left: ${rateRemaining})`);

  const matches = [];
  let aiCalls = 0;
  for (const issue of all) {
    if (seen.has(issue.id) || judged[issue.id] === issue.updated_at) continue;
    const r = score(issue);
    if (!r || r.score < cfg.minScore) { judged[issue.id] = issue.updated_at; continue; }

    let ai = null, aiFailed = false;
    if (GEMINI_API_KEY) {
      if (aiCalls >= cfg.maxAiPerRun) aiFailed = true;
      else { aiCalls++; ai = await geminiRate(issue); if (!ai) aiFailed = true; }
    }
    const aiBar = r.focus ? cfg.aiOnlyMinScore - 2 : cfg.aiOnlyMinScore;
    if (r.beginner) { if (ai && ai.score < 5) { judged[issue.id] = issue.updated_at; continue; } }
    else if (!ai || ai.score < aiBar) {
      if (GEMINI_API_KEY && aiFailed && !geminiDown) incomplete = true;   // temporary Gemini hiccup: look again next run
      else judged[issue.id] = issue.updated_at;
      continue;
    }
    const claimed = await looksClaimed(issue);
    seen.add(issue.id);
    const base = ai ? ai.score : r.score;
    matches.push({ ...issue, why: r.why, ai, focus: r.focus, claimed, finalScore: base, rank: base + (r.focus ? 2 : 0) - (claimed ? 3 : 0) });
  }
  matches.sort((a, b) => b.rank - a.rank);
  console.log(`${matches.length} matching issues${incomplete ? " (run incomplete - will re-check window next time)" : ""}`);

  if (matches.length) {
    const subject = `[CNCF] ${matches.length} new issue${matches.length > 1 ? "s" : ""} for you - ${matches[0].repo}: ${matches[0].title}`.slice(0, 150);
    if (DRY || !GMAIL_USER || !GMAIL_APP_PASSWORD) {
      console.log(subject); matches.forEach((m) => console.log(` - ${m.html_url} (${m.finalScore})${m.focus ? " [focus]" : ""}${m.claimed ? " [maybe claimed]" : ""}`));
    } else {
      const tx = nodemailer.createTransport({ service: "gmail", auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } });
      await tx.sendMail({ from: `CNCF Issue Bot <${GMAIL_USER}>`, to: NOTIFY_TO, subject, html: renderEmail(matches) });
      console.log("Email sent");
    }
  }

  // If anything went wrong, keep the old window and old ETags so nothing is silently lost.
  const keep = Object.entries(judged).slice(-4000);
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    lastRun: incomplete ? (state.lastRun ?? sinceMs) : now,
    seen: [...seen].slice(-3000),
    judged: Object.fromEntries(keep),
    etags: incomplete ? oldEtags : newEtags,
  }));
}

main().catch((e) => { console.error(e); process.exit(1); });
