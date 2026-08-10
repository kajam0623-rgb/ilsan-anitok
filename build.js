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

fs.writeFileSync(path.join(outDir, 'index.html'), template);

const kb = (n) => (n / 1024).toFixed(0).padStart(6) + ' KB';
console.log(`index.html   ${kb(Buffer.byteLength(template))}  (${lazied} img -> lazy)`);
console.log(`fonts/       ${kb(bytes.fonts)}  (${written.fonts} files)`);
console.log(`gal/         ${kb(bytes.gal)}  (${written.gal} files)`);
console.log(`js/          ${kb(bytes.js)}  (${written.js} files)`);
