#!/usr/bin/env node
// Regenerates assets/telemetry-{dark,light}.svg and assets/projects-{dark,light}.svg
// from live GitHub data. Design is byte-identical to the hand-built originals —
// only the data cells (numbers, activity line, language bars, star counts) change.
//
// Requires env GITHUB_TOKEN (the workflow passes the built-in token). Zero deps.
//
// Run: GITHUB_TOKEN=xxx node .github/scripts/gen-telemetry.mjs

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USER = "KnockOutEZ";
// repos whose star counts appear on the projects panel (aesir stays "go · nexentra")
const STAR_REPOS = {
  wigolo: "KnockOutEZ/wigolo",
  diffdeck: "KnockOutEZ/diffdeck",
  risor: "deepnoodle-ai/risor",
};

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const ASSETS = resolve(ROOT, "assets");

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}

const gh = async (path) => {
  const r = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": USER,
    },
  });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};

const gql = async (query, variables) => {
  const r = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": USER,
    },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(`graphql: ${JSON.stringify(j.errors)}`);
  return j.data;
};

const iso = (d) => d.toISOString();

// ── fetch live data ─────────────────────────────────────────────
async function collect() {
  const profile = await gh(`/users/${USER}`);
  const created = new Date(profile.created_at);

  // all-time contributions: sum each year's calendar (GitHub only lets you
  // query one <=1yr window at a time)
  let totalContrib = 0;
  const thisYear = new Date().getUTCFullYear();
  for (let y = created.getUTCFullYear(); y <= thisYear; y++) {
    const from = iso(new Date(Date.UTC(y, 0, 1)));
    const to = iso(new Date(Date.UTC(y, 11, 31, 23, 59, 59)));
    const d = await gql(
      `query($u:String!,$f:DateTime!,$t:DateTime!){user(login:$u){contributionsCollection(from:$f,to:$t){contributionCalendar{totalContributions}}}}`,
      { u: USER, f: from, t: to }
    );
    totalContrib += d.user.contributionsCollection.contributionCalendar.totalContributions;
  }

  // rolling ~14-week window for the activity pulse
  const now = new Date();
  const windowStart = new Date(now.getTime() - 98 * 864e5);
  const pulseData = await gql(
    `query($u:String!,$f:DateTime!,$t:DateTime!){user(login:$u){contributionsCollection(from:$f,to:$t){contributionCalendar{weeks{contributionDays{contributionCount}}}}}}`,
    { u: USER, f: iso(windowStart), t: iso(now) }
  );
  const weeks = pulseData.user.contributionsCollection.contributionCalendar.weeks
    .map((w) => w.contributionDays.reduce((s, d) => s + d.contributionCount, 0))
    .slice(-14);

  // language totals across owned, non-fork repos
  const langData = await gql(
    `query($u:String!){user(login:$u){repositories(first:100,ownerAffiliations:OWNER,isFork:false){nodes{languages(first:10){edges{size node{name}}}}}}}`,
    { u: USER }
  );
  const langBytes = {};
  for (const repo of langData.user.repositories.nodes) {
    for (const e of repo.languages.edges) {
      langBytes[e.node.name] = (langBytes[e.node.name] || 0) + e.size;
    }
  }

  // star counts for the pinned repos
  const stars = {};
  for (const [key, slug] of Object.entries(STAR_REPOS)) {
    stars[key] = (await gh(`/repos/${slug}`)).stargazers_count;
  }

  return {
    contributions: totalContrib,
    repos: profile.public_repos,
    followers: profile.followers,
    since: created,
    weeks,
    langBytes,
    stars,
  };
}

// ── geometry helpers ────────────────────────────────────────────
const MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];

function pulse(weeks) {
  // 14 points across x=540..860, y mapped into 98..150 (higher count = higher line)
  const n = 14;
  const vals = weeks.length ? weeks : new Array(n).fill(0);
  while (vals.length < n) vals.unshift(0);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const x0 = 540, x1 = 860, yTop = 98, yBot = 150;
  const pts = vals.map((v, i) => {
    const x = x0 + ((x1 - x0) * i) / (n - 1);
    const y = yBot - ((v - min) / span) * (yBot - yTop);
    return { x: Math.round(x), y: Math.round(y * 10) / 10 };
  });
  const points = pts.map((p) => `${p.x},${p.y}`).join(" ");
  const last = pts[pts.length - 1];
  return { points, px: last.x, py: last.y };
}

function langBars(langBytes) {
  const opacities = [1.0, 0.72, 0.5, 0.34, 0.2];
  const total = Object.values(langBytes).reduce((s, v) => s + v, 0) || 1;
  const sorted = Object.entries(langBytes).sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 4);
  const other = sorted.slice(4).reduce((s, [, v]) => s + v, 0);
  const segs = top.map(([name, v]) => ({ name, v }));
  segs.push({ name: "other", v: other });

  const X0 = 540, WIDTH = 320;
  const widths = segs.map((s) => Math.round((s.v / total) * WIDTH));
  // absorb rounding drift into the largest segment so bars always span 320px
  const drift = WIDTH - widths.reduce((s, w) => s + w, 0);
  if (widths.length) widths[0] += drift;

  let x = X0;
  const rects = segs
    .map((s, i) => {
      const w = Math.max(0, widths[i]);
      const rect = `<rect class="grow" x="${x}" y="178" width="${w}" height="10" fill="{{C_FG}}" opacity="${opacities[i] ?? 0.2}"/>`;
      x += w;
      return rect;
    })
    .join("\n");
  const label = segs.map((s) => s.name.toLowerCase()).join(" · ");
  return { rects, label };
}

// ── templates (byte-identical to originals, data swapped for tokens) ──
const STYLE = `<style>
.fade{animation:fade .9s ease both}
@keyframes fade{from{opacity:0}}
.blink{animation:blink 1.1s steps(2,start) infinite}
@keyframes blink{50%{opacity:0}}
.ping{transform-box:fill-box;transform-origin:center;animation:ping 2.2s ease-out infinite}
@keyframes ping{0%{transform:scale(.55);opacity:.8}100%{transform:scale(1.7);opacity:0}}
.draw{stroke-dasharray:700;animation:draw 2.4s ease both .3s}
@keyframes draw{from{stroke-dashoffset:700}to{stroke-dashoffset:0}}
.grow{transform-box:fill-box;transform-origin:left;animation:grow 1.4s ease both .4s}
@keyframes grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
</style>`;

const telemetrySVG = (t) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 240" width="880" height="240" font-family="ui-monospace,'SFMono-Regular','Cascadia Mono',Menlo,Consolas,'Liberation Mono',monospace">
${STYLE}
<text x="10" y="26" font-size="12" fill="${t.cLabel}" font-weight="600" text-anchor="start" letter-spacing="3" class="fade">04 — telemetry</text><line x1="150.8" y1="21" x2="870" y2="21" stroke="${t.cLine}" stroke-width="1"/>
<text x="30" y="92" font-size="11" fill="${t.cLabel}" font-weight="400" text-anchor="start" letter-spacing="2">contributions</text>
<text x="30" y="128" font-size="30" fill="${t.cFg}" font-weight="700" text-anchor="start">${t.contrib}</text>
<text x="30" y="152" font-size="10" fill="${t.cLabel}" font-weight="400" text-anchor="start">${t.since}</text>
<text x="205" y="92" font-size="11" fill="${t.cLabel}" font-weight="400" text-anchor="start" letter-spacing="2">repositories</text>
<text x="205" y="128" font-size="30" fill="${t.cFg}" font-weight="700" text-anchor="start">${t.repos}</text>
<text x="205" y="152" font-size="10" fill="${t.cLabel}" font-weight="400" text-anchor="start">public</text>
<text x="350" y="92" font-size="11" fill="${t.cLabel}" font-weight="400" text-anchor="start" letter-spacing="2">followers</text>
<text x="350" y="128" font-size="30" fill="${t.cFg}" font-weight="700" text-anchor="start">${t.followers}</text>
<text x="350" y="152" font-size="10" fill="${t.cLabel}" font-weight="400" text-anchor="start">and counting</text>
<text x="540" y="92" font-size="11" fill="${t.cLabel}" font-weight="400" text-anchor="start" letter-spacing="2">activity pulse</text>
<polyline class="draw" points="${t.points}" fill="none" stroke="${t.cFg}" stroke-width="1.5"/>
<circle class="ping" cx="${t.px}" cy="${t.py}" r="6" fill="none" stroke="${t.cFg}" stroke-width="1"/>
<circle cx="${t.px}" cy="${t.py}" r="2.5" fill="${t.cFg}"/>
${t.rects}
<text x="540" y="210" font-size="10" fill="${t.cLabel}" font-weight="400" text-anchor="start">${t.langs}</text>
</svg>
`;

const projectsSVG = (t) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 300" width="880" height="300" font-family="ui-monospace,'SFMono-Regular','Cascadia Mono',Menlo,Consolas,'Liberation Mono',monospace">
${STYLE}
<text x="10" y="26" font-size="12" fill="${t.cLabel}" font-weight="600" text-anchor="start" letter-spacing="3" class="fade">03 — projects</text><line x1="143.60000000000002" y1="21" x2="870" y2="21" stroke="${t.cLine}" stroke-width="1"/>
<rect x="10" y="56" width="410" height="96" rx="8" fill="none" stroke="${t.cLine}" stroke-width="1"/>
<text x="28" y="88" font-size="15" fill="${t.cFg}" font-weight="700" text-anchor="start">wigolo</text>
<text x="402" y="88" font-size="11" fill="${t.cLabel}" font-weight="400" text-anchor="end">typescript · ★ ${t.stars.wigolo}</text>
<text x="28" y="114" font-size="12" fill="${t.cLabel}" font-weight="400" text-anchor="start">web search, fetch &amp; crawl for ai coding agents</text>
<text x="28" y="134" font-size="12" fill="${t.cLabel}" font-weight="400" text-anchor="start">over mcp · local-first · no api keys · $0/query</text>
<rect x="460" y="56" width="410" height="96" rx="8" fill="none" stroke="${t.cLine}" stroke-width="1"/>
<text x="478" y="88" font-size="15" fill="${t.cFg}" font-weight="700" text-anchor="start">diffdeck</text>
<text x="852" y="88" font-size="11" fill="${t.cLabel}" font-weight="400" text-anchor="end">go · ★ ${t.stars.diffdeck}</text>
<text x="478" y="114" font-size="12" fill="${t.cLabel}" font-weight="400" text-anchor="start">smart diffs, security scans &amp; ai-ready outputs</text>
<text x="478" y="134" font-size="12" fill="${t.cLabel}" font-weight="400" text-anchor="start">for code reviews</text>
<rect x="10" y="170" width="410" height="96" rx="8" fill="none" stroke="${t.cLine}" stroke-width="1"/>
<text x="28" y="202" font-size="15" fill="${t.cFg}" font-weight="700" text-anchor="start">aesir</text>
<text x="402" y="202" font-size="11" fill="${t.cLabel}" font-weight="400" text-anchor="end">go · nexentra</text>
<text x="28" y="228" font-size="12" fill="${t.cLabel}" font-weight="400" text-anchor="start">a programming language, built from scratch</text>
<text x="28" y="248" font-size="12" fill="${t.cLabel}" font-weight="400" text-anchor="start">lexer to runtime</text>
<rect x="460" y="170" width="410" height="96" rx="8" fill="none" stroke="${t.cLine}" stroke-width="1"/>
<text x="478" y="202" font-size="15" fill="${t.cFg}" font-weight="700" text-anchor="start">risor</text>
<text x="852" y="202" font-size="11" fill="${t.cLabel}" font-weight="400" text-anchor="end">go · ★ ${t.stars.risor}</text>
<text x="478" y="228" font-size="12" fill="${t.cLabel}" font-weight="400" text-anchor="start">embeddable scripting language for go</text>
<text x="478" y="248" font-size="12" fill="${t.cLabel}" font-weight="400" text-anchor="start">contributor</text>
</svg>
`;

const THEME = {
  dark: { cLabel: "#8b949e", cFg: "#e6edf3", cLine: "#30363d" },
  light: { cLabel: "#57606a", cFg: "#0d1117", cLine: "#d0d7de" },
};
// projects panel big text is brighter in dark mode (#e6edf3) — same as telemetry cFg
const THEME_PROJECTS = {
  dark: { cLabel: "#8b949e", cFg: "#e6edf3", cLine: "#30363d" },
  light: { cLabel: "#57606a", cFg: "#0d1117", cLine: "#d0d7de" },
};

// ── main ────────────────────────────────────────────────────────
const data = await collect();
const contrib = `${data.contributions.toLocaleString("en-US")}+`;
const since = `since ${MONTHS[data.since.getUTCMonth()]} ${data.since.getUTCFullYear()}`;
const { points, px, py } = pulse(data.weeks);

mkdirSync(ASSETS, { recursive: true });

for (const theme of ["dark", "light"]) {
  const { rects, label } = langBars(data.langBytes);
  const svg = telemetrySVG({
    ...THEME[theme],
    contrib,
    repos: data.repos,
    followers: data.followers,
    since,
    points,
    px,
    py,
    rects: rects.replaceAll("{{C_FG}}", THEME[theme].cFg),
    langs: label,
  });
  writeFileSync(resolve(ASSETS, `telemetry-${theme}.svg`), svg);

  const pj = projectsSVG({ ...THEME_PROJECTS[theme], stars: data.stars });
  writeFileSync(resolve(ASSETS, `projects-${theme}.svg`), pj);
}

console.log(
  `updated: contributions=${contrib} repos=${data.repos} followers=${data.followers} ` +
    `stars=${JSON.stringify(data.stars)} langs=[${Object.keys(data.langBytes).length}]`
);
