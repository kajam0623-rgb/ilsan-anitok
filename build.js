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
const SITE = 'https://ilsan-anitok.vercel.app';
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
const POSTS_DIR = path.join(__dirname, 'content', 'posts');
let posts = [];
if (fs.existsSync(POSTS_DIR)) {
  posts = fs
    .readdirSync(POSTS_DIR)
    .filter((f) => /^\d+\.md$/.test(f))
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
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 3);
}

if (posts.length) {
  const card = (p) =>
    // white-space:normal is not decoration: the page sets `a[href] { white-space:
    // nowrap }` for its nav pills, and a card is an anchor, so without this the
    // title runs off the side instead of wrapping.
    `<a href="/blog/${p.slug}/" data-cta="blog" data-loc="home-stories" style="display:block;background:#131317;border:1px solid #232326;border-radius:18px;overflow:hidden;color:#FFFFFF;text-align:left;white-space:normal">` +
    (p.image
      ? `<img src="${p.image}" alt="${p.title.replace(/"/g, '&quot;')}" loading="lazy" decoding="async" style="display:block;width:100%;height:170px;object-fit:cover">`
      : '') +
    `<div style="padding:22px 20px">` +
    `<div style="font-size:19px;font-weight:800;line-height:1.4;letter-spacing:-.03em;word-break:keep-all;margin-bottom:10px">${p.title}</div>` +
    `<div style="font-size:14px;line-height:1.7;color:#A8A8AC;word-break:keep-all">${p.description}</div>` +
    `</div></a>`;

  const section =
    `<section id="stories" style="background:#0B0B0D;padding:clamp(115px,14.4vw,198px) clamp(20px,4vw,48px)">` +
    `<div style="max-width:1200px;margin:0 auto">` +
    `<div style="text-align:center;margin-bottom:52px">` +
    `<div style="font-size:12px;font-weight:800;letter-spacing:.22em;color:${hex(RED.to).toUpperCase()};margin-bottom:14px">STORIES</div>` +
    `<h2 style="margin:0;font-size:clamp(26px,3.2vw,40px);line-height:1.32;letter-spacing:-.04em;font-weight:800">학원 이야기</h2>` +
    `<p style="margin:16px 0 0;font-size:15px;line-height:1.85;color:#A8A8AC;word-break:keep-all">입시와 수업에서 자주 나오는 질문을 정리했습니다</p>` +
    `</div>` +
    `<div data-storygrid="1" style="display:grid;grid-template-columns:repeat(3,1fr);gap:20px">${posts.map(card).join('')}</div>` +
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
    [data-heroscrim] { background: linear-gradient(180deg, rgba(0,0,0,.58) 0%, rgba(0,0,0,.66) 50%, rgba(0,0,0,.82) 100%) !important; }
  }
  @media (max-width: 860px) {
    /* The open state lives on <html> so a re-render cannot clear it. */
    [data-menupanel] { display: none; }
    html[data-menu-open] [data-menupanel] { display: block !important; }
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
    aside[data-rail] > a:nth-of-type(2) {
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
    aside[data-rail] [data-sidelabel] {
      max-width: none !important; opacity: 1 !important; margin-left: 0 !important;
      font-size: 10.5px !important; font-weight: 700 !important; letter-spacing: -.045em !important;
      overflow: visible !important;
    }
    aside[data-rail] svg { width: 20px !important; height: 20px !important; }
    footer { padding-bottom: 152px !important; }
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
const preload = hero
  ? `<link rel="preload" as="image" href="${hero[1]}" fetchpriority="high">`
  : '';

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

fs.writeFileSync(path.join(outDir, 'index.html'), template);

// robots.txt and sitemap.xml ship beside the bundle and name the same authored
// origin, so they get the same treatment — a sitemap that declares the head
// office's URL as this page's location would undo the canonical fix.
for (const name of ['robots.txt', 'sitemap.xml']) {
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
