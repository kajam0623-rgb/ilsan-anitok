#!/usr/bin/env node
/**
 * Unpacks a bundler "onefile" index.html into a static site.
 *
 * The onefile ships every asset as base64 inside <script type="__bundler/manifest">
 * and rebuilds the page in the browser by string-substituting each asset uuid in the
 * template for a blob: URL. That defeats the @font-face unicode-range subsetting the
 * fonts are built for: all 92 Pretendard subsets ship on every page load instead of
 * the ~10 the text actually needs.
 *
 * This does the same substitution at build time against real file paths, so the
 * browser fetches only what it needs and can cache it.
 *
 * Usage: node build.js <onefile.html> <outDir>
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const [, , srcPath, outDir] = process.argv;
if (!srcPath || !outDir) {
  console.error('usage: node build.js <onefile.html> <outDir>');
  process.exit(1);
}

const html = fs.readFileSync(srcPath, 'utf8');

function island(type) {
  const m = html.match(
    new RegExp(`<script type="${type}"[^>]*>([\\s\\S]*?)</script>`)
  );
  return m ? JSON.parse(m[1].trim()) : null;
}

const manifest = island('__bundler/manifest');
const extResources = island('__bundler/ext_resources') || [];
let template = island('__bundler/template');

if (!manifest || !template) {
  console.error('missing manifest or template island');
  process.exit(1);
}

// Where this page actually lives. The bundle was authored with every self-
// reference pointing at https://anitok.com/, but that host serves the ANITALK head
// office site — a different site. Leaving canonical there tells search engines this
// page is a duplicate of the head office's and to credit that one instead, so the
// Ilsan branch page would never rank on its own. Change this one constant if the
// page moves to its own domain.
const SITE = 'https://ilsan.anitok.com';
const AUTHORED_AT = 'https://anitok.com';

// Search ownership tokens for this property. Both engines read them from the <head>
// of the verified URL before running any script, so they are injected with the head
// assembly below rather than left to the bundle, which carries neither.
const GOOGLE_VERIFY = '--lr3p3aIhgHl1b42fWM1JstdLUn1QY-4lrHvXG5Lq4';
const NAVER_VERIFY = 'bfa240b5e79dfdc15b6fd61fa0cc079a2d392715';

// Microsoft Clarity project id, from clarity.microsoft.com. Left empty until the
// project exists: an empty id would ship ~40KB of script that reports to nobody, so
// the snippet is only emitted once this is filled in.
const CLARITY_ID = '';

// GA4 measurement id, from the property's data stream. Emitted in the head assembly
// below rather than left to the bundle. Same guard as CLARITY_ID: only emitted once
// it is filled in, so an empty id never ships a loader that reports to nobody.
const GA_ID = 'G-FT5DQ3M85P';

// 무료 체험 한 줄 안내. 히어로 버튼, 수업과목 아래 띠, 설명회 칸, 질문 아래, 오시는 길
// 다섯 곳이 이 한 문장을 같이 쓴다 — 횟수가 바뀌면 여기만 고친다.
const TRIAL_NOTE = '무료 체험 · 고등반 2회 · 주니어반 · 성인취미반 1회';

// ── 12/13 입시설명회 ──────────────────────────────────────────────────────────
// 원장님이 채울 값은 null 로 둔다. null 인 칸은 화면에 '[시간 확인]' 같은 빈칸으로
// 나가지 않고 그 줄만 빠지며, 빌드가 아직 비어 있는 칸을 마지막에 알려 준다.
//   url   : 네이버 예약에 설명회 상품을 만들면 그 주소. 비워 두면 상담 예약으로 보낸다.
//   time  : 예) '오후 2:00 ~ 3:30'      place : 예) '일산애니톡 본관 3층 강의실'
//   seats : 예) 20  (숫자만)
// until 이 지나면 빌드는 설명회를 통째로 빼고, 이미 배포된 페이지도 그날 밤
// 자정(한국 시간)이 넘으면 스스로 숨긴다.
const SEMINAR = {
  until: '2026-12-13T23:59:59+09:00',
  dateLabel: '12월 13일(토)',
  tracks: [
    {
      key: 'high',
      title: '예비 고1 · 2 · 3 입시 설명회',
      topic: '청강대 · 한예종 · 미대 웹툰 / 애니 입시 전략',
      time: null,
      place: null,
      seats: null,
      url: null,
    },
    {
      key: 'mid',
      title: '예비 중3 애니고 · 예고 입시 설명회',
      topic: '한국애니고 · 경기예고 · 서울웹툰애니고 대비',
      time: null,
      place: null,
      seats: null,
      url: null,
    },
  ],
};

const EXT = {
  'font/woff2': '.woff2',
  'font/woff': '.woff',
  'image/webp': '.webp',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/svg+xml': '.svg',
  'text/javascript': '.js',
};

const DIR = { font: 'fonts', image: 'gal', text: 'js' };

// ext_resources gives images human-readable ids (c0, j7, h0 ...) that match the
// filenames the previous build used. Reuse them; fall back to the uuid prefix.
const idByUuid = new Map(extResources.map((e) => [e.uuid, e.id]));

const pathByUuid = new Map();
let fontN = 0;
const written = { fonts: 0, gal: 0, js: 0 };
const bytes = { fonts: 0, gal: 0, js: 0 };

for (const [uuid, entry] of Object.entries(manifest)) {
  let buf = Buffer.from(entry.data, 'base64');
  if (entry.compressed) buf = zlib.gunzipSync(buf);

  const kind = entry.mime.split('/')[0];
  const dir = DIR[kind];
  if (!dir) {
    console.error(`unhandled mime ${entry.mime} (${uuid})`);
    process.exit(1);
  }
  const ext = EXT[entry.mime];
  if (!ext) {
    console.error(`unhandled mime ${entry.mime} (${uuid})`);
    process.exit(1);
  }

  // ext_resources ids are short slugs for images ("c0") but full CDN URLs for the
  // vendored scripts, so take the last path segment and drop anything that isn't
  // filename-safe.
  const rawId = idByUuid.get(uuid) || '';
  const slug = rawId
    .split('/')
    .pop()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-');

  const base =
    kind === 'font'
      ? `pretendard-${String(fontN++).padStart(2, '0')}`
      : slug || uuid.slice(0, 8);

  const rel = `${dir}/${base}${ext}`;
  fs.mkdirSync(path.join(outDir, dir), { recursive: true });
  fs.writeFileSync(path.join(outDir, rel), buf);

  pathByUuid.set(uuid, '/' + rel);
  written[dir]++;
  bytes[dir] += buf.length;
}

// Same substitution the runtime loader did, against paths instead of blob URLs.
// Covers uuids in markup, inline CSS url(), and inline JS alike.
for (const [uuid, p] of pathByUuid) template = template.split(uuid).join(p);

// Brand red. The bundle ships #D6202A; the ANITALK site at anitok.com uses
// #BD0D16, which is the red this page is meant to match. Remapped here rather
// than in index.html because index.html is generated — editing it would be undone
// by the next build from the source bundle.
const RED = { from: [214, 32, 42], to: [189, 13, 22] };
// Colours the bundle derives from the base by a fixed offset: #E82530 is the
// lighter glow tint, #B01820 the link hover. Both are carried by the same offset
// so the glow still reads as a highlight and hover stays visibly darker than the
// link — at the new, already-darker base, reusing the old literals would leave
// hover almost indistinguishable from rest.
const derived = (from) => ({
  from,
  to: RED.to.map((c, i) => Math.max(0, c + (from[i] - RED.from[i]))),
});
const TINT = derived([232, 37, 48]);
const HOVER = derived([176, 24, 32]);
// #FF3B45 and the rgba(255,86,60) ambient glow are deliberately left alone: the
// first is the on-dark variant used for the hero headline and links over the dark
// sections, where the base red only reaches ~3:1 contrast, and the second is a
// 10%-alpha warm glow rather than a brand colour.
const hex = (c) => '#' + c.map((n) => n.toString(16).padStart(2, '0')).join('');
let recoloured = 0;
for (const { from, to } of [RED, TINT, HOVER]) {
  const h = new RegExp(hex(from), 'gi');
  template = template.replace(h, () => (recoloured++, hex(to).toUpperCase()));
  // Alpha is carried on the tail of the match, so only the triple is rewritten.
  const rgb = new RegExp(`rgba?\\(\\s*${from[0]},\\s*${from[1]},\\s*${from[2]}`, 'g');
  template = template.replace(rgb, (m) => {
    recoloured++;
    return m.replace(/\d+,\s*\d+,\s*\d+$/, to.join(','));
  });
}

// Repoint the self-references. The two <a href="https://anitok.com/"> links — the
// nav's "애니톡 홈페이지" and the footer's — are deliberate outbound links to the head
// office and must survive, so anchors are matched and left alone rather than caught
// by a blanket replace.
let repointed = 0;
const repoint = (re, build) =>
  (template = template.replace(re, (...a) => (repointed++, build(...a))));

repoint(/(<link rel="canonical" href=")https?:\/\/[^"]*(")/i, (_, a, b) => a + SITE + '/' + b);
repoint(
  new RegExp(`(content=")${AUTHORED_AT}([^"]*")`, 'gi'),
  (_, a, b) => a + SITE + b
);
// The ld+json graph keys every node off the authored origin (@id, url, image, logo).
template = template.replace(
  /(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/i,
  (_, open, body, close) => {
    repointed += body.split(AUTHORED_AT).length - 1;
    return open + body.split(AUTHORED_AT).join(SITE) + close;
  }
);

// Search targets are the category phrases "일산만화학원" and "일산웹툰학원". The bundle
// spells them out in the meta description but nowhere in <title>, where "일산 만화·웹툰"
// breaks the phrase across a space and an interpunct — so the strongest on-page slot
// carries neither target as a contiguous string. Lead with them, keep the registered
// name after the divider.
// Order set by the school. 일산미술학원 is added because Naver autocompletes it, which
// 일산웹툰학원 does not — that one is kept at the school's direction despite the check
// (tools/keyword-research.js records what was found).
const TITLE = '일산만화학원 일산웹툰학원 일산미술학원 | 일산애니톡만화애니학원';
let seoEdits = 0;
const seo = (re, build) =>
  (template = template.replace(re, (...a) => (seoEdits++, build(...a))));

seo(/<title>[^<]*<\/title>/i, () => `<title>${TITLE}</title>`);
seo(/(<meta name="twitter:title" content=")[^"]*(")/i, (_, a, b) => a + TITLE + b);

// 일산애니톡만화학원 is what people actually call the school; the registered name is
// 일산애니톡만화애니학원. Both belong in the graph so either query resolves to this
// organisation. The category phrases above are deliberately NOT added here — they are
// not names of the business, and stuffing them into alternateName is the kind of thing
// that gets structured data ignored.
seo(/("alternateName":\[)/, (_, a) => a + '"일산애니톡만화학원",');

// Added to the keywords the school already had, not replacing them. Every term here
// autocompletes on Naver, which is evidence people type it; the bundle's own list
// includes several that return nothing (일산게임학원, 고양시만화학원, 일산미술입시학원,
// 일산디지털드로잉) and those are left alone rather than quietly removed.
// 일산미술학원 matters most: it went into the page title but was missing here.
const ADDED_KEYWORDS = [
  '일산미술학원',
  '만화학원',
  '웹툰학원',
  '초등 미술학원',
  '중학생 미술학원',
  '취미미술학원',
  '미대입시',
  '예고입시',
  '경기예고 입시',
  '청강대 웹툰과',
  '청강대 만화과',
  '운정 만화학원',
  '파주 만화학원',
  '화정 미술학원',
];
seo(/(<meta name="keywords" content=")([^"]*)(")/i, (_, a, existing, b) => {
  const have = new Set(existing.split(',').map((s) => s.trim().replace(/\s+/g, '')));
  const extra = ADDED_KEYWORDS.filter((k) => !have.has(k.replace(/\s+/g, '')));
  return a + existing + (extra.length ? ', ' + extra.join(', ') : '') + b;
});

// Headings carried neither target phrase — the h1 read "만화애니 학원의 정답! 일산애니톡!"
// and all nine h2s were mood copy. After <title>, headings are the next strongest
// on-page signal, so the h1 and one h2 carry the school's wording for them. The rest
// of the headings are left alone: repeating a phrase down the page reads as stuffing
// to a human and buys nothing from a ranker.
// Hero h1 and its subline are the school's own copy — keep the wording exactly as
// given, only the markup around it is ours.
seo(
  /만화애니 학원의 정답!<br>(<span style="color:#[0-9A-Fa-f]{6}">)일산애니톡!/,
  (_, span) => `웹툰,애니 교육의 정답!<br>${span}일산애니톡 만화학원!`
);
seo(
  /(data-reveal="160"[^>]*>)Since 2011 오직 만화애니 전문 교육 기관 · 일산 캠퍼스/,
  (_, open) => open + '일산 백마학원가 대표 만화학원'
);
seo(/그림 하나로<br>하루를 채우는 공간/, () => '일산만화학원 애니톡<br>그림 하나로 하루를 채우는 공간');

// ── Blog entry points ──
// /blog/ is otherwise an orphan: nothing on this page links to it, so a reader never
// finds it and a crawler reaches it only through the sitemap, which carries far less
// weight than a link from the site's strongest page. Three entry points go in — a
// section in the scroll path, a nav link, and a footer link. The nav is hidden below
// 860px, so on a phone the section and the footer are what carry it.
// 글 제목과 설명이 그대로 HTML 안에 들어간다. 지금은 &, < 를 쓴 글이 없지만
// 하나만 나와도 카드가 깨지고, 그때는 원인을 찾기 어렵다. 넣을 때 막는다.
const esc = (v) =>
  String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const POSTS_DIR = path.join(__dirname, 'content', 'posts');
let posts = [];
if (fs.existsSync(POSTS_DIR)) {
  posts = fs
    .readdirSync(POSTS_DIR)
    // 파일명이 숫자인 글만 읽던 자리다. 네이버에서 가져온 글은 글번호가 파일명이라
    // 걸렸지만, 손으로 쓴 글은 이름이 슬러그라 통째로 빠졌다. 그 글은 사이트맵에도
    // 홈 화면 카드에도 나오지 않았다. blog-render.js 는 처음부터 .md 를 다 읽는다.
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const head = (fs.readFileSync(path.join(POSTS_DIR, f), 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
      const get = (k) => ((head.match(new RegExp('^' + k + ':\\s*"?([^"\\n]+)"?', 'm')) || [])[1] || '').trim();
      const body = fs.readFileSync(path.join(POSTS_DIR, f), 'utf8');
      return {
        title: get('title'),
        description: get('description'),
        slug: get('slug'),
        date: get('date'),
        image: (body.match(/!\[[^\]]*\]\(([^)]+)\)/) || [])[1] || '',
      };
    })
    .filter((p) => p.slug && p.title)
    .sort((a, b) => b.date.localeCompare(a.date));
}

if (posts.length) {
  const card = (p) =>
    // white-space:normal is not decoration: the page sets `a[href] { white-space:
    // nowrap }` for its nav pills, and a card is an anchor, so without this the
    // title runs off the side instead of wrapping.
    `<a href="/blog/${p.slug}/" data-cta="blog" data-loc="home-stories" style="display:block;background:#131317;border:1px solid #232326;border-radius:18px;overflow:hidden;color:#FFFFFF;text-align:left;white-space:normal">` +
    // 사진이 없는 글은 카드 윗부분이 통째로 비어 3열 중 하나만 키가 어긋난다.
    // 같은 높이의 빈 판을 대신 깔아 줄을 맞춘다. blog/ 목록도 같은 방식이다.
    (p.image
      ? `<img src="${p.image}" alt="${esc(p.title)}" loading="lazy" decoding="async" style="display:block;width:100%;height:170px;object-fit:cover">`
      : `<span aria-hidden="true" style="display:block;width:100%;height:170px;background:linear-gradient(180deg,#17171A,#0F0F11);border-bottom:1px solid #232326"></span>`) +
    `<div style="padding:22px 20px">` +
    `<div style="font-size:19px;font-weight:800;line-height:1.4;letter-spacing:-.03em;word-break:keep-all;margin-bottom:10px">${esc(p.title)}</div>` +
    `<div style="font-size:14px;line-height:1.7;color:#A8A8AC;word-break:keep-all">${esc(p.description)}</div>` +
    `</div></a>`;

  const section =
    `<section id="stories" style="background:#0B0B0D;padding:clamp(115px,14.4vw,198px) clamp(20px,4vw,48px)">` +
    `<div style="max-width:1200px;margin:0 auto">` +
    `<div style="text-align:center;margin-bottom:52px">` +
    `<div style="font-size:12px;font-weight:800;letter-spacing:.22em;color:${hex(RED.to).toUpperCase()};margin-bottom:14px">STORIES</div>` +
    `<h2 style="margin:0;font-size:clamp(26px,3.2vw,40px);line-height:1.32;letter-spacing:-.04em;font-weight:800">학원 이야기</h2>` +
    `<p style="margin:16px 0 0;font-size:15px;line-height:1.85;color:#A8A8AC;word-break:keep-all">입시와 수업에서 자주 나오는 질문을 정리했습니다</p>` +
    `</div>` +
    `<div data-storygrid="1" style="display:grid;grid-template-columns:repeat(3,1fr);gap:20px">${posts.slice(0, 3).map(card).join('')}</div>` +
    `<div style="text-align:center;margin-top:40px">` +
    `<a href="/blog/" data-cta="blog" data-loc="home-stories-all" style="display:inline-flex;align-items:center;gap:8px;border:1px solid rgba(255,255,255,.28);color:#FFFFFF;font-size:15px;font-weight:700;padding:14px 30px;border-radius:999px">글 전체 보기 →</a>` +
    `</div></div></section>`;

  seo(/(<section id="visit")/, (_, a) => section + a);
  seo(
    /(<a href="#visit" data-nav="1"[^>]*>오시는 길<\/a>)/,
    (_, a) => a.replace(/href="#visit"/, 'href="/blog/"').replace('>오시는 길<', '>학원 이야기<') + a
  );
  seo(
    /(<a href="https:\/\/anitok\.com\/"[^>]*>애니톡 공식 홈페이지 바로가기 →<\/a>)/,
    (_, a) => `<a href="/blog/" style="color:#9A9A9A;margin-right:14px">학원 이야기</a>` + a
  );

  // 나머지 일곱 캠퍼스는 전부 일산으로 링크를 걸어 두는데 일산만 아무 데도 걸지
  // 않아, 링크가 한 방향으로만 흘렀다. 푸터에 형제 캠퍼스 줄을 넣어 여덟 사이트가
  // 서로를 가리키게 한다. 같은 브랜드라는 신호를 검색엔진과 AI 답변 양쪽에 준다.
  const SIBLINGS = [
    ['강동', 'https://gangdong.anitok.com/'],
    ['광교', 'https://gwanggyo.anitok.com/'],
    ['김포', 'https://gimpo.anitok.com/'],
    ['목동 본원', 'https://mokdong.anitok.com/'],
    ['부천', 'https://bucheon.anitok.com/'],
    ['웹툰게임 아카데미', 'https://academy-anitok.vercel.app/'],
    ['홍대', 'https://hongdae.anitok.com/'],
  ];
  const campusRow =
    `<div style="margin-top:20px;font-size:12.5px;line-height:2.1;color:#5A5A5A">` +
    `<span style="color:#5A5A5A;font-weight:700;margin-right:10px">애니톡 캠퍼스</span>` +
    SIBLINGS.map(
      ([label, href]) =>
        `<a href="${href}" target="_blank" rel="noopener" style="color:#9A9A9A;margin-right:14px">${label}</a>`
    ).join('') +
    `</div>`;
  seo(
    /(<div style="font-size:12px;color:#5A5A5A;margin-top:18px">© 2026\. ANITALK ILSAN)/,
    (_, a) => campusRow + a
  );
}

// Red text on the dark sections. The base red is a fill colour — it works under white
// type in the header and buttons — but as type on a near-black panel it lands at 2.5:1
// where WCAG AA asks for 4.5:1, and darkening the brand red made that worse. Measured
// on the live page: 22 such elements on dark, all failing; one on white (the header
// CTA) at 6.5:1, which is correct and must not change. #FF3B45 is the on-dark variant
// the bundle already uses for the hero headline, and it reaches 4.7:1 here.
let recontrasted = 0;
template = template.replace(/style="([^"]*)"/g, (whole, style) => {
  if (!/color:#BD0D16/i.test(style)) return whole;
  if (/background:#FFFFFF/i.test(style)) return whole; // red on white: already fine
  recontrasted++;
  return 'style="' + style.replace(/color:#BD0D16/gi, 'color:#FF3B45') + '"';
});
// The cards under 수업과목 are built by React.createElement, so their colours live in
// JS object literals rather than a style attribute and the pass above never sees them
// — which is most of the failures, since one literal renders many labels. Only the
// text colour is switched; `background: '#BD0D16'` stays a fill.
template = template.replace(/color: '#BD0D16'/g, () => {
  recontrasted++;
  return "color: '#FF3B45'";
});

// ── Mobile menu ──
// The bundle hides `header nav` below 860px and styles a `[data-mobilenav]` button to
// take its place, but never ships that button — so on a phone there is no menu at
// all. Measured on the live page: of ten sections, eight (about, college, both
// galleries, process, faq, stories, visit) had no visible link pointing at them. The
// only way to reach them was to scroll the full 19,000px.
//
// The panel reuses the header's own nav links rather than a second hand-kept list, so
// the two cannot drift apart.
const navLinks = [...template.matchAll(/<a href="([^"]+)" data-nav="1"[^>]*>([^<]+)<\/a>/g)].map((m) => ({
  href: m[1],
  label: m[2],
}));

if (navLinks.length) {
  const items = navLinks
    .map(
      (l) =>
        `<a href="${l.href}" data-menuitem="1" style="display:flex;align-items:center;justify-content:space-between;` +
        `padding:17px 4px;font-size:17px;font-weight:700;color:#FFFFFF;border-bottom:1px solid #232326">` +
        `${l.label}<span aria-hidden="true" style="color:#8C8C8C">→</span></a>`
    )
    .join('');

  const button =
    `<button type="button" data-mobilenav="1" aria-label="메뉴 열기" aria-expanded="false" aria-controls="mobile-menu" ` +
    `style="display:none;align-items:center;justify-content:center;width:44px;height:44px;flex:0 0 auto;` +
    `background:transparent;border:0;padding:0;cursor:pointer">` +
    `<span aria-hidden="true" style="display:block;width:22px;height:2px;background:#FFFFFF;box-shadow:0 -7px 0 #FFFFFF,0 7px 0 #FFFFFF"></span>` +
    `</button>`;

  // Placed after the CTA so the tap order reads logo → book → menu.
  seo(/(<\/div>\s*<\/header>)/, (_, close) => button + close);

  const panel =
    // Visibility is driven by CSS keyed off an attribute on <html>, not by an inline
    // style or the hidden attribute. The dc renderer strips boolean attributes when it
    // processes the template, and re-applies the template's inline style on every
    // re-render — a panel opened by mutating style.display closed itself moments later.
    // <html> sits outside the tree it manages, so an attribute there survives.
    `<div id="mobile-menu" data-menupanel="1" style="position:fixed;inset:0;z-index:90;background:rgba(0,0,0,.72)">` +
    `<div data-menusheet="1" style="position:absolute;top:0;right:0;bottom:0;width:min(320px,86vw);background:#0B0B0D;` +
    `border-left:1px solid #232326;padding:18px 22px 34px;overflow-y:auto">` +
    `<div style="display:flex;align-items:center;justify-content:space-between;height:46px;margin-bottom:12px">` +
    `<span style="font-size:12px;font-weight:800;letter-spacing:.18em;color:#8C8C8C">MENU</span>` +
    `<button type="button" data-menuclose="1" aria-label="메뉴 닫기" style="width:44px;height:44px;background:transparent;border:0;color:#FFFFFF;font-size:26px;line-height:1;cursor:pointer">&times;</button>` +
    `</div>` +
    items +
    `<a href="{{ bookingUrl }}" target="_blank" rel="noopener" data-cta="booking" data-loc="mobile-menu" ` +
    `style="display:block;margin-top:24px;padding:16px;text-align:center;background:${hex(RED.to).toUpperCase()};color:#FFFFFF;` +
    `font-size:16px;font-weight:800;border-radius:999px">네이버 예약 상담 신청 →</a>` +
    `<a href="tel:031-994-3134" data-cta="tel" data-loc="mobile-menu" ` +
    `style="display:block;margin-top:10px;padding:16px;text-align:center;border:1px solid rgba(255,255,255,.3);` +
    `color:#FFFFFF;font-size:16px;font-weight:700;border-radius:999px">031-994-3134</a>` +
    `</div></div>`;

  seo(/(<aside data-rail="1")/, (_, a) => panel + '\n  ' + a);

  // Anchors inside the panel must close it before the page scrolls, or the sheet
  // covers the section the reader just asked for. Same reason as the class bar's
  // handler, this sits outside the tree React renders.
  // Delegated from document, and the panel is resolved per event rather than once at
  // load: the dc renderer builds this markup after inline scripts run, so anything
  // that looks the elements up front finds nothing and silently never binds.
  // Delegated from document and keyed off <html>: the dc renderer builds this markup
  // after inline scripts run, so anything resolving the elements up front binds to
  // nothing, and it rewrites inline styles on re-render, so the open state cannot live
  // on the panel itself.
  const menuScript =
    '<script>(function(){' +
    'var R=document.documentElement;' +
    'function isOpen(){return R.hasAttribute("data-menu-open")}' +
    'function open(v){' +
    'if(v){R.setAttribute("data-menu-open","1")}else{R.removeAttribute("data-menu-open")}' +
    'var b=document.querySelector("[data-mobilenav]");' +
    'if(b){b.setAttribute("aria-expanded",v?"true":"false");' +
    'b.setAttribute("aria-label",v?"메뉴 닫기":"메뉴 열기");}' +
    'document.body.style.overflow=v?"hidden":"";}' +
    'document.addEventListener("click",function(e){' +
    'var t=e.target&&e.target.closest?e.target:null;if(!t)return;' +
    'if(t.closest("[data-mobilenav]")){e.preventDefault();open(!isOpen());return}' +
    'if(t.closest("[data-menuclose]")){e.preventDefault();open(false);return}' +
    'if(!isOpen())return;' +
    'var p=document.querySelector("[data-menupanel]");if(!p)return;' +
    'if(t===p){open(false);return}' +
    'var a=t.closest("a");if(!a||!p.contains(a))return;' +
    'var h=a.getAttribute("href")||"";' +
    'if(h.charAt(0)!=="#"){open(false);return}' +
    'e.preventDefault();open(false);' +
    'var el=document.querySelector(h);if(!el)return;' +
    'var y=0,n=el;while(n){y+=n.offsetTop;n=n.offsetParent;}' +
    'window.scrollTo({top:y-70,behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth"});' +
    '},true);' +
    'document.addEventListener("keydown",function(e){if(e.key==="Escape"&&isOpen())open(false)});' +
    '})();</' +
    'script>';
  seo(/<\/body>/, () => menuScript + '</body>');
}

// ── Mobile fixes ──
// The bundle ships the pre-fix markup the previous hand-built site had already
// moved past: the side rail is just hidden below 860px instead of becoming a bottom
// bar, the about section keeps two photo columns on a phone, and the header lets its
// CTA run off the right edge. Measured at 390px: the header needs 435px of content
// in a 342px box, so the booking button is clipped by ~93px. Re-applied here so the
// fixes survive every rebuild from the bundle.

// The school asked for the English name to go, so it is removed outright rather
// than hidden at a breakpoint.
seo(
  /<span style="font-size:9px;font-weight:700;letter-spacing:\.08em;opacity:\.86">ANIMATION CARTOON PROFESSIONAL SCHOOL<\/span>\s*/,
  () => ''
);
// Dropping the English does not reclaim any width — the 18px Korean name is what
// measures 231px — so the logo and CTA still need to shrink on narrow phones. Tag
// them; inline styles need a selector and !important to be overridden.
seo(/(<a href="#top" style="display:flex;align-items:center;gap:11px;color:#FFFFFF")/, (_, a) =>
  a.replace('<a ', '<a data-hlogo="1" ') + ' '
);
seo(/(<img src="[^"]*" alt="일산애니톡 만화학원")/, (_, a) => a.replace('<img ', '<img data-hlogoimg="1" '));
seo(/(<span style="font-size:18px;font-weight:800;letter-spacing:-\.02em">)/, (_, a) =>
  a.replace('<span ', '<span data-hlogoko="1" ')
);
seo(/(<a href="\{\{ bookingUrl \}\}" target="_blank" rel="noopener")/, (_, a) =>
  a + ' data-hcta="1"'
);
// The hero photo has a lit banner across the middle of the frame and the only scrim
// over it runs left-to-right — opaque at the left edge, fully transparent by the
// right. On desktop the headline sits in the dark left third. On a phone it spans
// the full width and lands on the clear side, right over the banner, where the
// on-dark red of the second line disappears into it.
seo(
  /(<div style="position:absolute;inset:0;background:linear-gradient\(90deg, rgba\(0,0,0,\.72\))/,
  (_, a) => a.replace('<div ', '<div data-heroscrim="1" ')
);
seo(/(<div style="max-width:1200px;margin:0 auto;display:grid;grid-template-columns:1\.05fr \.95fr)/, (_, a) =>
  a.replace('<div ', '<div data-aboutgrid="1" ')
);
seo(/(<div style="display:grid;grid-template-columns:1fr 1fr;grid-template-rows:auto auto;gap:14px")/, (_, a) =>
  a.replace('<div ', '<div data-aboutpics="1" ')
);
// The two hero buttons are inline-flex in a wrapping row. At 390px they add up to
// more than the line, so they wrap to two rows of different widths; stacked
// full-width reads cleaner and gives a bigger tap target.
seo(/(<div data-reveal="240" style="display:flex;flex-wrap:wrap;gap:12px;margin-top:32px")/, (_, a) =>
  a.replace('<div ', '<div data-herocta="1" ')
);

// 히어로 첫 줄의 등록번호 배지를 걷어낸다. 첫 화면에서 제일 먼저 읽히는 자리인데
// 학원을 고르는 사람이 가장 늦게 확인하는 정보였다. 같은 문구가 학원 소개의
// 배지와 푸터 사업자정보 줄에 이미 두 번 더 있어, 여기서 빼도 사라지지 않는다.
seo(
  /<div data-pill="1" data-reveal="0" style="[^"]*">고양교육지원청 등록 제6164호 · 교과과목 만화<\/div>\s*/,
  () => ''
);

// 폰에서 문구를 아래로 내리기 위한 표식. 사진 가운데에 ANITALK 간판이 있는데
// 제목이 세로 가운데 정렬이라 간판 글씨를 정확히 덮고 있었다.
seo(
  /(<div style="position:relative;max-width:1400px;margin:0 auto;height:100%;padding:0 clamp\(20px,4vw,56px\);display:flex;flex-direction:column;justify-content:center")/,
  (_, a) => a.replace('<div ', '<div data-heroin="1" ')
);

// ── 2027 수시 합격 (2026-11-06 발표) ──
// 청강대 실기 지원 15명 중 3명 합격. 이름은 기존 명단과 같이 가운데 글자를 가린다.
// 문구는 생성물마다 같은 자리에 두 번 이상 나오므로(메타·구조화 데이터·본문)
// 전부 바꾸고, 하나도 못 찾으면 빌드를 멈춘다 — 번들 문구가 바뀌면 조용히
// 2026 으로 남는 것을 막는다.
const swapAll = (from, to) => {
  const n = template.split(from).length - 1;
  if (!n) {
    console.error(`2027 합격 패치: "${from}" 을 찾지 못했다`);
    process.exit(1);
  }
  template = template.split(from).join(to);
  seoEdits += n;
};
swapAll(
  'const PASS = [\n',
  'const PASS = [\n' +
    "  ['2027', '청강문화산업대학교 애니메이션스쿨', '이 · 정', '저현고'],\n" +
    "  ['2027', '청강문화산업대학교 웹툰만화콘텐츠전공', '이 · 진', '덕이고'],\n" +
    "  ['2027', '청강문화산업대학교 웹툰만화콘텐츠전공', '김 · 빈', '한빛고'],\n"
);
swapAll('2024 · 2025 · 2026학년도 일산 캠퍼스 실적입니다', '2024 ~ 2027학년도 일산 캠퍼스 실적입니다');
swapAll(
  '2026학년도에 청강문화산업대학교 게임스쿨, ',
  '2027학년도 수시에서 청강문화산업대학교 애니메이션스쿨과 웹툰만화콘텐츠전공에 3명이 합격했습니다. ' +
    '2026학년도에는 청강문화산업대학교 게임스쿨, '
);
swapAll(
  '2026학년도 청강대 게임스쿨·상명대·명지대·계원예대 합격.',
  '2027 수시 청강대 3명 합격, 2026학년도 상명대·명지대·계원예대 합격.'
);
swapAll('2026 합격생 명단 보러가기 →', '2027 합격생 명단 보러가기 →');

// ── 2027 한국애니고 만화과 합격 (학원 확인 2026-11-15: 1명 지원 1명 합격) ──
// 이름 표기는 학원 블로그 인터뷰(이ㅇ교)를 따른다. 출신 중학교는 학원이 공개하지
// 않아 비워 두고, 명단 한 줄이 "이름 ()" 로 찍히지 않게 학교가 없으면 괄호를 뺀다.
{
  const one = (from, to, want) => {
    const n = template.split(from).length - 1;
    if (n !== want) {
      console.error(`2027 애니고 패치: "${from.slice(0, 40)}" 을 ${n}곳 찾았다 (${want}곳이어야 한다)`);
      process.exit(1);
    }
    template = template.split(from).join(to);
  };
  const LAST_2027 = "  ['2027', '청강문화산업대학교 웹툰만화콘텐츠전공', '김 · 빈', '한빛고'],\n";
  one(LAST_2027, LAST_2027 + "  ['2027', '한국애니고 만화과', '이 · 교', ''],\n", 1);
  one("name + ' (' + hs + ')'", "name + (hs ? ' (' + hs + ')' : '')", 1);
  one('2026 한국애니고 2명<br>', '2027 한국애니고 1명<br>2026 한국애니고 2명<br>', 1);
  one(
    '강원애니고의 실기와 면접까지 준비합니다. 중학교 3학년 대상 과정입니다.',
    '강원애니고의 실기와 면접까지 준비합니다. 중학교 3학년 대상 과정입니다. 2027학년도에는 한국애니고 만화과에 1명이 지원해 합격했습니다.',
    2
  );
}

// ── 2027 경기대 · 상명대 · 서울웹툰애니고 합격 (학원 전달 2026-11-27) ──
// 이름과 출신 학교는 받지 않아 비워 둔다(학원 요청: 학교명만). 위 묶음에서 학교가
// 없으면 괄호를 빼도록 고쳐 두었으므로, 이름까지 비면 줄에는 학교·학과만 남는다.
// 인원은 학교마다 1명으로 전달받았다.
{
  const one = (from, to, want) => {
    const n = template.split(from).length - 1;
    if (n !== want) {
      console.error(`2027 추가 합격 패치: "${from.slice(0, 40)}" 을 ${n}곳 찾았다 (${want}곳이어야 한다)`);
      process.exit(1);
    }
    template = template.split(from).join(to);
    seoEdits += n;
  };
  const ANIGO_2027 = "  ['2027', '한국애니고 만화과', '이 · 교', ''],\n";
  one(
    ANIGO_2027,
    ANIGO_2027 +
      "  ['2027', '경기대학교 애니메이션과', '', ''],\n" +
      "  ['2027', '상명대학교 디지털만화영상', '', ''],\n" +
      "  ['2027', '서울웹툰애니고', '', ''],\n",
    1
  );
  // 이름이 비면 오른쪽 칸이 빈 span 으로 남는다. 줄 모양이 흐트러지지 않게 그대로 둔다.
  one('2027 한국애니고 1명<br>', '2027 한국애니고 1명<br>2027 서울웹툰애니고 1명<br>', 1);
  // 질문 답은 화면 한 번, FAQPage 구조화 데이터 한 번 — 같은 문장을 같이 고친다.
  one(
    '2027학년도 수시에서 청강문화산업대학교 애니메이션스쿨과 웹툰만화콘텐츠전공에 3명이 합격했습니다.',
    '2027학년도 수시에서 청강문화산업대학교 애니메이션스쿨과 웹툰만화콘텐츠전공에 3명, ' +
      '경기대학교 애니메이션과와 상명대학교 디지털만화영상에 각 1명이 합격했습니다.',
    2
  );
  one(
    '2027학년도에는 한국애니고 만화과에 1명이 지원해 합격했습니다.',
    '2027학년도에는 한국애니고 만화과에 1명이 지원해 합격했고, 서울웹툰애니고에도 1명이 합격했습니다.',
    2
  );
  // 메타 설명(검색 결과 문구). 몇 곳에 있든 같은 문장이므로 전부 바꾸되 0곳이면 멈춘다.
  const META_FROM = '2027 수시 청강대 3명 합격, 2026학년도 상명대·명지대·계원예대 합격.';
  const metaN = template.split(META_FROM).length - 1;
  if (!metaN) {
    console.error('2027 추가 합격 패치: 메타 설명 문장을 찾지 못했다');
    process.exit(1);
  }
  template = template.split(META_FROM).join('2027 수시 청강대 3명 · 경기대 · 상명대 합격, 2026학년도 명지대 · 계원예대 합격.');
  seoEdits += metaN;
  console.log(`pass 2027    ${String(3).padStart(6)}     경기대 · 상명대 · 서울웹툰애니고 (메타 ${metaN}곳)`);
}

// ── 히어로 1번 슬라이드: 2027 수시 청강대 합격 ──
// 첫 화면에 합격 소식을 먼저 보여 주고, 8초 뒤 원래 히어로(학원 사진 + 제목)로
// 넘어간다. 원래 히어로 위에 겹친 층이라 h1 과 사진은 그대로 문서에 남는다.
// 어느 슬라이드인지는 <html data-hs> 에 둔다 — 인라인 스타일로 바꾸면 재렌더링이
// 템플릿 값으로 되돌린다. 스크립트가 없으면 이 슬라이드가 그대로 보인다.
//
// 처음엔 통이미지 한 장으로 구웠는데, 화면 비율이 이미지와 다르면 object-fit 이
// 아래위를 잘라 문구가 사라졌다. 글자는 HTML 로 두고 사진만 이미지로 쓴다.
// 오른쪽 세 기둥은 합격생 재현작이다(원본에서 블러가 없는 왼쪽 절반).
const HX_ROWS = [
  ['애니메이션스쿨', '이 · 정', '저현고'],
  ['웹툰만화콘텐츠전공', '이 · 진', '덕이고'],
  ['웹툰만화콘텐츠전공', '김 · 빈', '한빛고'],
];
const HX_WORKS = [
  ['k', '웹툰과 칸만화', '김 · 빈', '2027 청강대 웹툰과 합격 재현작'],
  ['j', '웹툰과 칸만화', '이 · 진', '2027 청강대 웹툰과 합격 재현작'],
  ['a', '애니과 상황표현', '이 · 정', '2027 청강대 애니메이션스쿨 합격 재현작'],
];
const heroSlide =
  '<a data-heroslide="1" data-noreveal="1" href="#pass-list" aria-label="2027 수시 청강대 3명 합격 — 합격생 명단 보기">' +
  '<span data-hx="works">' +
  HX_WORKS.map(
    ([f, cap, nm, alt], i) =>
      `<span data-hx="w" style="--i:${i}"><img src="/gal/hero27/${f}.webp" alt="${alt}" decoding="async"${i ? '' : ' fetchpriority="high"'}>` +
      `<span data-hx="cap"><small>${cap}</small>${nm}</span></span>`
  ).join('') +
  '</span>' +
  '<span data-hx="copy">' +
  '<span data-hx="kick"><i></i>2027학년도 수시 · 청강문화산업대학교</span>' +
  '<span data-hx="l"><span style="--i:0">일산애니톡 단독 합격</span></span>' +
  '<span data-hx="big"><span style="--i:1">청강대 <b>3</b>명</span></span>' +
  '<span data-hx="rows">' +
  HX_ROWS.map(
    ([d, n, s], i) => `<span data-hx="r" style="--i:${i}"><em>${d}</em><strong>${n}</strong><span>${s}</span></span>`
  ).join('') +
  '</span>' +
  '<span data-hx="more">전체 합격 명단 보기 <i aria-hidden="true">→</i></span>' +
  '</span>' +
  '</a>' +
  '<div data-herodots="1" data-noreveal="1" role="group" aria-label="첫 화면 슬라이드">' +
  '<button type="button" data-herodot="0" aria-label="2027 청강대 합격 소식"></button>' +
  '<button type="button" data-herodot="1" aria-label="학원 소개"></button>' +
  '</div>';
// ── 상담 · 설명회 동선 (2026-11-27 전환 개선) ──
// 첫 화면에 예약 버튼이 하나도 없었다. 원래 히어로의 예약 · 전화 버튼은 아래에서
// 일부러 걷어 냈고(같은 버튼이 상단바 · 하단바에 있다는 이유), 그 위를 합격 슬라이드가
// 덮고 있어 광고로 들어온 사람이 처음 보는 화면에 '무엇을 하면 되는지' 가 없었다.
// 이번에는 같은 예약 버튼을 되살리는 대신 지금 이 학원이 받고 싶은 두 행동을 건다:
// 12/13 입시설명회 신청(1차)과 무료 체험 신청(2차).
//
// 버튼 줄은 두 슬라이드 위에 함께 뜨도록 슬라이드와 형제로 둔다. 합격 슬라이드는
// 통째로 <a> 라 그 안에 링크를 넣을 수 없다(a 안의 a).
const escHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const seminarOn = Date.now() <= Date.parse(SEMINAR.until);
if (!seminarOn) console.log('seminar      (skipped)     ' + SEMINAR.until + ' 이 지났다');
const SEM_ATTR = 'data-seminarlink="1"';
const heroBar =
  '<div data-herobar="1" data-noreveal="1">' +
  (seminarOn
    ? `<a href="#seminar" ${SEM_ATTR} data-cta="seminar" data-loc="hero" data-hb="pri">` +
      `${escHtml(SEMINAR.dateLabel.replace(/\(.\)$/, ''))} 입시설명회 신청</a>`
    : '') +
  `<a href="{{ bookingUrl }}" target="_blank" rel="noopener" data-cta="trial" data-loc="hero" data-hb="${seminarOn ? 'sub' : 'pri'}">` +
  '무료 체험 신청<small>고등반 2회 · 주니어 · 취미반 1회</small></a>' +
  '</div>';

// 설명회 칸. 원장님이 아직 채우지 않은 값은 줄째로 뺀다.
const seminarInfo = (t) => {
  const rows = [
    ['일시', SEMINAR.dateLabel + (t.time ? ' ' + t.time : '')],
    t.place ? ['장소', t.place] : null,
    t.seats ? ['정원', t.seats + '명 (선착순)'] : null,
  ].filter(Boolean);
  const pending = !t.time || !t.place;
  return (
    '<dl style="margin:22px 0 0;padding:0;border-top:1px solid rgba(255,255,255,.1)">' +
    rows
      .map(
        ([k, v]) =>
          '<div style="display:flex;gap:16px;padding:13px 0;border-bottom:1px solid rgba(255,255,255,.08);font-size:15px">' +
          `<dt style="flex:0 0 44px;margin:0;color:#8C8C8C;font-weight:600">${k}</dt>` +
          `<dd style="margin:0;font-weight:700;word-break:keep-all">${escHtml(v)}</dd></div>`
      )
      .join('') +
    '</dl>' +
    (pending
      ? '<p style="margin:14px 0 0;font-size:13px;color:#9A9A9A;word-break:keep-all">' +
        '세부 시간과 장소는 신청하신 분께 따로 안내드립니다.</p>'
      : '')
  );
};
const seminarCard = (t, i) =>
  '<div style="background:#1A1A1D;border:1px solid rgba(255,255,255,.08);border-radius:16px;' +
  'padding:clamp(24px,3vw,34px);display:flex;flex-direction:column;text-align:left">' +
  `<div style="font-size:12px;font-weight:800;letter-spacing:.16em;color:#FF3B45">TRACK 0${i + 1}</div>` +
  `<h3 style="margin:12px 0 0;font-size:clamp(21px,2.2vw,26px);font-weight:800;letter-spacing:-.04em;line-height:1.3;word-break:keep-all">${escHtml(t.title)}</h3>` +
  `<p style="margin:10px 0 0;font-size:15px;line-height:1.7;color:#C9C9C9;word-break:keep-all">${escHtml(t.topic)}</p>` +
  seminarInfo(t) +
  // 두 카드의 버튼 높이를 맞추려고 남는 세로 공간을 버튼 위에 몰아 준다.
  '<div style="margin-top:auto;padding-top:26px">' +
  `<a href="${t.url ? escHtml(t.url) : '{{ bookingUrl }}'}" target="_blank" rel="noopener" ` +
  `data-cta="seminar" data-loc="seminar-${t.key}" ` +
  'style="display:inline-flex;align-items:center;gap:8px;padding:14px 26px;background:#BD0D16;color:#FFFFFF;' +
  'font-size:15px;font-weight:800;border-radius:999px;text-decoration:none">설명회 신청하기 →</a>' +
  '</div></div>';
const seminarSection = !seminarOn
  ? ''
  : '<section id="seminar" data-seminar="1" style="scroll-margin-top:72px;background:#0F0F11;' +
    'padding:clamp(84px,10vw,140px) clamp(20px,4vw,48px)">' +
    '<div style="max-width:1200px;margin:0 auto">' +
    '<div style="font-size:12px;font-weight:600;letter-spacing:.22em;text-transform:uppercase;color:#8C8C8C">Admission Briefing</div>' +
    `<h2 style="margin:14px 0 0;font-size:clamp(26px,3vw,36px);letter-spacing:-.04em;font-weight:800;word-break:keep-all">${escHtml(SEMINAR.dateLabel)} 입시설명회</h2>` +
    '<p style="margin:14px 0 0;font-size:15px;line-height:1.7;color:#9A9A9A;word-break:keep-all">' +
    '준비하는 시험이 달라 두 개 설명회로 나눠 진행합니다. 학년에 맞는 쪽으로 신청해 주세요.</p>' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:16px;margin-top:40px">' +
    SEMINAR.tracks.map(seminarCard).join('') +
    '</div>' +
    `<p style="margin:28px 0 0;font-size:14px;color:#9A9A9A;word-break:keep-all">${escHtml(TRIAL_NOTE)} — 설명회와 별도로 언제든 신청하실 수 있습니다.</p>` +
    '</div></section>';

// 수업과목을 다 읽은 자리에 상담 띠를 하나 둔다. 히어로 다음 예약 버튼까지
// 약 9,500px 이 비어 있었다(실측: 문서 높이 14,286px 중 1,017~10,504px).
const midBand =
  '<section data-midcta="1" style="background:#BD0D16;padding:clamp(52px,6vw,76px) clamp(20px,4vw,48px)">' +
  '<div style="max-width:1200px;margin:0 auto;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:24px 40px">' +
  '<div style="flex:1 1 420px;min-width:0;text-align:left">' +
  '<div style="font-size:clamp(22px,2.4vw,30px);font-weight:800;letter-spacing:-.04em;line-height:1.35;word-break:keep-all">' +
  '어느 반이 맞을지, 수업으로 먼저 확인해 보세요</div>' +
  `<p style="margin:10px 0 0;font-size:15px;color:rgba(255,255,255,.88);word-break:keep-all">${escHtml(TRIAL_NOTE)}</p>` +
  '</div>' +
  '<div style="display:flex;flex-wrap:wrap;gap:10px">' +
  '<a href="{{ bookingUrl }}" target="_blank" rel="noopener" data-cta="trial" data-loc="classes-band" ' +
  'style="display:inline-flex;align-items:center;padding:15px 28px;background:#FFFFFF;color:#BD0D16;font-size:15px;font-weight:800;border-radius:999px;text-decoration:none">무료 체험 신청 →</a>' +
  (seminarOn
    ? `<a href="#seminar" ${SEM_ATTR} data-cta="seminar" data-loc="classes-band" ` +
      'style="display:inline-flex;align-items:center;padding:15px 28px;border:1px solid rgba(255,255,255,.7);color:#FFFFFF;font-size:15px;font-weight:700;border-radius:999px;text-decoration:none">' +
      `${escHtml(SEMINAR.dateLabel)} 입시설명회</a>`
    : '') +
  '</div></div></section>';

seo(/(<section id="top" style="[^"]*">)/, (_, a) => a + '\n    ' + heroSlide + heroBar);
seo(
  /<div (style="position:absolute;bottom:26px;left:50%;transform:translateX\(-50%\);width:22px;height:34px;)/,
  (_, s) => '<div data-scrollhint="1" ' + s
);
if (seminarOn) {
  // #top 이 닫히는 자리 바로 뒤. 히어로 안에는 다른 section 이 없다.
  const topAt = template.indexOf('<section id="top"');
  const topEnd = template.indexOf('</section>', topAt);
  if (topAt < 0 || topEnd < 0) throw new Error('설명회: 히어로 끝을 찾지 못했다');
  template = template.slice(0, topEnd + 10) + '\n\n  ' + seminarSection + template.slice(topEnd + 10);
  seoEdits++;
}
seo(/(\{\{ classGroups \}\}\s*<\/div>\s*<\/section>)/, (_, a) => a + '\n\n  ' + midBand);

// 버튼 줄 모양. 인라인 스타일이 아니라 머리말의 규칙으로 준다 — 이 줄은 React 가
// 다시 그리는 트리 안에 있어 인라인 값은 재렌더링 때 템플릿 값으로 되돌아간다.
// 아래끝은 '히어로가 화면보다 긴 만큼' 을 더해 올린다. 1920x1080 에서 히어로가
// 화면 아래로 21px 넘쳐, 바닥에 붙인 것들이 그만큼 잘려 보였다.
const OVERHANG = 'max(0px, 100% + 64px - 100vh)';
const heroBarCss =
  '<style>' +
  `[data-herobar]{position:absolute;z-index:5;left:calc(max(0px,(100% - 1400px)/2) + clamp(20px,4vw,56px));bottom:calc(92px + ${OVERHANG});` +
  'display:flex;flex-wrap:wrap;gap:10px}' +
  '[data-herobar] a{display:inline-flex;flex-direction:column;align-items:center;justify-content:center;min-height:54px;padding:8px 26px;' +
  'border-radius:999px;font-size:16px;font-weight:800;letter-spacing:-.02em;line-height:1.2;text-decoration:none;white-space:nowrap;' +
  'transition:background .3s ease,color .3s ease,border-color .3s ease}' +
  '[data-herobar] small{display:block;margin-top:3px;font-size:11.5px;font-weight:600;opacity:.82;letter-spacing:0}' +
  '[data-herobar] [data-hb=pri]{background:#BD0D16;color:#FFFFFF;border:1px solid #BD0D16;box-shadow:0 10px 30px rgba(189,13,22,.38)}' +
  '[data-herobar] [data-hb=pri]:hover{background:#FFFFFF;color:#BD0D16;border-color:#FFFFFF}' +
  '[data-herobar] [data-hb=sub]{background:rgba(11,11,12,.55);color:#FFFFFF;border:1px solid rgba(255,255,255,.55);' +
  '-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}' +
  '[data-herobar] [data-hb=sub]:hover{background:#FFFFFF;color:#111111;border-color:#FFFFFF}' +
  `[data-heroslide] [data-hx=cap]{bottom:calc(30px + ${OVERHANG})}` +
  // 합격 슬라이드 문구는 세로 가운데 정렬이라, 1280x800 에서는 '전체 합격 명단 보기'
  // (666~682px)가 버튼 줄(654~708px)과 겹쳤다. 버튼 줄 몫만큼 아래를 비워 위로 올린다.
  // (padding 의 % 는 높이가 아니라 폭 기준이라 OVERHANG 을 여기 쓰면 안 된다.)
  '[data-heroslide] [data-hx=copy]{padding-bottom:150px}' +
  `[data-herodots]{bottom:calc(40px + ${OVERHANG})}` +
  // 폰: 히어로가 620px 로 고정되고 원래 히어로 문구가 560px 근처에서 끝난다.
  // 두 버튼을 한 줄로 나눠 그 아래, 슬라이드 점 위에 둔다.
  '@media (max-width: 760px){' +
  '[data-herobar]{left:16px;right:16px;bottom:58px;flex-wrap:nowrap;gap:8px}' +
  // !important: 페이지의 다른 규칙이 이 링크들에 flex:0 0 auto 를 걸어 두 버튼 폭이
  // 글자 길이대로(168 / 150px) 달라졌다.
  '[data-herobar] a{flex:1 1 0!important;min-width:0;min-height:52px;padding:6px 8px;font-size:14.5px;white-space:normal;text-align:center}' +
  '[data-herobar] small{font-size:10.5px;margin-top:2px}' +
  '[data-herodots]{bottom:18px}' +
  // 히어로 바닥 가운데의 '스크롤' 마우스 모양이 버튼 줄 바로 아래에 붙는다. 폰에서는
  // 버튼 줄이 그 역할(아래에 더 있다)을 대신하므로 뺀다.
  '[data-scrollhint]{display:none!important}' +
  '}' +
  // 설명회 날짜가 지나면 페이지가 스스로 설명회 칸과 링크를 숨긴다(재배포를 놓쳐도).
  'html[data-seminar-over] [data-seminar],html[data-seminar-over] [data-seminarlink]{display:none!important}' +
  // 설명회 버튼이 빠지면 무료 체험이 혼자 남으므로 보조 모양 대신 주 버튼 모양으로 바꾼다.
  'html[data-seminar-over] [data-herobar] [data-hb=sub]{background:#BD0D16;border-color:#BD0D16;box-shadow:0 10px 30px rgba(189,13,22,.38)}' +
  '</style>';
seo(/<\/head>/i, () => heroBarCss + '</head>');
if (seminarOn) {
  const overScript =
    '<script>if(Date.now()>Date.parse("' + SEMINAR.until + '"))' +
    'document.documentElement.setAttribute("data-seminar-over","1");</' +
    'script>';
  // 머리말에서 바로 돌려 첫 화면부터 숨긴다. <html> 속성이라 재렌더링이 지우지 못한다.
  seo(/<\/head>/i, () => overScript + '</head>');
  const empty = SEMINAR.tracks.flatMap((t) =>
    ['time', 'place', 'seats', 'url'].filter((k) => !t[k]).map((k) => `${t.key}.${k}`)
  );
  console.log('seminar      ' + String(SEMINAR.tracks.length).padStart(6) + '     ' +
    (empty.length ? '아직 빈 칸: ' + empty.join(' ') : '전부 채워짐'));
}
// 모션: 슬라이드가 다시 앞으로 올 때마다 처음부터 다시 돈다. 애니메이션 규칙을
// html:not([data-hs="1"]) 아래에만 두었기 때문에, 속성이 지워지는 순간 새로 걸린다.
// 기본 상태가 '다 나타난 상태' 라서 모션을 끈 사람에게도 내용은 전부 보인다.
const HX_ON = 'html:not([data-hs="1"]) [data-heroslide] ';
const EASE = 'cubic-bezier(.16,1,.3,1)';
const heroSlideCss =
  '<style>' +
  '[data-heroslide]{position:absolute;inset:0;z-index:3;display:block;overflow:hidden;background:#0B0B0C;color:#FFFFFF;' +
  'text-decoration:none;word-break:keep-all;transition:opacity .9s ease,visibility 0s linear 0s}' +
  // 사이트 전역의 a:hover(진한 빨강 + 밑줄)가 슬라이드 전체 글자를 물들였다.
  // 슬라이드 전체가 링크라 어디에 마우스를 올려도 걸린다. 흰색으로 고정한다.
  '[data-heroslide]:hover,[data-heroslide]:focus{color:#FFFFFF;text-decoration:none}' +
  'html[data-hs="1"] [data-heroslide]{opacity:0;visibility:hidden;transition:opacity .9s ease,visibility 0s linear .9s}' +
  // 페이지의 자동 등장 효과(autoTag)는 data-noreveal 로 이 층을 건너뛴다. 그걸
  // 빼면 그 효과가 인라인 opacity:0 을 걸어 첫 순간 원래 히어로가 비쳐 보인다.
  ':where([data-heroslide] span){display:block}' +
  // 오른쪽 작품 기둥
  '[data-hx=works]{position:absolute;top:0;right:0;bottom:0;width:54%;display:grid;grid-template-columns:repeat(3,1fr);gap:3px;background:#0B0B0C}' +
  '[data-hx=w]{position:relative;overflow:hidden;background:#161618}' +
  '[data-hx=w] img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 30%;transform:scale(1.08)}' +
  '[data-hx=w]::after{content:"";position:absolute;inset:auto 0 0 0;height:42%;background:linear-gradient(180deg,rgba(11,11,12,0),rgba(11,11,12,.86))}' +
  '[data-hx=cap]{position:absolute;z-index:1;left:22px;right:18px;bottom:30px;font-size:17px;font-weight:800;letter-spacing:-.02em}' +
  '[data-hx=cap] small{display:block;margin-bottom:6px;font-size:11px;font-weight:700;letter-spacing:.16em;color:#FF3B45}' +
  // 왼쪽 문구 — 원래 히어로 문구와 같은 줄에 맞춘다
  '[data-hx=copy]{position:absolute;top:0;bottom:0;left:calc(max(0px,(100% - 1400px)/2) + clamp(20px,4vw,56px));width:40%;' +
  'display:flex!important;flex-direction:column;justify-content:center}' +
  '[data-hx=kick]{display:flex!important;align-items:center;gap:14px;font-size:13px;font-weight:700;letter-spacing:.16em;color:#B4B4BA}' +
  '[data-hx=kick] i{display:block;width:44px;height:2px;background:#FF3B45;transform-origin:left}' +
  '[data-hx=l],[data-hx=big]{overflow:hidden;padding-bottom:.06em}' +
  '[data-hx=l]{margin-top:30px;font-size:clamp(22px,2.2vw,30px);font-weight:700;letter-spacing:-.03em;line-height:1.3}' +
  // 글자 크기는 '왼쪽 여백 끝 ~ 작품 기둥 시작' 사이에 들어가는 만큼으로 정한다.
  // 예전 값 9.2vw(최대 148px)는 1920px 에서 '청강대 3명' 이 768px 로 그려져, 46%
  // 지점(883px)에서 시작하는 작품 사진 밑으로 '명' 이 200px 가량 들어갔다.
  // 5.3 은 이 문구의 글자 폭 대 글자 크기 비(실측 5.19)에 여유를 둔 값이다.
  '[data-hx=big]{margin-top:6px;font-size:clamp(52px,calc((46vw - max(0px,(100vw - 1400px)/2) - clamp(20px,4vw,56px) - 48px) / 5.3),148px);' +
  'font-weight:800;letter-spacing:-.055em;line-height:1.02;white-space:nowrap}' +
  '[data-hx=big] b{color:#FF3B45;font-weight:800}' +
  '[data-hx=rows]{margin-top:38px;max-width:520px;border-top:1px solid rgba(255,255,255,.16)}' +
  '[data-hx=r]{display:grid!important;grid-template-columns:1fr 92px 64px;align-items:baseline;gap:12px;padding:15px 0;border-bottom:1px solid rgba(255,255,255,.08)}' +
  '[data-hx=r] em{font-style:normal;font-size:14px;font-weight:600;color:#B4B4BA}' +
  '[data-hx=r] strong{font-size:19px;font-weight:800;letter-spacing:.02em}' +
  '[data-hx=r] > span{font-size:14px;color:#8A8A90;text-align:right}' +
  '[data-hx=more]{margin-top:30px;font-size:14px;font-weight:700;color:#FFFFFF}' +
  '[data-hx=more] i{display:inline-block;font-style:normal;margin-left:6px;transition:transform .5s ' + EASE + '}' +
  '[data-heroslide]:hover [data-hx=more] i{transform:translateX(6px)}' +
  // 모션
  '@keyframes hx-up{from{transform:translateY(108%)}to{transform:none}}' +
  '@keyframes hx-fade{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}' +
  '@keyframes hx-line{from{transform:scaleX(0)}to{transform:scaleX(1)}}' +
  '@keyframes hx-col{from{clip-path:inset(100% 0 0 0)}to{clip-path:inset(0 0 0 0)}}' +
  '@keyframes hx-pan{from{transform:scale(1.18) translateY(3%)}to{transform:scale(1.08) translateY(-3%)}}' +
  `${HX_ON}[data-hx=kick]{animation:hx-fade .9s ${EASE} .1s both}` +
  `${HX_ON}[data-hx=kick] i{animation:hx-line 1s ${EASE} .25s both}` +
  `${HX_ON}[data-hx=l] > span,${HX_ON}[data-hx=big] > span{animation:hx-up 1.1s ${EASE} calc(.3s + var(--i)*.12s) both}` +
  `${HX_ON}[data-hx=r]{animation:hx-fade .9s ${EASE} calc(.75s + var(--i)*.1s) both}` +
  `${HX_ON}[data-hx=more]{animation:hx-fade .9s ${EASE} 1.1s both}` +
  `${HX_ON}[data-hx=w]{animation:hx-col 1.3s cubic-bezier(.7,0,.2,1) calc(.15s + var(--i)*.14s) both}` +
  `${HX_ON}[data-hx=w] img{animation:hx-pan 9s ease-out calc(.15s + var(--i)*.14s) both}` +
  `${HX_ON}[data-hx=cap]{animation:hx-fade .9s ${EASE} calc(1.1s + var(--i)*.12s) both}` +
  '@media (prefers-reduced-motion: reduce){[data-heroslide] *{animation:none!important}}' +
  // 폰: 작품을 배경으로 깔고 글자를 위에 올린다. 하단 고정 바(약 112px)가
  // 히어로 아래쪽을 덮으므로 문구는 위쪽에 모은다.
  '@media (max-width: 760px){' +
  '[data-hx=works]{width:100%;gap:2px}' +
  '[data-hx=w] img{opacity:.3}' +
  '[data-hx=w]::after,[data-hx=cap]{display:none!important}' +
  '[data-heroslide]::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(11,11,12,.72),rgba(11,11,12,.5) 50%,rgba(11,11,12,.8))}' +
  '[data-hx=copy]{z-index:1;left:22px;right:22px;width:auto;justify-content:flex-start;padding-top:44px}' +
  '[data-hx=kick]{font-size:11px;letter-spacing:.12em;gap:10px}[data-hx=kick] i{width:28px}' +
  '[data-hx=l]{margin-top:22px;font-size:20px}' +
  '[data-hx=big]{font-size:68px}' +
  '[data-hx=rows]{margin-top:22px;max-width:none}' +
  '[data-hx=r]{grid-template-columns:1fr 70px 52px;padding:11px 0}' +
  '[data-hx=r] em,[data-hx=r] > span{font-size:13px}[data-hx=r] strong{font-size:16px}' +
  '[data-hx=more]{margin-top:18px;font-size:13px}' +
  '}' +
  // 슬라이드 점
  '[data-herodots]{position:absolute;z-index:4;bottom:40px;left:calc(max(0px,(100% - 1400px)/2) + clamp(20px,4vw,56px));display:flex;gap:10px}' +
  '[data-herodot]{width:34px;height:2px;padding:10px 0;box-sizing:content-box;border:0;cursor:pointer;' +
  'background:rgba(255,255,255,.32);background-clip:content-box}' +
  'html:not([data-hs="1"]) [data-herodot="0"],html[data-hs="1"] [data-herodot="1"]{background-color:#FFFFFF}' +
  '@media (max-width: 900px){[data-herodots]{bottom:18px;left:22px}}' +
  '</style>';
seo(/<\/head>/i, () => heroSlideCss + '</head>');
const heroSlideScript =
  '<script>(function(){var h=document.documentElement,t;' +
  'function go(n){if(n)h.setAttribute("data-hs","1");else h.removeAttribute("data-hs");}' +
  'function cur(){return h.getAttribute("data-hs")==="1"?1:0;}' +
  'function auto(){clearTimeout(t);' +
  'if(matchMedia("(prefers-reduced-motion: reduce)").matches)return;' +
  't=setTimeout(function(){go(1-cur());auto();},cur()?8000:8500);}' +
  'document.addEventListener("click",function(e){' +
  'var b=e.target.closest?e.target.closest("[data-herodot]"):null;if(!b)return;' +
  'go(+b.getAttribute("data-herodot"));auto();});' +
  'auto();})();</' +
  'script>';
seo(/<\/body>/, () => heroSlideScript + '</body>');

// Class shortcuts for phones. The 수업과목 section is ~4,000px down the page, so on a
// phone the three classes are only reachable by a long scroll. A second bar above
// the action bar jumps straight to each one.
// The class blocks are built by CLASS_GROUPS.map(), not written into the markup, so
// the anchors have to come from the React props rather than a tag rewrite.
seo(/('data-group': '1',)/, (_, a) => a + " id: 'class-' + gi,");
// Order is CLASS 01 고등반 / 02 주니어반 / 03 성인취미반, so the indices are fixed.
// display:none inline keeps it off desktop; the mobile block below turns it on.
const classNav =
  '<nav data-classnav="1" aria-label="반 바로가기" style="display:none;position:fixed;left:0;right:0;z-index:69">' +
  '<a href="#class-0">고등반</a>' +
  '<a href="#class-1">주니어반</a>' +
  '<a href="#class-2">취미반</a>' +
  '</nav>';
seo(/(<aside data-rail="1")/, (_, a) => classNav + '\n  ' + a);

// 빠른 메뉴(사이드 레일)를 통째로 다시 만든다.
//
// 고치기 전 상태를 브라우저로 재 보고 고친 것들:
//  - PC 에서 라벨 폭이 평소 0px 이었다. 마우스를 올려야 43px 로 펴진다. 즉 PC
//    에서는 뜻 모를 동그라미 여섯 개가 전부였다. 사용자 표현 그대로 "무슨 말을
//    하는지 아이콘도 이해가 안 된다". 넓은 화면에서는 글자를 늘 보이게 한다.
//  - 라벨을 펴는 코드가 mouseenter/mouseleave 에만 걸려 있어 키보드로는 끝내
//    글자가 나오지 않았다(포커스 전후 모두 0px). :focus-visible 을 CSS 로 준다.
//  - '맨 위로' 에는 라벨도 aria-label 도 없어 이름 없는 링크로 읽혔다.
//  - 아이콘이 뜻과 어긋났다. 체크(=완료)로 합격실적을, 말풍선(=채팅)으로 예약을,
//    지구본(=언어·세계)으로 본사 홈페이지를 가리키고 있었다.
//  - 알약 배경이 rgba(20,20,22,.72) 라 순흑 배경에서 거의 묻혔다.
//
// 항목도 바꾼다. '애니톡 홈페이지' 는 상담으로 이어져야 할 자리를 본사 사이트로
// 내보내는 데 쓰고 있었다 — 빼고 꼬리글에 남긴다. 대신 상담 전에 가장 많이 찾는
// '오시는 길'(#visit) 을 넣는다. '합격결과' 는 헤더 메뉴와 같은 '합격실적' 으로 맞춘다.
//
// 인라인 스타일 더미 대신 클래스로 간다. 특히 빨강 강조를 nth-of-type(2) 가
// 아니라 .pri 로 거는 것이 중요하다 — 위치로 걸어 두면 항목 순서를 바꿀 때마다
// 강조가 엉뚱한 버튼으로 옮겨 간다(이번에 순서가 바뀐다).
//
// 기존 스크립트를 건드리지 않고 비켜 가는 방법: 라벨을 펴던 핸들러는
// `querySelector('[data-sidelabel]')` 가 없으면 스스로 빠져나간다. 새 마크업은
// 그 속성을 쓰지 않으므로 핸들러가 저절로 꺼진다. 반대로 data-totop(스크롤 70%
// 등장)과 data-cta/data-loc(클릭 분석)은 그대로 둬야 해서 유지한다.
const railIcon = (paths) =>
  '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  paths + '</svg>';
const RAIL_ICONS = {
  // 학사모. 체크(=완료)보다 입시 실적이라는 뜻이 바로 선다.
  cap:
    '<path d="M22 10 12 5 2 10l10 5 10-5z"></path>' +
    '<path d="M6 12v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5"></path>',
  // 달력에 체크. 말풍선(=채팅)이 아니라 '예약'으로 읽힌다.
  book:
    '<rect x="3" y="5" width="18" height="16" rx="2"></rect>' +
    '<path d="M8 3v4M16 3v4M3 10h18"></path>' +
    '<path d="m9 15 2 2 4-4"></path>',
  tel:
    '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 ' +
    '2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .3 1.9.6 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.1a2 2 0 0 1 ' +
    '2.1-.5c.9.3 1.8.5 2.8.6a2 2 0 0 1 1.7 2z"></path>',
  // 지도핀.
  map:
    '<path d="M12 21s-7-5.4-7-11a7 7 0 1 1 14 0c0 5.6-7 11-7 11z"></path>' +
    '<circle cx="12" cy="10" r="2.6"></circle>',
  // 신문. 닫힌 책보다 '소식'에 가깝다.
  news:
    '<path d="M4 5h11a1 1 0 0 1 1 1v13H5a1 1 0 0 1-1-1V5z"></path>' +
    '<path d="M16 9h3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-3"></path>' +
    '<path d="M7 9h5M7 12h5M7 15h3"></path>',
  up: '<path d="M12 19V5"></path><path d="m5 12 7-7 7 7"></path>',
};
const railItem = (href, icon, label, opts = {}) =>
  '<a class="rail-i' + (opts.pri ? ' pri' : '') + '" href="' + href + '"' +
  (opts.cta ? ' data-cta="' + opts.cta + '" data-loc="bottombar"' : '') +
  (opts.blank ? ' target="_blank" rel="noopener"' : '') + '>' +
  railIcon(RAIL_ICONS[icon]) + '<span class="rail-t">' + label + '</span></a>';
const railHtml =
  '<aside data-rail="1" class="rail" aria-label="빠른 메뉴">\n    ' +
  [
    railItem('#results', 'cap', '합격실적', { cta: 'results' }),
    railItem('{{ bookingUrl }}', 'book', '예약상담', { cta: 'booking', pri: true, blank: true }),
    railItem('tel:031-994-3134', 'tel', '전화문의', { cta: 'tel' }),
    railItem('#visit', 'map', '오시는 길', { cta: 'visit' }),
    railItem('/blog/', 'news', '학원 이야기', { cta: 'blog' }),
    '<a class="rail-i rail-top" href="#top" data-totop="1" aria-label="맨 위로">' +
      railIcon(RAIL_ICONS.up) + '</a>',
  ].join('\n    ') +
  '\n  </aside>';
seo(/<aside data-rail="1"[\s\S]*?<\/aside>/, () => railHtml);

// 사이드메뉴는 글자만 일곱 줄이라 훑을 때 '학원 이야기'가 나머지와 구분되지 않는다.
// 아이콘을 하나 붙여 눈에 걸리게 하고, 바로 아래에 네이버 블로그를 한 줄 더 준다.
// 네이버 블로그는 지금까지 '오시는 길' 아래 동그란 아이콘으로만 있어서, 메뉴를 연
// 사람에게는 보이지 않았다. 이 둘은 같은 '읽을 것'이므로 나란히 둔다.
const menuIcon = (paths) =>
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ' +
  'style="flex:0 0 auto;color:#FF3B45">' + paths + '</svg>';
// 펼친 책. 하단 바의 '학원 이야기'와 같은 아이콘을 써서 두 자리가 같은 곳임을 알린다.
const ICON_BOOK =
  '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>' +
  '<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>';
// 모서리 접힌 문서. 오시는 길의 네이버 블로그 아이콘과 같은 모양이다.
const ICON_DOC =
  '<path d="M4 4h11l5 5v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"></path>' +
  '<path d="M8 12h8"></path><path d="M8 16h5"></path>';
const MENU_ATTRS =
  'data-menuitem="1" style="display:flex;align-items:center;justify-content:space-between;' +
  'padding:17px 4px;font-size:17px;font-weight:700;color:#FFFFFF;border-bottom:1px solid #232326"';
const menuLabel = (icon, text) =>
  '<span style="display:inline-flex;align-items:center;gap:11px">' + menuIcon(icon) + text + '</span>';
const storyMenu =
  '<a href="/blog/" ' + MENU_ATTRS + '>' +
  menuLabel(ICON_BOOK, '학원 이야기') +
  '<span aria-hidden="true" style="color:#8C8C8C">→</span></a>' +
  // 바깥으로 나가는 링크라 화살표를 바꿔 둔다. 새 탭으로 열리는 것을 누르기 전에 알린다.
  '<a href="https://blog.naver.com/anitalk-ilsan" target="_blank" rel="noopener" ' +
  'data-cta="naverblog" data-loc="mobile-menu" ' + MENU_ATTRS + '>' +
  menuLabel(ICON_DOC, '네이버 블로그') +
  '<span aria-hidden="true" style="color:#8C8C8C">↗</span></a>';
seo(
  /<a href="\/blog\/" data-menuitem="1"[^>]*>학원 이야기<span aria-hidden="true" style="color:#8C8C8C">→<\/span><\/a>/,
  () => storyMenu
);
// A plain #anchor lands the class card flush with the top of the viewport, where the
// 64px sticky header covers its "CLASS 01 고등반" title row — you arrive mid-sentence
// with no way to tell which class you are looking at. scroll-margin-top does not fix
// it here: the cards sit inside an overflow:hidden wrapper, so the margin resolves
// against that scrollport rather than the viewport. Scroll them by hand instead.
// This goes after </x-dc>, outside the tree React renders — a script inside it would
// never run.
const classNavScript =
  '<script>document.addEventListener("click",function(e){' +
  'var a=e.target.closest?e.target.closest("[data-classnav] a"):null;if(!a)return;' +
  'var el=document.querySelector(a.getAttribute("href"));if(!el)return;' +
  'e.preventDefault();' +
  // offsetTop, not getBoundingClientRect: the cards carry data-reveal transforms that
  // are still animating when the click lands, so a rect read at that moment is 20-30px
  // out by the time the scroll settles. offsetTop ignores transforms.
  'var y=0,n=el;while(n){y+=n.offsetTop;n=n.offsetParent;}' +
  'window.scrollTo({top:y-76,' +
  'behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth"});' +
  '});</' +
  'script>';
seo(/<\/body>/, () => classNavScript + '</body>');

// ── GA4 전환 이벤트 ──
// 버튼 19곳에 data-cta / data-loc 라벨은 붙어 있었지만 그 값을 GA4 로 보내는 코드가
// 한 줄도 없어, GA4 에는 페이지뷰만 쌓이고 '어느 버튼이 상담으로 이어졌는가' 는
// 남지 않았다. document 에 한 번 걸어 위임한다 — 버튼은 React 가 스크립트보다 늦게
// 그리고 재렌더링 때 새로 만들어서, 버튼마다 거는 방식은 아무것에도 걸리지 않는다.
//   tel_click : 전화 링크.  cta_click : 그 밖에 data-cta 가 붙은 모든 링크
//               (cta_type = booking · trial · seminar · results · visit · blog ...)
// GA4 관리 화면에서 cta_click(cta_type = booking · trial · seminar)과 tel_click 을
// '주요 이벤트(전환)' 로 표시해야 구글 애즈 전환으로 가져갈 수 있다.
if (GA_ID) {
  const gaEvents =
    '<script>document.addEventListener("click",function(e){' +
    'var a=e.target&&e.target.closest?e.target.closest("a"):null;if(!a||typeof gtag!=="function")return;' +
    'var h=a.getAttribute("href")||"",loc=a.getAttribute("data-loc")||"body";' +
    'if(h.indexOf("tel:")===0){gtag("event","tel_click",{location:loc,link_url:h});return}' +
    'var c=a.getAttribute("data-cta");if(!c)return;' +
    'gtag("event","cta_click",{cta_type:c,location:loc,link_url:a.href});' +
    '},true);</' +
    'script>';
  seo(/<\/body>/, () => gaEvents + '</body>');
}

// Clarity, loaded last and async so it never blocks first paint. Same reason as the
// class-nav script: it goes after </x-dc> rather than inside the tree React renders.
if (CLARITY_ID) {
  const clarity =
    '<script>(function(c,l,a,r,i,t,y){' +
    'c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};' +
    't=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;' +
    'y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);' +
    `})(window,document,"clarity","script","${CLARITY_ID}");</` +
    'script>';
  seo(/<\/body>/, () => clarity + '</body>');
}

// ── 합격실적 CTA 와 예약 주소 (코덱스가 2026-10-10 에 고친 것) ──
//
// 세 군데 모두 생성물인 index.html 에 직접 손을 댄 것이라, 다음 빌드에서
// 그대로 지워졌다. 빌드가 만들어 내는 곳으로 옮겨 심어 이제는 살아남는다.
//
//  (1) 예약 주소에 items/4216506 이 빠져 있었다. 예약 페이지 첫 화면이 아니라
//      해당 상품으로 바로 들어가야 한다.
//  (2) '2026 합격생 명단 보러가기' 가 예약 링크를 가리키고 있었다. 명단을
//      보려던 사람이 예약창으로 튕겼다. 같은 페이지의 명단 섹션으로 보낸다.
//      이 패치는 분석 라벨 단계보다 앞에 있어야 한다. 그 단계는 예약·전화
//      링크에만 data-cta 를 붙이는데, 여기서 href 를 먼저 바꿔 두면 이 버튼은
//      더 이상 예약 링크가 아니므로 booking 으로 집계되지 않는다.
//  (3) 그 명단 섹션에 id 와 scroll-margin-top 을 준다. 고정 머리글이 80px 라
//      이것이 없으면 제목이 머리글 밑으로 들어간다.
seo(
  /bookingUrl: this\.props\.bookingUrl \?\? 'https:\/\/booking\.naver\.com\/booking\/6\/bizes\/626887'/,
  () =>
    "bookingUrl: this.props.bookingUrl ?? " +
    "'https://booking.naver.com/booking/6/bizes/626887/items/4216506'"
);
seo(
  /<a data-reveal="120" href="\{\{ bookingUrl \}\}" target="_blank" rel="noopener"/,
  // 예약 링크가 아니게 되면서 분석 라벨 단계가 이 버튼을 건너뛴다. 명단으로
  // 가는 클릭도 세어 둘 값어치가 있으니 라벨을 직접 붙인다(이미 data-cta 가
  // 있으면 그 단계는 손대지 않는다).
  () => '<a data-cta="passlist" data-loc="results" data-reveal="120" href="#pass-list"'
);
seo(
  /<section style="background:#0F0F11;padding:clamp\(115px,14\.4vw,198px\) clamp\(20px,4vw,48px\)">/,
  () =>
    '<section id="pass-list" style="scroll-margin-top:80px;' +
    'background:#0F0F11;padding:clamp(115px,14.4vw,198px) clamp(20px,4vw,48px)">'
);

// ── Analytics labels ──
// The same two calls to action are repeated down the page: six 네이버 예약 buttons and
// five phone links. Without a label every one of them looks identical to an analytics
// tool, so "예약 30 clicks" tells you nothing about whether the bottom bar, the hero or
// the FAQ is what actually works. Tag each with the block it sits in so the clicks can
// be split apart. Useful on its own — Clarity's smart events and GA4 both read
// attributes — so it ships whether or not a tracking script is installed.
const marks = [];
for (const [re, name] of [
  [/<header[\s>]/g, 'header'],
  [/<nav data-classnav/g, 'classnav'],
  [/<aside data-rail/g, 'bottombar'],
  [/<footer[\s>]/g, 'footer'],
]) {
  for (const m of template.matchAll(re)) marks.push({ at: m.index, name });
}
for (const m of template.matchAll(/<section id="([^"]+)"/g)) {
  marks.push({ at: m.index, name: m[1] });
}
marks.sort((a, b) => a.at - b.at);

// Nearest container that opens before this point. Document order is header, class nav,
// rail, sections, footer, so the closest preceding mark is always the enclosing block.
const locationOf = (index) => {
  let name = 'body';
  for (const m of marks) {
    if (m.at >= index) break;
    name = m.name;
  }
  return name;
};

let labelled = 0;
const ctaCounts = {};
template = template.replace(
  /<a\b[^>]*href="(?:\{\{ bookingUrl \}\}|tel:[^"]*)"[^>]*>/g,
  (tag, at) => {
    // The mobile menu labels its own links. Relabelling by nearest container would
    // call them "header", since the panel is injected just before the rail.
    if (/data-cta=/.test(tag)) return tag;
    const kind = tag.includes('tel:') ? 'tel' : 'booking';
    const loc = locationOf(at);
    labelled++;
    ctaCounts[`${kind}:${loc}`] = (ctaCounts[`${kind}:${loc}`] || 0) + 1;
    return tag.replace('<a ', `<a data-cta="${kind}" data-loc="${loc}" `);
  }
);

// Appended to the LAST style block, not the first: the bundle's own
// `aside[data-rail] { display: none }` lives in a later block, and a rule inserted
// into the earlier font stylesheet would lose to it on source order.
const mobileCss = `
  @media (max-width: 900px) {
    /* 사진의 위쪽 절반에 ANITALK 간판이 있다. 예전 값(.58/.66/.82)은 간판까지
     * 함께 덮어 첫 화면이 통째로 어두웠다. 위는 걷어 간판을 보이게 하고,
     * 글자가 앉는 아래쪽만 진하게 남긴다. */
    [data-heroscrim] {
      background: linear-gradient(180deg,
        rgba(0,0,0,.30) 0%, rgba(0,0,0,.28) 40%,
        rgba(0,0,0,.62) 68%, rgba(0,0,0,.86) 100%) !important;
    }
    /* 제목이 세로 가운데라 간판 글씨를 정확히 덮고 있었다. 간판 아래 비어 있는
     * 데스크 쪽으로 내린다. 하단 고정 바 두 줄(약 112px)을 피해 여백을 준다. */
    [data-heroin] {
      justify-content: flex-start !important;
      /* 실측: 폰에서 히어로는 화면 높이와 무관하게 620px 로 고정되고, 사진 속
       * 간판은 그 안의 234~389px 자리에 온다. vh 로 잡으면 작은 폰에서 간판을
       * 다시 덮으므로 px 로 고정한다. */
      padding-top: 250px !important;
      padding-bottom: 0 !important;
    }
  }
  /* 메뉴 서랍의 열림/닫힘은 폭과 무관하다. 이 두 줄이 @media (max-width:860px)
   * 안에 있던 동안 PC 폭에서는 서랍을 숨기는 규칙 자체가 적용되지 않아,
   * 서랍이 늘 펼쳐진 채였고 닫기(×)를 눌러도 사라지지 않았다.
   * 열림 상태는 <html> 에 두어 재렌더링이 지우지 못하게 한다. */

  /* ── 빠른 메뉴(사이드 레일) ─────────────────────────────────────────
   * 넓은 화면에서는 글자를 늘 보여 준다. 아이콘만 있으면 무슨 버튼인지
   * 읽히지 않는다는 것이 이번 수정의 출발점이다. 데스크톱 쪽은 지금까지
   * 규칙이 한 줄도 없이 인라인 스타일로만 그려졌다 — 인라인을 걷어 냈으니
   * 여기서 전부 준다. */
  .rail {
    position: fixed; right: 20px; top: 50%; transform: translateY(-50%); z-index: 70;
    display: flex; flex-direction: column; align-items: stretch; gap: 9px;
  }
  .rail .rail-i {
    display: flex; align-items: center; gap: 0; height: 46px; padding: 0 16px;
    border-radius: 999px; white-space: nowrap; color: #FFFFFF;
    /* 예전 값 .72 는 순흑 배경에서 테두리만 겨우 보였다. 올려서 카드로 읽히게 한다. */
    background: rgba(26,26,30,.92);
    -webkit-backdrop-filter: blur(14px) saturate(1.3);
    backdrop-filter: blur(14px) saturate(1.3);
    border: 1px solid rgba(255,255,255,.14);
    box-shadow: 0 8px 28px rgba(0,0,0,.45);
    transition: background .32s ease, border-color .32s ease, color .32s ease,
      box-shadow .42s cubic-bezier(.16,1,.3,1), transform .52s cubic-bezier(.22,1.4,.36,1);
  }
  .rail .rail-i svg { flex: 0 0 auto; }
  .rail .rail-t { margin-left: 10px; font-size: 13px; font-weight: 700; letter-spacing: -.02em; }
  .rail .pri {
    background: ${hex(RED.to).toUpperCase()}; border-color: ${hex(RED.to).toUpperCase()};
    box-shadow: 0 8px 28px rgba(${RED.to.join(',')},.42);
  }
  .rail .rail-i:hover, .rail .rail-i:focus-visible {
    background: ${hex(RED.to).toUpperCase()}; border-color: ${hex(RED.to).toUpperCase()}; color: #FFFFFF; transform: translateX(-4px);
  }
  .rail .pri:hover, .rail .pri:focus-visible {
    background: #FFFFFF; border-color: #FFFFFF; color: ${hex(RED.to).toUpperCase()};
  }
  /* '맨 위로'는 가는 곳이 아니라 도구다. 원형으로 두고 위와 간격을 벌려 나눈다. */
  .rail .rail-top {
    align-self: flex-end; width: 46px; height: 46px; padding: 0;
    justify-content: center; margin-top: 7px;
  }
  /* 라벨을 펼칠 자리가 있는지 실측해서 정한 기준이다. 본문 글자의 오른쪽 끝을
   * 재 보면 레일이 쓸 수 있는 폭이 1920px 에서 296px, 1600px 에서 136px,
   * 1440px 에서는 56px 뿐이다. 라벨형 레일은 119px 이라 1600px 아래에서는
   * 본문 글자를 덮는다. 그 아래로는 아이콘만 두고 마우스 또는 키보드 포커스에서
   * 편다. 예전에는 펴는 동작이 mouseenter 에만 걸려 있어 키보드로는 끝내 글자를
   * 볼 수 없었다. */
  @media (max-width: 1599px) {
    .rail .rail-i { padding: 0 13px; }
    .rail .rail-t {
      max-width: 0; opacity: 0; margin-left: 0; overflow: hidden;
      transition: max-width .46s cubic-bezier(.16,1,.3,1), opacity .32s ease,
        margin-left .46s cubic-bezier(.16,1,.3,1);
    }
    .rail .rail-i:hover .rail-t, .rail .rail-i:focus-visible .rail-t {
      max-width: 140px; opacity: 1; margin-left: 10px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .rail .rail-i, .rail .rail-t { transition: none; }
  }
  [data-menupanel] { display: none !important; }
  html[data-menu-open] [data-menupanel] { display: block !important; }
  @media (max-width: 860px) {
    [data-mobilenav] { display: inline-flex !important; }
    /* side rail becomes a fixed bottom action bar */
    aside[data-rail] {
      display: flex !important;
      right: 0 !important; left: 0 !important; top: auto !important; bottom: 0 !important;
      transform: none !important;
      flex-direction: row !important; align-items: stretch !important; gap: 4px !important;
      padding: 7px 8px calc(7px + env(safe-area-inset-bottom, 0px)) !important;
      background: rgba(9,9,11,.94) !important;
      backdrop-filter: blur(16px) saturate(1.3);
      border-top: 1px solid rgba(255,255,255,.12) !important;
      box-shadow: 0 -6px 26px rgba(0,0,0,.5) !important;
    }
    aside[data-rail] > a {
      flex: 1 1 0 !important; min-width: 0 !important;
      height: 54px !important; padding: 0 2px !important;
      flex-direction: column !important; justify-content: center !important; gap: 3px !important;
      border-radius: 13px !important;
      background: transparent !important; border: 1px solid transparent !important;
      box-shadow: none !important; backdrop-filter: none !important;
      transform: none !important;
    }
    aside[data-rail] > a.pri {
      background: ${hex(RED.to).toUpperCase()} !important; border-color: ${hex(RED.to).toUpperCase()} !important;
      box-shadow: 0 4px 16px rgba(${RED.to.join(',')},.45) !important;
    }
    /* class shortcuts, stacked directly on top of the action bar */
    [data-classnav] {
      display: flex !important;
      bottom: calc(68px + env(safe-area-inset-bottom, 0px)) !important;
      gap: 6px !important; padding: 6px 8px !important;
      background: rgba(9,9,11,.94) !important;
      backdrop-filter: blur(16px) saturate(1.3);
      border-top: 1px solid rgba(255,255,255,.1) !important;
    }
    [data-classnav] > a {
      flex: 1 1 0 !important; min-width: 0 !important;
      /* min-height 44px 는 아래에서 따로 준다. 블록 앵커라 글자가 상자 위쪽에
       * 붙고 늘어난 높이만큼 아래가 비어, 글자가 살짝 올라가 보였다. */
      display: flex !important; align-items: center !important; justify-content: center !important;
      padding: 9px 4px !important; text-align: center !important;
      font-size: 13px !important; font-weight: 700 !important; letter-spacing: -.03em !important;
      color: #FFFFFF !important; border-radius: 10px !important;
      background: rgba(255,255,255,.07) !important;
      border: 1px solid rgba(255,255,255,.14) !important;
      white-space: nowrap !important;
    }
    aside[data-rail] > a[data-totop] {
      position: absolute !important; right: 12px !important; bottom: calc(100% + 56px) !important;
      flex: 0 0 auto !important; width: 44px !important; height: 44px !important;
      padding: 0 !important; border-radius: 999px !important;
      background: rgba(20,20,22,.82) !important; border: 1px solid rgba(255,255,255,.16) !important;
      box-shadow: 0 8px 26px rgba(0,0,0,.5) !important;
    }
    aside[data-rail] .rail-t {
      max-width: none !important; opacity: 1 !important; margin-left: 0 !important;
      font-size: 10.5px !important; font-weight: 700 !important; letter-spacing: -.045em !important;
      overflow: visible !important;
    }
    aside[data-rail] svg { width: 20px !important; height: 20px !important; }
    /* 다섯 칸이다. 390px 에서 칸당 약 71px. 가장 긴 '학원 이야기'가 그보다
     * 좁은 화면에서는 넘치므로 자간을 더 조인다. */
    @media (max-width: 380px) {
      aside[data-rail] .rail-t { font-size: 9.5px !important; letter-spacing: -.06em !important; }
    }
    footer { padding-bottom: 152px !important; }
    /* Touch targets. Pointer guidance puts the practical minimum around 44px; measured
       on the live page these sat between 15px and 43px, which is a miss on a phone —
       the footer phone number was 15px tall. Only min-height/min-width grow, so the
       visual weight of each control is unchanged; it is the tappable box that grows. */
    [data-classnav] > a { min-height: 44px !important; }
    [data-hlogo], [data-hcta] { min-height: 44px !important; }
    #visit a { min-height: 44px !important; min-width: 44px !important; }
    #results a, #faq a, footer a {
      min-height: 44px !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
    }
    /* three story cards side by side leaves each one too narrow to read on a phone */
    [data-storygrid] { grid-template-columns: 1fr !important; gap: 16px !important; }
    /* about: one column, photos one per row instead of a cramped pair */
    [data-aboutgrid] { grid-template-columns: 1fr !important; gap: 32px !important; }
    [data-aboutpics] { grid-template-columns: 1fr !important; }
    [data-aboutpics] > div { grid-column: 1 / -1 !important; }
    [data-aboutpics] img { height: clamp(190px,46vw,260px) !important; }
  }
  @media (max-width: 560px) {
    /* Section rhythm. Every section sets padding: clamp(115px, 14.4vw, 198px) — the
       clamp floor is a desktop value, so a phone gets 115px of empty space above and
       below every band and the page runs to 18,000px. Only the vertical padding is
       overridden; the horizontal clamp still does its job. */
    section { padding-top: 66px !important; padding-bottom: 66px !important; }
    [data-herocta] {
      flex-direction: column !important; align-items: stretch !important;
      gap: 10px !important; margin-top: 26px !important;
    }
    [data-herocta] > a { justify-content: center !important; padding: 15px 24px !important; }
    /* Type floor. Sizes are baked into inline styles, so they can only be reached by
       matching the declaration itself. 12–13px is a desktop caption size; on a phone
       it is below what this audience reads comfortably. 14px and up are left alone.
       Both spacings are matched on purpose: the markup ships "font-size:13px", but
       React re-serialises the style attribute as "font-size: 13px" when it renders,
       so the unspaced form alone matches nothing once the page is live. */
    [style*="font-size:10px"], [style*="font-size: 10px"] { font-size: 11.5px !important; }
    [style*="font-size:11px"], [style*="font-size: 11px"] { font-size: 12.5px !important; }
    [style*="font-size:12px"], [style*="font-size: 12px"] { font-size: 13px !important; }
    [style*="font-size:13px"], [style*="font-size: 13px"] { font-size: 14.5px !important; }
    header > div { padding: 0 14px !important; gap: 10px !important; }
    [data-hlogo] { gap: 9px !important; min-width: 0 !important; }
    [data-hlogoko] { font-size: 15px !important; white-space: nowrap !important; }
    [data-hlogoimg] { width: 33px !important; height: 33px !important; flex: 0 0 auto !important; }
    [data-hcta] { font-size: 13px !important; padding: 10px 16px !important; flex: 0 0 auto !important; white-space: nowrap !important; }
  }
  @media (max-width: 390px) {
    header > div { padding: 0 11px !important; gap: 8px !important; }
    [data-hlogo] { gap: 7px !important; }
    [data-hlogoko] { font-size: 13.5px !important; }
    [data-hlogoimg] { width: 29px !important; height: 29px !important; }
    [data-hcta] { font-size: 12px !important; padding: 9px 12px !important; }
  }
`;
const lastStyle = template.lastIndexOf('</style>');
if (lastStyle < 0) {
  console.error('no </style> to append mobile rules to');
  process.exit(1);
}
template = template.slice(0, lastStyle) + mobileCss + template.slice(lastStyle);
seoEdits++;

// Every gallery thumbnail rendered through React.createElement('img') loaded
// eagerly, which was invisible while the bytes were already inline but now costs
// ~2MB of requests on first paint. They all sit below the fold; the hero and logo
// are plain <img> tags in the markup and are left eager on purpose.
let lazied = 0;
template = template.replace(
  /React\.createElement\('img',\s*\{/g,
  (m) => {
    lazied++;
    return m + " loading: 'lazy',";
  }
);

// The loader stripped these because blob: URLs from a null origin fail SRI.
// Real same-origin paths don't need the workaround, but nothing in the template
// carries a meaningful integrity hash either, so keep parity.
template = template
  .replace(/\s+integrity="[^"]*"/gi, '')
  .replace(/\s+crossorigin="[^"]*"/gi, '');

// Page code reads window.__resources; the loader injected it right after <head>.
const resourceMap = {};
for (const e of extResources) {
  if (pathByUuid.has(e.uuid)) resourceMap[e.id] = pathByUuid.get(e.uuid);
}
const resourceScript =
  '<script>window.__resources = ' +
  JSON.stringify(resourceMap).replace(/<\//g, '<\\/') +
  ';</' +
  'script>';

// The bundle emits a bare <html>. Without a language a screen reader guesses the
// pronunciation rules, and search engines lose an explicit signal about who the page
// is for.
seo(/<html(?![^>]*\slang=)([^>]*)>/i, (_, attrs) => '<html lang="ko"' + attrs + '>');

const headOpen = template.match(/<head[^>]*>/i);
if (!headOpen) {
  console.error('template has no <head>');
  process.exit(1);
}

// Preload the hero so externalising it doesn't cost a round trip on LCP.
const hero = template.match(/<img[^>]*data-parallax[^>]*src="([^"]+)"/i);
// 첫 화면은 이제 합격 슬라이드가 먼저다. 그 첫 작품 사진을 먼저 받고, 원래
// 히어로 사진은 그 뒤에 받는다.
const preload =
  '<link rel="preload" as="image" href="/gal/hero27/k.webp" fetchpriority="high">' +
  (hero ? `<link rel="preload" as="image" href="${hero[1]}">` : '');

// og:image, twitter:image and the ld+json logo/image are absolute URLs written
// against fixed filenames — they are not uuids, so the substitution above leaves
// them pointing at paths that only existed in the previous hand-built gal/. Write
// the hero and logo out under the names those tags expect as well, so a crawler
// fetching the share thumbnail gets the image instead of a 404.
const logo = template.match(/<img[^>]*src="([^"]+)"/i);
const aliasFor = (re, sourcePath) => {
  const m = template.match(re);
  if (!m || !sourcePath) return;
  const want = m[1];
  const from = path.join(outDir, sourcePath.replace(/^\//, ''));
  const to = path.join(outDir, want.replace(/^\//, ''));
  if (path.resolve(from) === path.resolve(to)) return;
  fs.copyFileSync(from, to);
  console.log(`alias        ${want} <- ${sourcePath}`);
};
aliasFor(/<meta property="og:image" content="https?:\/\/[^/]+(\/[^"]+)"/i, hero && hero[1]);
aliasFor(/"logo"\s*:\s*"https?:\/\/[^/]+(\/[^"]+)"/i, logo && logo[1]);

// The loader injected __resources directly after <head>, which was harmless when
// the template was only ever handed to DOMParser. Served as a real file it would
// push <meta charset> past the 1024-byte prescan window, so hoist charset first.
const gaSnippet = GA_ID
  ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></` + 'script>' +
    '<script>window.dataLayer=window.dataLayer||[];' +
    'function gtag(){dataLayer.push(arguments);}' +
    "gtag('js',new Date());" +
    `gtag('config','${GA_ID}');</` + 'script>'
  : '';

const charset = template.match(/<meta charset="[^"]*">/i);
if (charset) template = template.replace(charset[0], '');
const at = headOpen.index + headOpen[0].length;
template =
  template.slice(0, at) +
  (charset ? charset[0] : '<meta charset="utf-8">') +
  `<meta name="google-site-verification" content="${GOOGLE_VERIFY}">` +
  `<meta name="naver-site-verification" content="${NAVER_VERIFY}">` +
  // The tile carries the school's name under the face. At 32px that text is four
  // pixels tall and reads as a red smudge, so the small icons are cropped to the
  // face alone; the home-screen icon keeps the full tile, where the name is legible.
  '<link rel="icon" href="/favicon.ico" sizes="any">' +
  '<link rel="icon" type="image/png" sizes="32x32" href="/icon-32.png">' +
  '<link rel="icon" type="image/png" sizes="16x16" href="/icon-16.png">' +
  '<link rel="apple-touch-icon" href="/apple-touch-icon.jpg">' +
  // GA4. async so it never blocks first paint; the inline config runs immediately and
  // queues onto dataLayer, so the page_view is recorded even if gtag.js is still in
  // flight. In <head> rather than before </body> so a bounce before the page finishes
  // rendering is still counted.
  gaSnippet +
  resourceScript +
  preload +
  template.slice(at);

// The bundle keeps the entire SEO payload — title, description, keywords, robots,
// canonical, the og/twitter set and the ld+json graph — inside a <helmet> element in
// the BODY, and the app hoists it into <head> at runtime. A crawler that executes JS
// sees the right head; one that does not sees a <head> with no title at all. Naver's
// crawler is the weak one at JS rendering, and Naver is where the target queries are
// searched, so hoist at build time instead. The runtime then finds an empty <helmet>
// and has nothing left to move.
const helmet = template.match(/(<helmet>)([\s\S]*?)(<\/helmet>)/i);
if (helmet) {
  const contents = helmet[2].trim();
  template = template.replace(helmet[0], helmet[1] + helmet[3]);
  template = template.replace(/<\/head>/i, contents + '\n</head>');
  console.log(`hoist        <helmet> -> <head> (${contents.length} chars)`);
}

// 히어로의 예약 · 전화 버튼을 걷어낸다. 같은 동선이 상단바와 하단 액션바,
// 모바일 메뉴, FAQ 아래 CTA, '오시는 길'에 이미 있어서 첫 화면은 문구만 남긴다.
// data-herocta 는 위에서 붙여 둔 표식이라 여기서 그 블록만 정확히 집어낼 수 있다.
{
  const open = template.indexOf('<div data-herocta="1"');
  if (open === -1) {
    console.log('herocta     already gone');
  } else {
    let depth = 0;
    let i = open;
    for (;;) {
      const o = template.indexOf('<div', i);
      const c = template.indexOf('</div>', i);
      if (c === -1) throw new Error('hero CTA: 닫는 태그를 찾지 못했다');
      if (o !== -1 && o < c) { depth++; i = o + 4; }
      else { depth--; i = c + 6; if (depth === 0) break; }
    }
    let pre = open;
    while (pre > 0 && (template[pre - 1] === ' ' || template[pre - 1] === '\t')) pre--;
    if (pre > 0 && template[pre - 1] === '\n') pre--;
    console.log(`drop         hero CTA (${i - open} chars)`);
    template = template.slice(0, pre) + template.slice(i);
  }
}

// ── 숫자 카드 ──
// "4년 연속", "50명 이상" 의 숫자는 화면에 들어올 때 0 에서 세어 올리는데, 원본에는
// 0 이 적혀 있었다. 스크립트를 돌리지 않는 검색 로봇과 AI 는 "0년 연속 전원 합격"
// 으로 읽는다. 원본에 목표값을 적어 둔다 — 세어 올리는 쪽은 data-count 만 보고
// 0 부터 다시 쓰므로 움직임은 그대로다.
{
  let filled = 0;
  template = template.replace(/(<span data-count="(\d+)">)0(<\/span>)/g, (_, open, n, close) => (filled++, open + n + close));
  if (filled !== 3) throw new Error(`숫자 카드: 3곳이어야 하는데 ${filled}곳을 고쳤다`);
  console.log(`counts       ${String(filled).padStart(6)}     0 -> 목표값`);
}

// ── 강원애니고 합격 연도 ──
// 숫자 카드는 "2025 강원애니고 3명" 인데 명단의 세 줄은 2026 으로 적혀 있었다.
// 학원 확인(2026-11-15): 2025학년도가 맞다. 세 줄은 2025 묶음 바로 앞에 있어
// 연도만 바꾸면 순서도 맞는다.
{
  let fixed = 0;
  template = template.replace(/\['2026', '(강원애니고 [^']+)'/g, (_, dept) => (fixed++, `['2025', '${dept}'`));
  if (fixed !== 3) throw new Error(`강원애니고 연도: 3줄이어야 하는데 ${fixed}줄을 고쳤다`);
  console.log(`gangwon      ${String(fixed).padStart(6)}     2026 -> 2025`);
}

// ── 운영 시간 ──
// 번들에는 화~토 13:00~22:00 한 줄뿐인데 토요일은 11:00~18:00 이다(학원 확인
// 2026-11-15, 일 · 월 휴무는 그대로). 네 곳에 같은 시간이 적혀 있어 한꺼번에 고친다:
// 구조화 데이터, 질문 답(화면 · FAQPage), 오시는 길 전화 칸.
{
  const swap = (from, to, want, what) => {
    const n = template.split(from).length - 1;
    if (n !== want) throw new Error(`운영 시간: ${what} 을 ${n}곳 찾았다 (${want}곳이어야 한다)`);
    template = template.split(from).join(to);
  };
  const spec = (days, opens, closes) => ({ '@type': 'OpeningHoursSpecification', dayOfWeek: days, opens, closes });
  swap(
    JSON.stringify([spec(['Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], '13:00', '22:00')]),
    JSON.stringify([spec(['Tuesday', 'Wednesday', 'Thursday', 'Friday'], '13:00', '22:00'), spec(['Saturday'], '11:00', '18:00')]),
    1,
    '구조화 데이터'
  );
  swap(
    '13:00부터 22:00까지 운영하며, 일요일과 월요일은 휴무입니다.',
    '화요일부터 금요일은 13:00부터 22:00까지, 토요일은 11:00부터 18:00까지 운영합니다. 일요일과 월요일은 휴무입니다.',
    2,
    '질문 답'
  );
  swap('13:00 - 22:00<br>일요일 · 월요일 휴무', '화~금 13:00 - 22:00<br>토 11:00 - 18:00<br>일요일 · 월요일 휴무', 1, '전화 칸');
  console.log('hours             4     토요일 11:00 - 18:00');
}

// ── 무료 체험 안내 ──
// 고1~고3 · N수생 수업 2회 무료 체험은 네이버 플레이스 알림(2026-11-06)에만 있고
// 이 페이지에는 한 줄도 없었다. 상담 버튼 두 곳 옆과 자주 묻는 질문에 넣는다.
// 보이는 질문과 FAQPage 구조화 데이터는 같은 문장을 쓴다 — 한쪽만 있으면 구조화
// 데이터가 화면에 없는 내용을 말하게 된다. 체험을 그만두면 이 묶음을 통째로 지운다.
{
  const TRIAL_Q = '체험 수업을 받아 볼 수 있나요?';
  // 반마다 횟수가 다르다(원장 확정 2026-11-27): 고등반 2회, 주니어반 · 성인취미반 1회.
  // 예전 문장은 고등반만 적어 '전체 2회' 로 읽혔고, 네이버 예약 쿠폰(1회)과 어긋났다.
  const TRIAL_A =
    '고등반(고1~고3 · N수생)은 수업 2회, 초 · 중등 주니어반과 성인취미반은 수업 1회를 무료로 체험해 보실 수 있습니다. ' +
    '네이버 예약이나 031-994-3134로 상담을 먼저 신청해 주세요.';
  const once = (re, build, what) => {
    let n = 0;
    template = template.replace(re, (...a) => (n++, build(...a)));
    if (n !== 1) throw new Error(`무료 체험: ${what} 자리를 ${n}곳 찾았다 (1곳이어야 한다)`);
  };

  // 마지막 질문을 본떠 하나 더 붙인다. 모양을 따로 적지 않아 앞 질문들과 어긋날 일이 없다.
  once(
    /(<details data-faq="1"(?:(?!<details)[\s\S])*?상담과 등록은 어떻게 진행되나요\?[\s\S]*?<\/details>)/,
    (_, last) =>
      last +
      '\n        ' +
      last
        .replace('상담과 등록은 어떻게 진행되나요?', TRIAL_Q)
        .replace(/(<div style="padding:0 24px 24px 48px[^"]*">)[^<]*(<\/div>)/, (m, a, b) => a + TRIAL_A + b),
    '자주 묻는 질문'
  );
  if (!template.includes(TRIAL_A + '</div>')) throw new Error('무료 체험: 질문 답을 바꿔 넣지 못했다');

  once(
    /(\{"@type":"Question","name":"상담과 등록은 어떻게 진행되나요\?","acceptedAnswer":\{"@type":"Answer","text":"[^"]*"\}\})(\]\})/,
    (_, lastQ, close) =>
      lastQ + ',' + JSON.stringify({ '@type': 'Question', name: TRIAL_Q, acceptedAnswer: { '@type': 'Answer', text: TRIAL_A } }) + close,
    'FAQPage 구조화 데이터'
  );

  const NOTE = TRIAL_NOTE;
  once(
    /(<div data-reveal="0" style="display:flex;flex-wrap:wrap;justify-content:center;gap:12px;margin-top:)44px(">\s*<a data-cta="booking" data-loc="faq")/,
    (_, a, b) =>
      `<p data-reveal="0" style="margin:44px 0 0;text-align:center;font-size:15px;font-weight:700;color:#FFFFFF;word-break:keep-all">${NOTE}</p>\n      ` +
      a + '16px' + b,
    '질문 아래 상담 버튼'
  );
  once(
    /(네이버 예약으로<br>편하게 상담 신청하세요\.)(<\/div>)/,
    (_, text, close) => `${text}<br><b style="color:#111111">${NOTE}</b>${close}`,
    '오시는 길 상담 칸'
  );
  console.log('trial             4     질문 1 · 구조화 데이터 1 · 안내 2');
}

// ── 원본 HTML 프리렌더 ──
// 수업과목 · 합격 명단 · 수업 절차 · 작품 갤러리 세 곳은 템플릿에 {{ classGroups }}
// 같은 자리표시만 있고, 내용은 브라우저에서 React 가 채웠다. 사람 눈에는 멀쩡하지만
// 스크립트를 돌리지 않는 네이버 로봇 · AI 봇 · 링크 미리보기는 그 자리를 빈칸(또는
// 날것의 {{ }})으로 읽어, 이 페이지의 핵심 내용이 0개로 잡혔다. 예약 버튼 다섯 곳의
// href="{{ bookingUrl }}" 도 같은 이유로 깨진 상대 주소였다.
//
// 페이지 스크립트를 그대로 Node 에서 돌려 같은 요소 트리를 받고, 그걸 HTML 로 적어
// 자리표시 대신 넣는다. 런타임은 <x-dc> 안의 마크업을 템플릿으로 읽어 그리므로,
// 자리표시가 HTML 로 바뀌어도 React 가 같은 요소를 같은 속성으로 그린다 — 등장 효과
// (data-reveal) · 카드 들림(data-lift) · 단계 원(data-step) · 반 바로가기(id) 가 모두
// 속성으로 붙어 있어 그대로 동작한다. 데이터를 고칠 곳은 여전히 스크립트의 배열 하나다.
{
  const vm = require('vm');
  const scriptMatch = template.match(/<script type="text\/x-dc" data-dc-script="">([\s\S]*?)<\/script>/);
  if (!scriptMatch) throw new Error('프리렌더: 페이지 스크립트를 찾지 못했다');

  const el = (type, props, ...children) => ({ type, props: props || {}, children });
  const ctx = {
    window: { __resources: resourceMap },
    React: { createElement: el, Fragment: 'fragment' },
    DCLogic: class { constructor(props) { this.props = props || {}; } },
    document: {}, location: { search: '' },
  };
  vm.createContext(ctx);
  vm.runInContext(scriptMatch[1] + '\n;this.__vals = new Component({}).renderVals();', ctx, { timeout: 2000 });
  const vals = ctx.__vals;

  // React 가 단위 없이 쓰는 숫자 속성. 여기 없는 숫자가 나오면 px 를 붙여야 하는지
  // 따져 봐야 하므로 빌드를 멈춘다.
  const UNITLESS = new Set(['fontWeight', 'lineHeight', 'opacity', 'zIndex', 'flex', 'flexGrow', 'flexShrink', 'order']);
  const kebab = (k) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
  const css = (style) =>
    Object.entries(style)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => {
        if (typeof v === 'number' && !UNITLESS.has(k) && v !== 0) throw new Error(`프리렌더: ${k}=${v} 단위 확인 필요`);
        return `${kebab(k)}:${v}`;
      })
      .join(';');
  const VOID = new Set(['img', 'br', 'hr', 'input', 'source']);
  const render = (n) => {
    if (n == null || n === false || n === true) return '';
    if (Array.isArray(n)) return n.map(render).join('');
    if (typeof n === 'string' || typeof n === 'number') return escHtml(n);
    if (n.type === 'fragment') return render(n.children);
    if (typeof n.type !== 'string') throw new Error('프리렌더: 알 수 없는 요소 ' + n.type);
    let attrs = '';
    for (const [k, v] of Object.entries(n.props)) {
      if (k === 'key' || k === 'children' || v == null || v === false) continue;
      const name = k === 'className' ? 'class' : k === 'htmlFor' ? 'for' : k;
      attrs += ' ' + name + '="' + escHtml(k === 'style' ? css(v) : v) + '"';
    }
    if (VOID.has(n.type)) return `<${n.type}${attrs}>`;
    return `<${n.type}${attrs}>${render(n.children)}</${n.type}>`;
  };

  const SLOTS = ['steps', 'classGroups', 'passList', 'highA', 'hobbyA', 'galleryA'];
  for (const k of SLOTS) {
    const slot = `{{ ${k} }}`;
    const n = template.split(slot).length - 1;
    if (n !== 1) throw new Error(`프리렌더: ${slot} 를 ${n}곳 찾았다 (1곳이어야 한다)`);
    template = template.replace(slot, () => render(vals[k]));
  }
  const bookingN = template.split('{{ bookingUrl }}').length - 1;
  template = template.split('{{ bookingUrl }}').join(escHtml(vals.bookingUrl));
  const left = template.match(/\{\{[^}]*\}\}/g);
  if (left) throw new Error('프리렌더: 남은 자리표시 ' + [...new Set(left)].join(' '));
  console.log(
    `prerender    ${String(SLOTS.length).padStart(6)}     ` +
      `수업과목 ${vals.classGroups.length} · 합격 ${vals.passList.length} · 절차 ${vals.steps.length} · ` +
      `갤러리 ${vals.highA.length + vals.hobbyA.length + vals.galleryA.length} · 예약 주소 ${bookingN}곳`
  );
}

// 결과를 파일로 내보낸다. 한 번 이 줄이 사라진 적이 있다. 사이트맵 담당을 옮기는
// 커밋이 아래 robots.txt 묶음을 고쳐 쓰면서 이 줄까지 함께 지웠고, 빌드는 멀쩡히
// 끝나고 크기까지 찍어 주는데 index.html 만 이틀 동안 그대로였다. 그래서 쓴 다음
// 꼭 읽어 보고 확인한다 — 다음에 또 지워지면 빌드가 그 자리에서 멈춘다.
fs.writeFileSync(path.join(outDir, 'index.html'), template);
{
  const back = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
  if (back !== template) throw new Error('index.html 을 쓰지 못했다');
  const head = back.slice(0, back.search(/<\/head>/i));
  if (!/<title>/i.test(head)) throw new Error('index.html <head> 에 title 이 없다');
}

// 사이트맵은 tools/blog-render.js 가 만든다. 예전에는 여기서도 만들었는데, 두
// 도구가 같은 파일을 각자 덮어써서 나중에 돌린 쪽이 이겼다. 글 페이지를 만드는
// 것은 blog-render 라 그쪽이 나중에 돌아야 하고, 그러면 여기서 넣던 lastmod 가
// 조용히 사라졌다. 주인을 하나로 뒀다.
for (const name of ['robots.txt']) {
  const from = path.join(path.dirname(srcPath), name);
  if (!fs.existsSync(from)) continue;
  const body = fs.readFileSync(from, 'utf8');
  repointed += body.split(AUTHORED_AT).length - 1;
  fs.writeFileSync(path.join(outDir, name), body.split(AUTHORED_AT).join(SITE));
}

const kb = (n) => (n / 1024).toFixed(0).padStart(6) + ' KB';
console.log(
  `index.html   ${kb(Buffer.byteLength(template))}  (${lazied} img -> lazy, ` +
    `${recoloured} colour refs -> ${hex(RED.to)}, ${repointed} self-refs -> ${SITE}, ` +
    `${seoEdits} seo edits, ${recontrasted} contrast fixes)`
);
console.log(
  `cta labels   ${String(labelled).padStart(6)}     ` +
    Object.entries(ctaCounts)
      .sort()
      .map(([k, n]) => (n > 1 ? `${k}x${n}` : k))
      .join(' ')
);
if (!CLARITY_ID) console.log('clarity      ' + '(skipped)'.padStart(6) + '     no project id set');
console.log(`fonts/       ${kb(bytes.fonts)}  (${written.fonts} files)`);
console.log(`gal/         ${kb(bytes.gal)}  (${written.gal} files)`);
console.log(`js/          ${kb(bytes.js)}  (${written.js} files)`);
