#!/usr/bin/env node
/**
 * Renders rewritten posts into static pages under /blog/.
 *
 * Design and type come from the landing page: same palette, same Pretendard subsets.
 * The 92 @font-face rules are written once to /fonts/pretendard.css and linked rather
 * than inlined per page — inline they would cost 46KB on every article, and linked
 * they are fetched once and shared across the whole section while still letting the
 * browser pull only the unicode ranges each page actually needs.
 *
 * Every page declares canonical against this site, not the Naver original. That is
 * only defensible because the articles are genuine rewrites; if they ever become
 * near-copies, this claim starts competing with a stronger page and loses.
 *
 * Usage: node tools/blog-render.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const POST_DIR = path.join(ROOT, 'content', 'posts');
const OUT_DIR = path.join(ROOT, 'blog');
const SITE = 'https://ilsan.anitok.com';
const ORG = '일산애니톡만화애니학원';
const BOOKING = 'https://booking.naver.com/booking/6/bizes/626887';
const TEL = '031-994-3134';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// --- frontmatter -----------------------------------------------------------
// A deliberately small YAML subset: scalars, inline arrays, and the faq list of
// q/a pairs. Anything richer belongs in the body, not the header.
function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) throw new Error('missing frontmatter');
  const meta = { faq: [] };
  let entry = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const item = line.match(/^\s*-\s+q:\s*(.+)$/);
    if (item) {
      entry = { q: unquote(item[1]), a: '' };
      meta.faq.push(entry);
      continue;
    }
    const cont = line.match(/^\s+a:\s*(.+)$/);
    if (cont && entry) {
      entry.a = unquote(cont[1]);
      continue;
    }
    const kv = line.match(/^([a-zA-Z]+):\s*(.*)$/);
    if (!kv) continue;
    if (kv[1] === 'faq') continue;
    const v = kv[2].trim();
    meta[kv[1]] = v.startsWith('[')
      ? v.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean)
      : unquote(v);
  }
  return { meta, body: m[2] };
}
const unquote = (s) => s.replace(/^["']|["']$/g, '').trim();

// --- webp dimensions -------------------------------------------------------
// Emitting width/height keeps the article from reflowing as photos arrive. Read
// straight from the header rather than shelling out to an image tool per file.
function webpSize(file) {
  let b;
  try {
    b = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (b.length < 30 || b.slice(8, 12).toString() !== 'WEBP') return null;
  const fmt = b.slice(12, 16).toString();
  if (fmt === 'VP8X') return { w: (b.readUIntLE(24, 3) & 0xffffff) + 1, h: (b.readUIntLE(27, 3) & 0xffffff) + 1 };
  if (fmt === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  if (fmt === 'VP8L') {
    const n = b.readUInt32LE(21);
    return { w: (n & 0x3fff) + 1, h: ((n >> 14) & 0x3fff) + 1 };
  }
  return null;
}

// --- markdown --------------------------------------------------------------
// The posts only ever use headings, paragraphs, images, lists, bold and links, so
// a full parser would be dead weight.
function markdown(md) {
  const blocks = md.split(/\r?\n\r?\n+/);
  const out = [];
  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;

    const img = block.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (img) {
      const [, alt, src] = img;
      const size = webpSize(path.join(ROOT, src.replace(/^\//, '')));
      const dim = size ? ` width="${size.w}" height="${size.h}"` : '';
      out.push(
        `<figure><img src="${esc(src)}" alt="${esc(alt)}"${dim} loading="lazy" decoding="async">` +
          (alt ? `<figcaption>${esc(alt)}</figcaption>` : '') +
          `</figure>`
      );
      continue;
    }

    const h = block.match(/^(#{2,3})\s+(.+)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }

    if (/^[-*]\s+/m.test(block) && block.split(/\r?\n/).every((l) => /^[-*]\s+/.test(l.trim()))) {
      const li = block.split(/\r?\n/).map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`);
      out.push(`<ul>${li.join('')}</ul>`);
      continue;
    }

    out.push(`<p>${inline(block.replace(/\r?\n/g, ' '))}</p>`);
  }
  return out.join('\n');
}

function inline(s) {
  return esc(s)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy" decoding="async">')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

// --- shared chrome ---------------------------------------------------------
const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
body{background:#000;color:#fff;font-family:'Pretendard Variable',Pretendard,-apple-system,sans-serif;letter-spacing:-.03em;-webkit-font-smoothing:antialiased;line-height:1.75}
a{color:#FF3B45;text-decoration:none}a:hover{text-decoration:underline}
header{position:sticky;top:0;z-index:60;background:#BD0D16;box-shadow:0 2px 20px rgba(0,0,0,.4)}
header>div{max-width:900px;margin:0 auto;padding:0 20px;height:64px;display:flex;align-items:center;justify-content:space-between;gap:12px}
header a.brand{display:flex;align-items:center;gap:9px;color:#fff;min-width:0}
header img{width:33px;height:33px;flex:0 0 auto;background:#fff;border-radius:50%}
header .nm{font-size:15px;font-weight:800;white-space:nowrap;letter-spacing:-.02em}
header .cta{flex:0 0 auto;white-space:nowrap;background:#fff;color:#BD0D16;font-size:13px;font-weight:800;padding:10px 16px;border-radius:999px}
main{max-width:760px;margin:0 auto;padding:56px 20px 96px}
h1{font-size:clamp(28px,5.4vw,40px);line-height:1.28;font-weight:800;letter-spacing:-.045em;margin-bottom:18px}
h2{font-size:clamp(21px,3.4vw,26px);font-weight:800;letter-spacing:-.04em;margin:52px 0 16px;padding-top:8px;border-top:1px solid #232326}
h3{font-size:18px;font-weight:800;margin:32px 0 12px}
p{font-size:16px;color:#D6D6DA;margin-bottom:18px;word-break:keep-all}
ul{margin:0 0 18px 20px}li{font-size:16px;color:#D6D6DA;margin-bottom:8px;word-break:keep-all}
figure{margin:32px 0}
figure img{display:block;width:100%;height:auto;border-radius:14px}
figcaption{margin-top:10px;font-size:13px;color:#8C8C8C;text-align:center;word-break:keep-all}
.meta{display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:13px;color:#9A9A9A;margin-bottom:36px}
.tag{background:#141416;border:1px solid #232326;border-radius:999px;padding:5px 12px;font-size:12px;color:#A8A8AC}
.lead{font-size:18px;color:#fff;font-weight:600;line-height:1.7;padding:20px 22px;background:#0F0F11;border-left:3px solid #BD0D16;border-radius:0 12px 12px 0;margin-bottom:32px;word-break:keep-all}
.cta-box{margin:56px 0 0;padding:30px 24px;background:#0F0F11;border:1px solid #232326;border-radius:18px;text-align:center}
.cta-box p{font-size:15px;margin-bottom:20px}
.cta-box .row{display:flex;flex-direction:column;gap:10px}
.cta-box a{display:block;padding:15px 20px;border-radius:999px;font-weight:800;font-size:15px}
.cta-box .primary{background:#BD0D16;color:#fff}
.cta-box .ghost{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.28);color:#fff}
.faq{margin-top:52px}
.faq h2{margin-top:0}
details{border-bottom:1px solid #232326}
summary{cursor:pointer;list-style:none;padding:18px 0;font-weight:700;font-size:16px;word-break:keep-all}
summary::-webkit-details-marker{display:none}
details p{padding-bottom:18px;margin:0}
.cards{display:grid;gap:16px}
.card{display:block;background:#0F0F11;border:1px solid #232326;border-radius:18px;overflow:hidden;color:inherit}
.card img{display:block;width:100%;height:180px;object-fit:cover}
.card .body{padding:20px}
.card h2{font-size:19px;margin:0 0 8px;border:0;padding:0}
.card p{font-size:14px;margin:0}
footer{border-top:1px solid #232326;padding:40px 20px 60px;text-align:center;color:#8C8C8C;font-size:13px}
footer a{color:#9A9A9A}
@media(min-width:720px){.cta-box .row{flex-direction:row;justify-content:center}.cta-box a{min-width:200px}}
`.trim();

const header = () =>
  `<header><div>` +
  `<a class="brand" href="/"><img src="/gal/logo.webp" alt="${ORG}"><span class="nm">${ORG}</span></a>` +
  `<a class="cta" href="${BOOKING}" target="_blank" rel="noopener" data-cta="booking" data-loc="blog-header">네이버 예약 상담</a>` +
  `</div></header>`;

const ctaBox = (where) =>
  `<div class="cta-box"><p>궁금한 점은 상담으로 바로 확인하실 수 있습니다.<br>${ORG} · 일산 백마학원가</p>` +
  `<div class="row">` +
  `<a class="primary" href="${BOOKING}" target="_blank" rel="noopener" data-cta="booking" data-loc="${where}">네이버 예약 상담 신청 →</a>` +
  `<a class="ghost" href="tel:${TEL}" data-cta="tel" data-loc="${where}">${TEL}</a>` +
  `</div></div>`;

const footer = () =>
  `<footer><p>${ORG} · 경기도 고양시 일산동구 일산로 200 3층 · ${TEL}</p>` +
  `<p style="margin-top:10px"><a href="/">홈으로</a> · <a href="/blog/">글 목록</a></p></footer>`;

function page({ title, description, canonical, head = '', body }) {
  return (
    `<!doctype html><html lang="ko"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)}</title>` +
    `<meta name="description" content="${esc(description)}">` +
    `<link rel="canonical" href="${canonical}">` +
    `<meta name="robots" content="index, follow, max-image-preview:large">` +
    `<link rel="icon" href="/favicon.ico" sizes="any">` +
    `<link rel="icon" type="image/png" sizes="32x32" href="/icon-32.png">` +
    `<link rel="apple-touch-icon" href="/apple-touch-icon.jpg">` +
    `<link rel="stylesheet" href="/fonts/pretendard.css">` +
    `<style>${CSS}</style>` +
    head +
    `</head><body>${body}</body></html>`
  );
}

// --- build -----------------------------------------------------------------
if (!fs.existsSync(POST_DIR)) {
  console.error('no content/posts yet');
  process.exit(1);
}

// Share the landing page's font declarations instead of duplicating them per page.
const landing = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const faces = [...landing.matchAll(/@font-face\{[^}]*\}/g)].map((m) => m[0]);
if (!faces.length) {
  console.error('no @font-face rules found in index.html — run build.js first');
  process.exit(1);
}
fs.writeFileSync(path.join(ROOT, 'fonts', 'pretendard.css'), faces.join('\n'));

const posts = fs
  .readdirSync(POST_DIR)
  .filter((f) => f.endsWith('.md'))
  .map((f) => {
    const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(POST_DIR, f), 'utf8'));
    if (!meta.slug) throw new Error(f + ': frontmatter has no slug');
    return { meta, body, file: f };
  })
  .sort((a, b) => String(b.meta.date).localeCompare(String(a.meta.date)));

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const post of posts) {
  const { meta, body } = post;
  const url = `${SITE}/blog/${meta.slug}/`;
  const html = markdown(body);

  // The first paragraph is written to answer the question outright — it is what an
  // AI answer engine quotes, so it is lifted out and given its own treatment.
  const firstP = html.match(/^<p>([\s\S]*?)<\/p>/);
  const lead = firstP ? `<div class="lead">${firstP[1]}</div>` : '';
  const rest = firstP ? html.slice(firstP[0].length) : html;

  const firstImg = (body.match(/!\[[^\]]*\]\(([^)]+)\)/) || [])[1];
  const ogImage = SITE + (firstImg || '/gal/hero2.webp');

  const graph = [
    {
      '@type': 'Article',
      '@id': url + '#article',
      headline: meta.title,
      description: meta.description,
      image: ogImage,
      datePublished: meta.date,
      dateModified: meta.date,
      inLanguage: 'ko-KR',
      keywords: (meta.keywords || []).join(', '),
      mainEntityOfPage: { '@type': 'WebPage', '@id': url },
      author: { '@type': 'Organization', name: ORG, '@id': SITE + '/#organization' },
      publisher: { '@id': SITE + '/#organization' },
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: '홈', item: SITE + '/' },
        { '@type': 'ListItem', position: 2, name: '학원 이야기', item: SITE + '/blog/' },
        { '@type': 'ListItem', position: 3, name: meta.title, item: url },
      ],
    },
  ];
  if (meta.faq && meta.faq.length) {
    graph.push({
      '@type': 'FAQPage',
      '@id': url + '#faq',
      mainEntity: meta.faq.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    });
  }

  const head =
    `<meta property="og:type" content="article">` +
    `<meta property="og:title" content="${esc(meta.title)}">` +
    `<meta property="og:description" content="${esc(meta.description)}">` +
    `<meta property="og:url" content="${url}">` +
    `<meta property="og:image" content="${ogImage}">` +
    `<meta property="og:site_name" content="${ORG}">` +
    `<meta property="og:locale" content="ko_KR">` +
    `<meta name="twitter:card" content="summary_large_image">` +
    `<meta name="twitter:title" content="${esc(meta.title)}">` +
    `<meta name="twitter:image" content="${ogImage}">` +
    `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': graph })}</script>`;

  const faqHtml = (meta.faq || []).length
    ? `<section class="faq"><h2>자주 묻는 질문</h2>` +
      meta.faq.map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('') +
      `</section>`
    : '';

  const bodyHtml =
    header() +
    `<main><article>` +
    `<h1>${esc(meta.title)}</h1>` +
    `<div class="meta"><time datetime="${meta.date}">${meta.date}</time>` +
    (meta.keywords || []).map((k) => `<span class="tag">${esc(k)}</span>`).join('') +
    `</div>` +
    lead +
    rest +
    faqHtml +
    ctaBox('blog-article') +
    `</article></main>` +
    footer();

  const dir = path.join(OUT_DIR, meta.slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    page({ title: meta.title + ' | ' + ORG, description: meta.description, canonical: url, head, body: bodyHtml })
  );
  console.log('  /blog/' + meta.slug + '/  ' + meta.title.slice(0, 40));
}

// index
const cards = posts
  .map((p) => {
    const img = (p.body.match(/!\[[^\]]*\]\(([^)]+)\)/) || [])[1];
    const size = img ? webpSize(path.join(ROOT, img.replace(/^\//, ''))) : null;
    return (
      `<a class="card" href="/blog/${p.meta.slug}/">` +
      (img
        ? `<img src="${esc(img)}" alt="${esc(p.meta.title)}"${size ? ` width="${size.w}" height="${size.h}"` : ''} loading="lazy" decoding="async">`
        : '') +
      `<div class="body"><h2>${esc(p.meta.title)}</h2><p>${esc(p.meta.description)}</p></div></a>`
    );
  })
  .join('');

fs.writeFileSync(
  path.join(OUT_DIR, 'index.html'),
  page({
    title: '학원 이야기 | ' + ORG,
    description: '일산 백마학원가 ' + ORG + '의 입시·수업 이야기. 만화·웹툰·애니메이션 준비에 필요한 내용을 정리했습니다.',
    canonical: SITE + '/blog/',
    head:
      `<script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Blog',
        '@id': SITE + '/blog/#blog',
        name: '학원 이야기',
        publisher: { '@id': SITE + '/#organization' },
        blogPost: posts.map((p) => ({ '@type': 'BlogPosting', headline: p.meta.title, url: SITE + '/blog/' + p.meta.slug + '/', datePublished: p.meta.date })),
      })}</script>`,
    body:
      header() +
      `<main><h1>학원 이야기</h1>` +
      `<p style="margin-bottom:36px">일산 백마학원가에서 만화 · 웹툰 · 애니메이션을 가르치며 정리한 이야기입니다.</p>` +
      `<div class="cards">${cards}</div>` +
      ctaBox('blog-index') +
      `</main>` +
      footer(),
  })
);

// sitemap
const urls = [
  { loc: SITE + '/', pri: '1.0' },
  { loc: SITE + '/blog/', pri: '0.8' },
  ...posts.map((p) => ({ loc: SITE + '/blog/' + p.meta.slug + '/', pri: '0.7', lastmod: p.meta.date })),
];
fs.writeFileSync(
  path.join(ROOT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls
      .map(
        (u) =>
          `  <url>\n    <loc>${u.loc}</loc>\n` +
          (u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>\n` : '') +
          `    <changefreq>monthly</changefreq>\n    <priority>${u.pri}</priority>\n  </url>`
      )
      .join('\n') +
    `\n</urlset>\n`
);

console.log('\n' + posts.length + ' post(s) rendered, /blog/ index and sitemap.xml updated');
