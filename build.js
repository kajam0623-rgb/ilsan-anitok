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
const TITLE = '일산만화학원 일산웹툰학원 | 일산애니톡만화애니학원';
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

// Headings carried neither target phrase — the h1 read "만화애니 학원의 정답! 일산애니톡!"
// and all nine h2s were mood copy. After <title>, headings are the next strongest
// on-page signal, so both phrases go in the h1 and one h2 takes the 만화학원 phrase.
// The rest of the headings are left alone: repeating the phrase down the page reads
// as stuffing to a human and buys nothing from a ranker.
seo(
  /만화애니 학원의 정답!<br>(<span style="color:#[0-9A-Fa-f]{6}">)일산애니톡!/,
  (_, span) => `일산만화학원 · 일산웹툰학원<br>정답은 ${span}일산애니톡!`
);
seo(/그림 하나로<br>하루를 채우는 공간/, () => '일산만화학원 애니톡<br>그림 하나로 하루를 채우는 공간');

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
const charset = template.match(/<meta charset="[^"]*">/i);
if (charset) template = template.replace(charset[0], '');
const at = headOpen.index + headOpen[0].length;
template =
  template.slice(0, at) +
  (charset ? charset[0] : '<meta charset="utf-8">') +
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
    `${seoEdits} seo edits)`
);
console.log(`fonts/       ${kb(bytes.fonts)}  (${written.fonts} files)`);
console.log(`gal/         ${kb(bytes.gal)}  (${written.gal} files)`);
console.log(`js/          ${kb(bytes.js)}  (${written.js} files)`);
