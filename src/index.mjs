import fs from "node:fs";
import nodemailer from "nodemailer";

const cfg = JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url), "utf8"));
const STATE_FILE = "state.json";
const DRY = !!process.env.DRY_RUN;
const { GITHUB_TOKEN, GMAIL_USER, GMAIL_APP_PASSWORD, GEMINI_API_KEY } = process.env;
const NOTIFY_TO = process.env.NOTIFY_TO || GMAIL_USER;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const PROFILE = `Full-stack developer, 2026 CS grad. Strong: Go (Gin), TypeScript/Node, React/Next.js/SvelteKit,
Docker, Kubernetes basics, GraphQL, WebSockets, Redis, Postgres, MongoDB, AWS, Cloudflare Workers, CI/webhooks.
Learning DevOps. Wants beginner-to-intermediate issues he can finish in a few days.`;

const gh = (path) =>
  fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "cncf-issue-notifier",
      ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
    },
  });

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}

async function fetchNewIssues(repo, sinceMs) {
  const since = new Date(sinceMs).toISOString();
  const res = await gh(`/repos/${repo}/issues?state=open&sort=updated&direction=desc&per_page=50&since=${since}`);
  if (!res.ok) { console.warn(`! ${repo}: HTTP ${res.status}`); return []; }
  const items = await res.json();
  const oldest = Date.now() - cfg.maxIssueAgeDays * 86_400_000;
  return items
    .filter((i) => !i.pull_request && Date.parse(i.created_at) > oldest && i.comments <= cfg.maxComments)
    .map((i) => ({ ...i, repo }));
}

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
  const wordRe = (k) => new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
  let tHits = 0, bHits = 0;
  for (const k of cfg.skillKeywords) {
    const re = wordRe(k);
    if (re.test(title)) { tHits++; why.push(`title: ${k}`); }
    else if (re.test(body)) bHits++;
  }
  s += Math.min(tHits * 2, 4) + Math.min(bHits, 3);
  return { score: s, why, beginner };
}

async function geminiRate(issue) {
  if (!GEMINI_API_KEY) return null;
  const prompt = `Candidate profile:\n${PROFILE}\n\nGitHub issue in ${issue.repo}:\nTitle: ${issue.title}\nLabels: ${issue.labels.map((l) => l.name).join(", ")}\nBody:\n${(issue.body || "").slice(0, 2500)}\n\nRate 1-10 how suitable this issue is for this candidate to pick up as an open-source contribution. Reply ONLY JSON: {"score":number,"summary":"one sentence"}`;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json" } }) }
    );
    if (!res.ok) return null;
    const j = await res.json();
    return JSON.parse(j.candidates[0].content.parts[0].text);
  } catch { return null; }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function renderEmail(matches) {
  const rows = matches.map((m) => `
    <div style="border:1px solid #ddd;border-radius:8px;padding:12px;margin:10px 0;font-family:sans-serif">
      <div style="color:#666;font-size:12px">${esc(m.repo)} · #${m.number} · match ${m.finalScore}</div>
      <a href="${m.html_url}" style="font-size:16px;font-weight:600;color:#0969da;text-decoration:none">${esc(m.title)}</a>
      <div style="margin:6px 0">${m.labels.map((l) => `<span style="background:#eef;border-radius:10px;padding:2px 8px;font-size:11px;margin-right:4px">${esc(l.name)}</span>`).join("")}</div>
      ${m.ai ? `<div style="font-size:13px;color:#333">🤖 ${esc(m.ai.summary)} (AI: ${m.ai.score}/10)</div>` : `<div style="font-size:12px;color:#777">${esc(m.why.slice(0, 5).join(", "))}</div>`}
    </div>`).join("");
  return `<div>${rows}<p style="font-size:11px;color:#999">Comment "/assign" or ask the maintainers before starting.</p></div>`;
}

async function main() {
  const state = loadState();
  const now = Date.now();
  const sinceMs = state.lastRun ? state.lastRun - 60_000 : now - cfg.firstRunLookbackMinutes * 60_000; // 1 min overlap
  const seen = new Set(state.seen || []);

  const all = [];
  const BATCH = 8;
  for (let i = 0; i < cfg.repos.length; i += BATCH) {
    const chunk = cfg.repos.slice(i, i + BATCH);
    (await Promise.all(chunk.map((r) => fetchNewIssues(r, sinceMs)))).forEach((x) => all.push(...x));
  }
  console.log(`Fetched ${all.length} new issues from ${cfg.repos.length} repos`);

  const matches = [];
  for (const issue of all) {
    if (seen.has(issue.id)) continue;
    const r = score(issue);
    if (!r || r.score < cfg.minScore) continue;
    const ai = await geminiRate(issue);
    if (r.beginner) { if (ai && ai.score < 5) continue; }
    else if (!ai || ai.score < cfg.aiOnlyMinScore) continue; // no beginner label: need strong AI approval
    seen.add(issue.id);
    matches.push({ ...issue, why: r.why, ai, finalScore: ai ? ai.score : r.score });
  }
  matches.sort((a, b) => b.finalScore - a.finalScore);
  console.log(`${matches.length} matching issues`);

  if (matches.length) {
    const subject = `[CNCF] ${matches.length} new issue${matches.length > 1 ? "s" : ""} for you — ${matches[0].repo}: ${matches[0].title}`.slice(0, 150);
    if (DRY || !GMAIL_USER || !GMAIL_APP_PASSWORD) {
      console.log(subject); matches.forEach((m) => console.log(` - ${m.html_url} (${m.finalScore})`));
    } else {
      const tx = nodemailer.createTransport({ service: "gmail", auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } });
      await tx.sendMail({ from: `CNCF Issue Bot <${GMAIL_USER}>`, to: NOTIFY_TO, subject, html: renderEmail(matches) });
      console.log("Email sent");
    }
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastRun: now, seen: [...seen].slice(-3000) }));
}

main().catch((e) => { console.error(e); process.exit(1); });
