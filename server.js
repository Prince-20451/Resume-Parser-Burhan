// Resume Screener: add a JD, upload resumes -> parse -> score against the JD
// PASS = candidate created in Zoho Recruit, FAIL = logged only.
// Run: npm start  (Node 22+)
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const mammoth = require("mammoth");
const pdfParse = require("pdf-parse/lib/pdf-parse.js"); // avoids the debug-mode bug in index.js
const { DatabaseSync } = require("node:sqlite"); // built-in, no native build needed

if (fs.existsSync(path.join(__dirname, ".env"))) process.loadEnvFile(path.join(__dirname, ".env"));

const UPLOADS = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
fs.mkdirSync(UPLOADS, { recursive: true });
const ALLOWED = [".pdf", ".docx", ".txt"];
const PER_PAGE = 25;

/* ------------------------------ Database ------------------------------ */
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, "resumes.db"));
db.exec(`
CREATE TABLE IF NOT EXISTS resumes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uploaded_at TEXT, filename TEXT, stored_path TEXT,
  name TEXT, email TEXT, phone TEXT, skills TEXT, experience REAL,
  status TEXT,        -- PASS / FAIL
  reason TEXT,        -- reason for FAIL
  zoho_id TEXT, zoho_status TEXT  -- CREATED / DUPLICATE / ERROR: ...
);
CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY, value TEXT);
`);
// add JD-related columns to databases created by earlier versions
const have = db.prepare("PRAGMA table_info(resumes)").all().map((c) => c.name);
for (const [col, type] of [["position", "TEXT"], ["score", "INTEGER"], ["matched", "TEXT"], ["missing", "TEXT"]])
  if (!have.includes(col)) db.exec(`ALTER TABLE resumes ADD COLUMN ${col} ${type}`);

const getCfg = () => Object.fromEntries(db.prepare("SELECT key,value FROM config").all().map((r) => [r.key, r.value]));
const setCfg = (k, v) => db.prepare("INSERT OR REPLACE INTO config VALUES(?,?)").run(k, String(v));

function now() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ------------------------------- Parser ------------------------------- */
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE_RE = /(?:\+?91[\s-]?)?[6-9]\d{9}|\+?\d[\d\s-]{9,14}\d/;
const EXP_RE = /(\d+(?:\.\d+)?)\+?\s*(?:years?|yrs?)/gi;
const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

async function extractText(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".pdf") return (await pdfParse(fs.readFileSync(file))).text;
  if (ext === ".docx") return (await mammoth.extractRawText({ path: file })).value;
  if (ext === ".txt") return fs.readFileSync(file, "utf8");
  throw new Error("Only PDF, DOCX and TXT files are supported");
}

function guessName(text, email) {
  for (const raw of text.split(/\r?\n/).slice(0, 8)) {
    const line = raw.trim();
    if (line.length >= 2 && line.length <= 40 && /^[A-Za-z .'-]+$/.test(line) && !/resume|curriculum|vitae|cv/i.test(line))
      return titleCase(line);
  }
  return email ? titleCase(email.split("@")[0].replace(/\./g, " ")) : "Unknown";
}

async function parseResume(file) {
  const text = await extractText(file);
  const email = (text.match(EMAIL_RE) || [null])[0];
  const phoneM = text.match(PHONE_RE);
  const phone = phoneM ? phoneM[0].replace(/[^\d+]/g, "") : null;
  // treat the largest "N years" value (<= 40) as total experience
  const exps = [...text.matchAll(EXP_RE)].map((m) => parseFloat(m[1])).filter((n) => n <= 40);
  const name = guessName(text, email);
  const parts = name.split(/\s+/);
  return {
    text, name, email, phone,
    firstName: parts[0] || "",
    lastName: parts.slice(1).join(" "),
    experienceYears: exps.length ? Math.max(...exps) : 0,
  };
}

/* --------------------- JD keyword extraction + scoring --------------------- */
const STOP = new Set(`a an the and or but if then than so as of at by for from in into on onto to with without about above after
again all also am any are be been being both can could did do does doing done each either few more most other some such no nor not
only own same should so too very was were what when where which while who whom why will would you your we our us they their them it its
this that these those there here is has have had having i he she his her one two three etc via per upon over under between within across
among through during before since until against along around using use used uses make makes made well new able ability abilities
experience experiences experienced year years yrs yr work works working worked team teams strong good great excellent best
knowledge skills skill required require requires requirement requirements responsibilities responsibility role roles job jobs
candidate candidates company looking preferred plus including include includes must should need needs needed desired
description position positions opening openings hiring hire apply application time full part based related relevant
minimum maximum least years degree bachelor master graduate qualification qualifications education years looking join
opportunity opportunities benefits salary location india remote hybrid onsite environment culture ensure ensuring
develop developing development manage managing support supporting provide providing perform performing responsible
understanding understand proficient proficiency familiarity familiar hands demonstrated proven track record
communication written verbal excellent seeking similar like etc able highly high level levels various multiple
day days daily week weekly month monthly per etc end across including collaborate collaborating collaboration
deliver delivering delivery maintain maintaining maintenance create creating build building help helping
lead leading leadership senior junior mid associate executive officer engineer engineers`.split(/\s+/));

// multi-word skills worth matching as a phrase
const PHRASES = ["machine learning", "deep learning", "data science", "data analysis", "data analytics", "data engineering",
  "project management", "product management", "supply chain", "quality control", "quality assurance", "production planning",
  "inventory management", "lean manufacturing", "six sigma", "power bi", "sql server", "rest api", "web development",
  "ms excel", "microsoft excel", "customer service", "business development", "human resources", "financial analysis",
  "account payable", "accounts payable", "accounts receivable", "cost accounting", "internal audit", "preventive maintenance",
  "iso 9001", "iso 14001", "health and safety", "root cause analysis", "problem solving", "team management", "stakeholder management",
  "natural language processing", "computer vision", "cloud computing", "version control", "unit testing", "ci/cd", "sales and marketing",
  "cad design", "heat treatment", "non destructive testing", "steel structure", "plant operations", "vendor management"];

const SHORT_OK = new Set(["c", "r", "go", "qa", "hr", "ui", "ux", "ai", "ml", "bi", "it", "erp", "sap", "gst", "tds", "cnc", "plc", "ndt", "hse", "ehs"]);

const tokenize = (t) => (t.toLowerCase().match(/[a-z0-9][a-z0-9+#.]*/g) || []).map((x) => x.replace(/\.+$/, "")).filter(Boolean);
const stem = (w) => (w.length > 4 && w.endsWith("ies") ? w.slice(0, -3) + "y" : w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const isKeyword = (w) => !STOP.has(w) && !/^[\d+.]+$/.test(w) && (w.length >= 3 || SHORT_OK.has(w) || /[+#]/.test(w));

// Pull the most relevant terms out of a JD: known phrases + the most frequent non-generic words.
function extractKeywords(jd, max = 30) {
  const low = jd.toLowerCase();
  const found = new Map(); // keyword -> weight
  PHRASES.forEach((p) => { if (low.includes(p)) found.set(p, 100); });
  const toks = tokenize(jd);
  const freq = new Map();
  toks.forEach((w, i) => {
    if (!isKeyword(w)) return;
    const s = stem(w);
    const cur = freq.get(s) || { word: w, n: 0, first: i };
    cur.n += 1;
    freq.set(s, cur);
  });
  const phraseWords = new Set([...found.keys()].flatMap((p) => p.split(" ").map(stem)));
  [...freq.values()]
    .filter((v) => !phraseWords.has(stem(v.word)))
    .sort((a, b) => b.n - a.n || a.first - b.first)
    .forEach((v) => found.set(v.word, v.n));
  return [...found.keys()].slice(0, max);
}

// "3+ years", "2-5 years", "minimum 4 yrs" -> 3 / 2 / 4
function jdMinExperience(jd) {
  const m = jd.match(/(\d{1,2})\s*(?:\+|-|–|to)?\s*(?:\d{1,2})?\s*(?:years?|yrs?)/i);
  return m && Number(m[1]) <= 30 ? Number(m[1]) : 0;
}

function screen(info, jd, keywords, passScore) {
  const resumeLow = info.text.toLowerCase();
  const resumeStems = new Set(tokenize(info.text).map(stem));
  const hit = (k) => (k.includes(" ") || k.includes("/") ? resumeLow.includes(k) : resumeStems.has(stem(k)));
  const matched = keywords.filter(hit);
  const missing = keywords.filter((k) => !matched.includes(k));
  const score = keywords.length ? Math.round((100 * matched.length) / keywords.length) : 0;
  const minExp = jdMinExperience(jd);
  const reasons = [];
  if (!info.email) reasons.push("Email not found");
  if (score < passScore) reasons.push(`Match score ${score}% is below the required ${passScore}%`);
  // experience is only a hard rule when the resume actually states it
  if (minExp && info.experienceYears > 0 && info.experienceYears < minExp)
    reasons.push(`Experience ${info.experienceYears} yrs is below the ${minExp} yrs required`);
  return { ok: reasons.length === 0, reasons, matched, missing, score };
}

/* ------------------------------ Zoho Recruit ------------------------------ */
// Scope: ZohoRecruit.modules.ALL. The access token is renewed automatically from the refresh token.
const zAccounts = () => process.env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.com";
const zApi = () => (process.env.ZOHO_API_URL || "https://recruit.zoho.com") + "/recruit/v2";
const token = { value: null, exp: 0 };

async function getAccessToken(force = false) {
  if (!force && token.value && Date.now() < token.exp - 60000) return token.value;
  const r = await fetch(`${zAccounts()}/oauth/v2/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: process.env.ZOHO_REFRESH_TOKEN || "",
      client_id: process.env.ZOHO_CLIENT_ID || "",
      client_secret: process.env.ZOHO_CLIENT_SECRET || "",
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("Token refresh failed: " + JSON.stringify(d));
  token.value = d.access_token;
  token.exp = Date.now() + (d.expires_in || 3600) * 1000;
  return token.value;
}

// body is a function so FormData can be rebuilt when retrying after a 401
async function zRequest(method, p, { params, body } = {}, retry = true) {
  const url = new URL(zApi() + p);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const opts = { method, headers: { Authorization: `Zoho-oauthtoken ${await getAccessToken()}` } };
  if (body) {
    const b = body();
    if (b instanceof FormData) opts.body = b;
    else { opts.body = JSON.stringify(b); opts.headers["Content-Type"] = "application/json"; }
  }
  const r = await fetch(url, opts);
  if (r.status === 401 && retry) {
    await getAccessToken(true);
    return zRequest(method, p, { params, body }, false);
  }
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null, text };
}

async function createCandidate(info, note) {
  if (info.email) {
    const s = await zRequest("GET", "/Candidates/search", { params: { email: info.email } });
    const found = s.json?.data?.[0]?.id;
    if (found) return { id: found, created: false };
  }
  const record = {
    First_Name: info.firstName || "",
    Last_Name: info.lastName || info.firstName || "Unknown",
    Email: info.email,
    Mobile: info.phone,
    Skill_Set: info.skills.join(", ").slice(0, 250),
    Experience_in_Years: info.experienceYears || 0,
    Additional_Info: note, // Source is a pick list, so the note goes here
  };
  const r = await zRequest("POST", "/Candidates", { body: () => ({ data: [record] }) });
  const item = r.json?.data?.[0] || {};
  if (item.code === "DUPLICATE_DATA") return { id: item.details.id, created: false }; // search index may lag behind
  if (item.code !== "SUCCESS") throw new Error("Candidate create failed: " + r.text);
  return { id: item.details.id, created: true };
}

async function attachResume(id, filePath, filename) {
  const buf = fs.readFileSync(filePath);
  const r = await zRequest("POST", `/Candidates/${id}/Attachments`, {
    body: () => {
      const f = new FormData();
      f.append("attachments_category", "Resume");
      f.append("file", new Blob([buf]), filename);
      return f;
    },
  });
  if (r.json?.data?.[0]?.code !== "SUCCESS") throw new Error("Attachment failed: " + r.text);
}

/* -------------------------------- Pages -------------------------------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TABS = [["/", "Upload"], ["/history", "History"]];

const layout = (body, { active = "/", title = "", actions = "", flash = "", error = "" } = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Resume Screener</title>
<style>
:root{--top:#2a2f3d;--sub:#eef1f6;--bg:#f4f6fa;--card:#fff;--tx:#1f2933;--mu:#6b7785;--bd:#dfe3ea;--ac:#2f6fd0;--ok:#1a8a5f;--no:#d0382c;--warn:#b7791f}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--tx);font:15px "Segoe UI",system-ui,sans-serif}
.top{background:var(--top);display:flex;align-items:center;gap:6px;padding:0 20px;height:56px}
.top a.tab{color:#d6dbe6;text-decoration:none;font-weight:500;padding:0 16px;height:56px;line-height:56px;border-bottom:3px solid transparent}
.top a.tab:hover{color:#fff}.top a.tab.on{color:#fff;border-bottom-color:#fff}
.sub{background:var(--sub);border-bottom:1px solid var(--bd);padding:12px 20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;min-height:50px}
.sub h1{margin:0;font-size:16px;letter-spacing:.3px}.sub .sp{flex:1}
main{max-width:1150px;margin:18px auto;padding:0 16px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:4px;padding:18px;margin-bottom:16px}
.card h3{margin:0 0 4px;font-size:16px;font-weight:600}.card .hint{margin:0 0 14px;color:var(--mu);font-size:13.5px}
.stages{background:var(--card);border:1px solid var(--bd);border-radius:4px;margin-bottom:16px;overflow:hidden}
.stages .bar{height:3px;background:linear-gradient(90deg,#4d86d8,#9a74c9,#d1a13c,#7cbf6b,#e0875a,#d95b5b)}
.stages .row{display:flex}.stages .cell{flex:1;text-align:center;padding:16px 6px;border-right:1px solid var(--bd)}
.stages .cell:last-child{border-right:0}.stages b{display:block;font-size:24px;font-weight:600}
.stages span{color:var(--mu);font-size:14px}
.ok{color:var(--ok)}.no{color:var(--no)}.mu{color:var(--mu)}.sm{font-size:12.5px}
label.f{display:block;font-weight:500;margin-bottom:5px}
.grid{display:grid;grid-template-columns:1fr 160px;gap:14px;margin-bottom:14px}
button,.btn{background:var(--ac);color:#fff;border:1px solid var(--ac);border-radius:4px;padding:8px 18px;font-size:14px;cursor:pointer;text-decoration:none;display:inline-block}
button:hover,.btn:hover{filter:brightness(1.08)}button:disabled{opacity:.6;cursor:wait}
.btn.ghost{background:#fff;color:var(--tx);border-color:var(--bd)}
input,select,textarea{padding:8px 10px;border:1px solid var(--bd);border-radius:4px;background:#fff;color:var(--tx);font:inherit;max-width:100%}
textarea{width:100%;resize:vertical;line-height:1.45}
input:focus,select:focus,textarea:focus{outline:2px solid #bcd3f5;border-color:var(--ac)}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:10px 8px;color:var(--mu);font-size:12.5px;font-weight:500;text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid var(--bd);white-space:nowrap}
td{text-align:left;padding:10px 8px;border-bottom:1px solid #eceff4;font-size:14px;vertical-align:top}
tr:hover td{background:#f8fafd}
.pill{display:inline-block;padding:2px 10px;border-radius:10px;font-size:12px;font-weight:600;white-space:nowrap}
.pill.PASS,.pill.CREATED{background:#e2f4ec;color:var(--ok)}.pill.FAIL,.pill.ERROR{background:#fbe6e4;color:var(--no)}
.pill.DUPLICATE{background:#fdf0d9;color:var(--warn)}
.meter{width:90px;height:6px;background:#e6e9ef;border-radius:3px;overflow:hidden;margin-top:5px}.meter i{display:block;height:100%}
.meter i.PASS{background:#2fa77a}.meter i.FAIL{background:#e0675c}
.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{background:#eef1f6;border:1px solid var(--bd);border-radius:12px;padding:2px 10px;font-size:12.5px}
.chip.hit{background:#e2f4ec;border-color:#bfe0d1;color:var(--ok)}
.scroll{overflow-x:auto}
#drop{border:2px dashed #c5cdda;border-radius:6px;padding:30px;text-align:center;background:#fafbfd}
#drop.over{border-color:var(--ac);background:#f0f5fd}
.flash{border-radius:4px;padding:10px 14px;margin-bottom:14px;background:#e8f3ee;border:1px solid #bfe0d1;color:#16664a}
.flash.err{background:#fbe9e7;border-color:#f1c2bd;color:#9b2c22}
.filters{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px}
.filters div{display:flex;flex-direction:column;gap:4px}.filters label{font-size:12.5px;color:var(--mu)}
.pager{display:flex;gap:10px;align-items:center;justify-content:flex-end;margin-top:14px;color:var(--mu);font-size:14px}
.empty{text-align:center;color:var(--mu);padding:34px 0}
details>summary{cursor:pointer;font-weight:600;font-size:16px}
@media(max-width:700px){.stages .row{flex-wrap:wrap}.stages .cell{flex:1 1 33%;border-bottom:1px solid var(--bd)}.grid{grid-template-columns:1fr}}
</style></head><body>
<div class="top">${TABS.map(([h, t]) => `<a class="tab ${h === active ? "on" : ""}" href="${h}">${t}</a>`).join("")}</div>
<div class="sub"><h1>${esc(title)}</h1><span class="sp"></span>${actions}</div>
<main>${flash ? `<div class="flash">${esc(flash)}</div>` : ""}${error ? `<div class="flash err">${esc(error)}</div>` : ""}${body}</main></body></html>`;

const stages = (cells) => `<div class="stages"><div class="bar"></div><div class="row">
${cells.map(([n, l, c]) => `<div class="cell"><b class="${c || ""}">${n}</b><span>${l}</span></div>`).join("")}</div></div>`;

const pill = (s, label) => `<span class="pill ${esc(s)}">${esc(label || s)}</span>`;
const meter = (score, status) => `<b>${score ?? "-"}${score == null ? "" : "%"}</b><div class="meter"><i class="${status}" style="width:${score || 0}%"></i></div>`;
const zohoCell = (z) => (z ? pill(z.split(":")[0], z.split(":")[0]) + (z.startsWith("ERROR") ? `<div class="mu sm">${esc(z.slice(6))}</div>` : "") : "");

const indexPage = ({ today, cfg, error = "" }) => layout(`
${stages([[today.p + today.f, "Screened today"], [today.p, "Passed today", "ok"], [today.f, "Failed today", "no"]])}
<form action="/upload" method="post" enctype="multipart/form-data" id="form">
 <div class="card">
  <h3>Job description</h3>
  <p class="hint">Paste the JD. Keywords and the minimum experience are picked up from it automatically, and every resume is scored against them.</p>
  <div class="grid">
   <div><label class="f" for="jd_title">Job title</label><input id="jd_title" name="jd_title" style="width:100%" placeholder="e.g. Production Engineer" value="${esc(cfg.jd_title)}" required></div>
   <div><label class="f" for="threshold">Pass score (%)</label><input id="threshold" name="threshold" type="number" min="1" max="100" style="width:100%" value="${esc(cfg.threshold || 50)}" required></div>
  </div>
  <label class="f" for="jd_text">Job description</label>
  <textarea id="jd_text" name="jd_text" rows="9" placeholder="Paste the full job description here..." required>${esc(cfg.jd_text)}</textarea>
 </div>
 <div class="card">
  <h3>Resumes</h3>
  <p class="hint">PDF, DOCX or TXT. You can select multiple files.</p>
  <div id="drop"><p id="dropmsg"><b>Drag &amp; drop resumes here</b> or choose files</p>
  <input type="file" id="files" name="resumes" multiple accept=".pdf,.docx,.txt" required></div>
  <p style="margin:16px 0 0"><button id="go">Upload &amp; Screen</button></p>
 </div>
</form>
<script>
const drop = document.getElementById("drop"), files = document.getElementById("files"), msg = document.getElementById("dropmsg");
const show = () => { if (files.files.length) msg.innerHTML = "<b>" + files.files.length + " file" + (files.files.length > 1 ? "s" : "") + " selected</b>"; };
files.addEventListener("change", show);
["dragenter", "dragover"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (ev) => { files.files = ev.dataTransfer.files; show(); });
document.getElementById("form").addEventListener("submit", () => { const b = document.getElementById("go"); setTimeout(() => { b.disabled = true; b.textContent = "Screening..."; }); });
</script>`, { active: "/", title: "UPLOAD RESUMES", error });

const resultPage = ({ results, keywords, title, threshold }) => {
  const p = results.filter((r) => r.status === "PASS").length;
  return layout(`${stages([[results.length, "Screened"], [p, "Passed", "ok"], [results.length - p, "Failed", "no"]])}
<div class="card"><h3>Keywords from the JD</h3><p class="hint">${esc(title)} &middot; pass score ${threshold}% &middot; green = found in at least one resume</p>
<div class="chips">${keywords.map((k) => `<span class="chip ${results.some((r) => r.matched.includes(k)) ? "hit" : ""}">${esc(k)}</span>`).join("")}</div></div>
<div class="card scroll"><table>
<tr><th>File</th><th>Candidate</th><th>Match</th><th>Result</th><th>Details</th></tr>
${results.map((r) => `<tr><td>${esc(r.filename)}</td>
<td><b>${esc(r.name || "-")}</b><div class="mu sm">${esc(r.email || "")}</div></td>
<td>${r.score == null ? "-" : meter(r.score, r.status)}</td><td>${pill(r.status)}</td>
<td>${r.status === "FAIL" ? esc(r.reason) : zohoCell(r.zoho)}
${r.missing.length ? `<div class="mu sm">Missing: ${esc(r.missing.slice(0, 8).join(", "))}${r.missing.length > 8 ? "..." : ""}</div>` : ""}</td></tr>`).join("")}
</table></div>`, { active: "/", title: "SCREENING RESULT", actions: `<a class="btn" href="/">Screen more</a>` });
};

const pageHref = (q, page) => "/history?" + new URLSearchParams({ ...q, page }).toString();

const historyPage = ({ rows, daily, totals, q, page, pages, count }) => layout(`
${stages([[totals.t, "Total screened"], [totals.p, "Passed", "ok"], [totals.f, "Failed", "no"], [totals.t ? Math.round((100 * totals.p) / totals.t) + "%" : "-", "Pass rate"]])}
<div class="card scroll"><details ${daily.length ? "open" : ""}><summary>Daily summary</summary><br>
${daily.length ? `<table><tr><th>Date</th><th>Screened</th><th>Passed</th><th>Failed</th><th>Pass rate</th></tr>
${daily.map((r) => `<tr><td>${esc(r.d)}</td><td>${r.t}</td><td class="ok">${r.p}</td><td class="no">${r.f}</td><td>${Math.round((100 * r.p) / r.t)}%</td></tr>`).join("")}</table>`
  : `<div class="empty">Nothing screened yet.</div>`}</details></div>
<div class="card scroll"><h3>Resumes</h3><br>
<form method="get" class="filters">
 <div><label>Search</label><input name="search" placeholder="Name, email, phone or file" value="${esc(q.search)}" style="width:240px"></div>
 <div><label>Position</label><input name="position" placeholder="Job title" value="${esc(q.position)}" style="width:170px"></div>
 <div><label>Status</label><select name="status"><option value="">All</option><option value="PASS" ${q.status === "PASS" ? "selected" : ""}>Passed</option><option value="FAIL" ${q.status === "FAIL" ? "selected" : ""}>Failed</option></select></div>
 <div><label>From</label><input type="date" name="from" value="${esc(q.from)}"></div>
 <div><label>To</label><input type="date" name="to" value="${esc(q.to)}"></div>
 <button>Apply</button><a class="btn ghost" href="/history">Reset</a>
</form>
${rows.length ? `<table><tr><th>Date</th><th>Candidate</th><th>Position</th><th>Match</th><th>Status</th><th>Details</th></tr>
${rows.map((r) => `<tr>
<td style="white-space:nowrap">${esc((r.uploaded_at || "").slice(0, 10))}<div class="mu sm">${esc((r.uploaded_at || "").slice(11, 16))}</div></td>
<td><b>${esc(r.name || "-")}</b><div class="mu sm">${esc(r.email || "")}${r.phone ? " &middot; " + esc(r.phone) : ""}</div><div class="mu sm">${esc(r.filename)}</div></td>
<td>${esc(r.position || "-")}</td>
<td>${r.score == null ? "-" : meter(r.score, r.status)}</td>
<td>${pill(r.status)}</td>
<td>${r.status === "FAIL" ? esc(r.reason) : zohoCell(r.zoho_status)}${r.missing ? `<div class="mu sm">Missing: ${esc(r.missing.split(", ").slice(0, 6).join(", "))}</div>` : ""}</td></tr>`).join("")}</table>
<div class="pager"><span>${count} result${count === 1 ? "" : "s"}</span>
${page > 1 ? `<a class="btn ghost" href="${pageHref(q, page - 1)}">Previous</a>` : ""}<span>Page ${page} of ${pages}</span>
${page < pages ? `<a class="btn ghost" href="${pageHref(q, page + 1)}">Next</a>` : ""}</div>`
  : `<div class="empty">No resumes match these filters.</div>`}</div>`,
  { active: "/history", title: "HISTORY", actions: `<a class="btn ghost" href="/export.csv?${new URLSearchParams({ ...q }).toString()}">Export CSV</a>` });

/* -------------------------------- Routes -------------------------------- */
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (_, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const app = express();

function todayStats() {
  return db.prepare("SELECT COALESCE(SUM(status='PASS'),0) p, COALESCE(SUM(status='FAIL'),0) f FROM resumes WHERE date(uploaded_at)=?")
    .get(now().slice(0, 10));
}

app.get("/", (_, res) => res.send(indexPage({ today: todayStats(), cfg: getCfg() })));

app.post("/upload", upload.array("resumes"), async (req, res) => {
  const files = req.files || [];
  const title = (req.body.jd_title || "").trim();
  const jd = (req.body.jd_text || "").trim();
  const threshold = Math.min(100, Math.max(1, parseInt(req.body.threshold, 10) || 50));
  const keywords = extractKeywords(jd);
  const bail = (error) => {
    files.forEach((f) => fs.rmSync(f.path, { force: true }));
    res.status(400).send(indexPage({ today: todayStats(), cfg: { jd_title: title, jd_text: jd, threshold }, error }));
  };
  if (!title || !jd) return bail("Please enter a job title and a job description.");
  if (!keywords.length) return bail("No keywords could be found in this job description. Please paste a fuller description.");
  if (!files.length) return bail("Please select at least one resume.");

  setCfg("jd_title", title); setCfg("jd_text", jd); setCfg("threshold", threshold); // prefill next time

  const insert = db.prepare(`INSERT INTO resumes(uploaded_at,filename,stored_path,name,email,phone,skills,experience,
    status,reason,zoho_id,zoho_status,position,score,matched,missing) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const results = [];

  for (const f of files) {
    const filename = Buffer.from(f.originalname, "latin1").toString("utf8"); // fix multer filename encoding
    if (!ALLOWED.includes(path.extname(filename).toLowerCase())) {
      fs.rmSync(f.path, { force: true });
      results.push({ filename, name: null, email: null, score: null, status: "FAIL", reason: "Unsupported file type", matched: [], missing: [] });
      continue;
    }
    let info, r;
    try {
      info = await parseResume(f.path);
      r = screen(info, jd, keywords, threshold);
      info.skills = r.matched;
    } catch (e) { // corrupt or scanned file
      info = { name: null, email: null, phone: null, skills: [], experienceYears: 0 };
      r = { ok: false, reasons: [`Could not read file: ${e.message}`], matched: [], missing: keywords, score: null };
    }

    let zid = null, zstat = null;
    if (r.ok) {
      try {
        const c = await createCandidate(info, `Added via Resume Parser | Position: ${title} | Match: ${r.score}%`);
        zid = c.id;
        if (c.created) await attachResume(zid, f.path, filename);
        zstat = c.created ? "CREATED" : "DUPLICATE";
      } catch (e) {
        zstat = `ERROR: ${e.message}`.slice(0, 300);
      }
    }
    const status = r.ok ? "PASS" : "FAIL";
    const reason = r.reasons.join("; ");
    insert.run(now(), filename, f.path, info.name, info.email, info.phone, info.skills.join(", "), info.experienceYears,
      status, reason, zid, zstat, title, r.score, r.matched.join(", "), r.missing.join(", "));
    results.push({ filename, name: info.name, email: info.email, score: r.score, status, reason, zoho: zstat, matched: r.matched, missing: r.missing });
  }
  res.send(resultPage({ results, keywords, title, threshold }));
});

function historyFilter(query) {
  const q = {};
  for (const k of ["search", "position", "status", "from", "to"]) if (query[k]) q[k] = String(query[k]);
  let where = "WHERE 1=1";
  const args = [];
  if (q.search) {
    where += " AND (name LIKE ? OR email LIKE ? OR phone LIKE ? OR filename LIKE ?)";
    args.push(...Array(4).fill(`%${q.search}%`));
  }
  if (q.position) { where += " AND position LIKE ?"; args.push(`%${q.position}%`); }
  if (q.status === "PASS" || q.status === "FAIL") { where += " AND status=?"; args.push(q.status); }
  else delete q.status;
  if (q.from) { where += " AND date(uploaded_at)>=?"; args.push(q.from); }
  if (q.to) { where += " AND date(uploaded_at)<=?"; args.push(q.to); }
  return { q, where, args };
}

app.get("/history", (req, res) => {
  const { q, where, args } = historyFilter(req.query);
  const count = db.prepare(`SELECT COUNT(*) n FROM resumes ${where}`).get(...args).n;
  const pages = Math.max(1, Math.ceil(count / PER_PAGE));
  const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
  const rows = db.prepare(`SELECT * FROM resumes ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, PER_PAGE, (page - 1) * PER_PAGE);
  const totals = db.prepare("SELECT COUNT(*) t, COALESCE(SUM(status='PASS'),0) p, COALESCE(SUM(status='FAIL'),0) f FROM resumes").get();
  const daily = db.prepare(`SELECT date(uploaded_at) d, SUM(status='PASS') p, SUM(status='FAIL') f, COUNT(*) t
    FROM resumes GROUP BY d ORDER BY d DESC LIMIT 30`).all();
  res.send(historyPage({ rows, daily, totals, q, page, pages, count }));
});

app.get("/export.csv", (req, res) => {
  const { where, args } = historyFilter(req.query);
  const cols = ["uploaded_at", "filename", "name", "email", "phone", "position", "score", "status", "reason", "zoho_status", "matched", "missing"];
  const rows = db.prepare(`SELECT ${cols.join(",")} FROM resumes ${where} ORDER BY id DESC`).all(...args);
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n");
  res.set({ "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=resume_log.csv" }).send(csv);
});

app.get("/settings", (_, res) => res.redirect("/")); // old bookmark

if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`Resume Screener: http://localhost:${PORT}`));

  // Renew the Zoho access token on a schedule (default every 40 min; it expires after 60 min).
  // The refresh token itself never expires, so only the access token is regenerated.
  const refreshMs = (Number(process.env.TOKEN_REFRESH_MINUTES) || 40) * 60 * 1000;
  const renew = () => getAccessToken(true)
    .then(() => console.log(`[${now()}] Zoho access token refreshed`))
    .catch((e) => console.error(`[${now()}] Zoho token refresh failed: ${e.message}`));
  renew();
  setInterval(renew, refreshMs);
}
module.exports = { app, db, zRequest, extractKeywords, screen };
