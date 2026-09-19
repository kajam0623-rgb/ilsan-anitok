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

// 네이버 블로그에서 넘어온 분류는 반 이름·브랜드명·하트가 섞여 있어 그대로
// 내보낼 수 없다. 원본(프론트매터)은 건드리지 않고 화면에 나갈 이름만 묶는다.
const CATEGORY = {
  '초/중등반': '초·중등',
  '입시반(고1~3)': '입시',
  '미대입시반': '입시',
  '애니고예고반': '애니고·예고',
  '성인취미반': '성인 취미',
  '성인취미/CG반': '성인 취미',
  '동원장의 상담센터♥': '상담 이야기',
  '위치/수강안내': '수강 안내',
  '일산만화학원 애니톡': '공모전·수상',
};
const category = (c) => CATEGORY[c] || c || '';

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
  const toc = [];
  let hn = 0;
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
      // 한글 제목을 그대로 id 로 쓰면 같은 낱말이 두 번 나올 때 앵커가 겹친다.
      // 순번으로 두면 겹칠 일이 없고 주소도 짧다.
      const id = 's' + ++hn;
      toc.push({ level, id, text: h[2].replace(/\*\*/g, '') });
      out.push(`<h${level} id="${id}">${inline(h[2])}</h${level}>`);
      continue;
    }

    const lines = block.split(/\r?\n/).map((l) => l.trim());

    // 표. 머리줄 다음에 |---|---| 구분줄이 와야 표로 본다.
    if (lines.length >= 2 && /^\|.*\|$/.test(lines[0]) && /^\|[\s:|-]+\|$/.test(lines[1])) {
      const cells = (l) => l.slice(1, -1).split('|').map((c) => c.trim());
      const head = cells(lines[0]).map((c) => `<th>${inline(c)}</th>`).join('');
      const rows = lines
        .slice(2)
        .filter((l) => /^\|.*\|$/.test(l))
        .map((l) => `<tr>${cells(l).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
        .join('');
      // 좁은 화면에서 표가 본문을 밀지 않도록 가로 스크롤 상자에 넣는다.
      out.push(`<div class="tw"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`);
      continue;
    }

    // 번호 목록. 순서가 뜻을 가지는 단계 설명에만 쓴다.
    if (lines.every((l) => /^\d+\.\s+/.test(l))) {
      out.push(`<ol>${lines.map((l) => `<li>${inline(l.replace(/^\d+\.\s+/, ''))}</li>`).join('')}</ol>`);
      continue;
    }

    // 참고 박스. 첫 줄이 **굵게**면 그 부분이 상자 제목이 된다.
    if (lines.every((l) => /^>\s?/.test(l))) {
      const t = lines.map((l) => l.replace(/^>\s?/, '')).join(' ');
      const lead = t.match(/^\*\*(.+?)\*\*\s*(.*)$/);
      out.push(
        `<aside class="note">` +
          (lead ? `<b>${inline(lead[1])}</b>${lead[2] ? `<p>${inline(lead[2])}</p>` : ''}` : `<p>${inline(t)}</p>`) +
          `</aside>`
      );
      continue;
    }

    if (/^[-*]\s+/m.test(block) && block.split(/\r?\n/).every((l) => /^[-*]\s+/.test(l.trim()))) {
      const li = block.split(/\r?\n/).map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`);
      out.push(`<ul>${li.join('')}</ul>`);
      continue;
    }

    out.push(`<p>${inline(block.replace(/\r?\n/g, ' '))}</p>`);
  }
  return { html: out.join('\n'), toc };
}

// 읽는 시간. 한글 산문은 분당 700자 안팎으로 읽힌다. 마크다운 기호와 이미지
// 주소는 읽는 분량이 아니므로 빼고 센다. 부풀리면 첫 문장부터 신뢰를 잃는다.
function readingMinutes(md) {
  const text = md
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#>*|_-]/g, '');
  return Math.max(2, Math.round(text.replace(/\s/g, '').length / 700));
}

function inline(s) {
  return esc(s)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy" decoding="async">')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

// --- lint ------------------------------------------------------------------
// markdown() 이 못 알아보는 문법은 조용히 원문 그대로 새어 나간다. 표 구분줄을
// 빠뜨린 표가 파이프째 지면에 찍히는 사고를 한 번 겪었다. 사람이 눈으로 잡는
// 대신 빌드에서 막는다. 못 그리는 것은 안 그리는 편이 낫고, 잘못 그리는 것은
// 그보다 나쁘다.
function lintBody(file, body, firstLine) {
  // 줄 번호는 파일 기준으로 낸다. 본문 기준으로 세면 프론트매터 길이만큼 어긋나
  // 사람이 파일을 열었을 때 엉뚱한 줄을 보게 된다.
  const lineOf = (idx) => firstLine + (body.slice(0, idx).match(/\n/g) || []).length;
  const fail = (n, why) => {
    throw new Error(`${file}:${n}: ${why}`);
  };
  let cursor = 0;
  for (const raw of body.split(/\r?\n\r?\n+/)) {
    const start = body.indexOf(raw, cursor);
    cursor = start + raw.length;
    if (!raw.trim()) continue;
    const at = lineOf(start);
    const lines = raw.split(/\r?\n/);
    const t = lines.map((l) => l.trim());

    // 표: 머리줄 다음에 | --- | --- | 가 없으면 표로 그려지지 않고 파이프가 글자로 남는다.
    if (/^\|.*\|$/.test(t[0]) && !(t.length >= 2 && /^\|[\s:|-]+\|$/.test(t[1]))) {
      fail(at, '표에 구분줄이 없다. 이 줄 바로 아래에 | --- | --- | 를 넣을 것 — ' + t[0].slice(0, 40));
    }
    // 제목: ## 과 ### 만 그린다. # 과 #### 이상은 글자로 새어 나간다.
    for (const [i, l] of t.entries()) {
      const h = l.match(/^(#+)\s/);
      if (h && (h[1].length < 2 || h[1].length > 3)) {
        fail(at + i, `## 와 ### 만 쓸 수 있다(받은 것: ${h[1]}) — ` + l.slice(0, 40));
      }
    }
    // 굵게: ** 가 홀수면 한쪽이 안 닫힌 것이고, 별표가 그대로 남는다.
    if (((raw.match(/\*\*/g) || []).length) % 2) {
      fail(at, '굵게 표시(**)의 짝이 맞지 않는다. 별표가 글자로 남는다');
    }
  }
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
main.wide{max-width:1100px}
h1{font-size:clamp(28px,5.4vw,40px);line-height:1.28;font-weight:800;letter-spacing:-.045em;margin-bottom:18px}
h2{font-size:clamp(21px,3.4vw,26px);font-weight:800;letter-spacing:-.04em;margin:52px 0 16px;padding-top:8px;border-top:1px solid #232326}
h3{font-size:18px;font-weight:800;margin:32px 0 12px}
p{font-size:16px;color:#D6D6DA;margin-bottom:18px;word-break:keep-all}
ul,ol{margin:0 0 18px 20px}li{font-size:16px;color:#D6D6DA;margin-bottom:8px;word-break:keep-all}
ol{list-style:decimal}ol li::marker{color:#FF3B45;font-weight:800}
.tw{margin:0 0 24px;overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;min-width:460px;font-size:15px}
th,td{border:1px solid #232326;padding:11px 13px;text-align:left;vertical-align:top;word-break:keep-all}
th{background:#141416;font-weight:800;color:#fff;font-size:14px}
td{color:#D6D6DA}
.note{margin:0 0 24px;padding:18px 20px;background:#141416;border:1px solid #232326;border-radius:12px}
.note b{display:block;font-size:15px;color:#fff;margin-bottom:6px}
.note p{margin:0;font-size:15px}
.toc{margin:0 0 40px;padding:20px 22px;background:#0F0F11;border:1px solid #232326;border-radius:14px}
.toc b{display:block;font-size:13px;font-weight:800;letter-spacing:.12em;color:#8C8C8C;margin-bottom:12px}
.toc ol{margin:0;padding:0;list-style:none;counter-reset:toc}
.toc li{margin:0;font-size:15px;line-height:1.5;padding:5px 0}
.toc li.l2{counter-increment:toc}
.toc li.l2 a::before{content:counter(toc) ". ";color:#8C8C8C;font-weight:700}
.toc li.l3{padding-left:20px;font-size:14px}
.toc a{color:#D6D6DA}.toc a:hover{color:#FF3B45;text-decoration:none}
h2[id],h3[id]{scroll-margin-top:80px}
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
.cards{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}
.card{display:block;background:#0F0F11;border:1px solid #232326;border-radius:18px;overflow:hidden;color:inherit;transition:border-color .2s ease}
.card:hover{border-color:#3A3A40;text-decoration:none}
.card img,.card-ph{display:block;width:100%;height:170px;object-fit:cover}
.card-ph{background:linear-gradient(180deg,#17171A,#0F0F11)}
.card .body{padding:18px 20px 22px}
.card-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:10px;font-size:12px;color:#8C8C8C}
.cat{background:#2A0F11;border:1px solid #4A1418;color:#FF7A80;border-radius:6px;padding:3px 9px;font-size:12px;font-weight:700}
.card h2{font-size:17px;line-height:1.4;margin:0 0 8px;border:0;padding:0}
.card p{font-size:14px;margin:0;color:#9A9A9A}
.more{margin-top:56px}
.more h2{margin-top:0}
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
    const raw = fs.readFileSync(path.join(POST_DIR, f), 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    if (!meta.slug) throw new Error(f + ': frontmatter has no slug');
    // 프론트매터가 차지한 줄 수 + 1 이 본문 첫 줄의 파일 내 위치다.
    const firstLine = (raw.slice(0, raw.length - body.length).match(/\n/g) || []).length + 1;
    lintBody(f, body, firstLine);
    return { meta, body, file: f };
  })
  .sort((a, b) => String(b.meta.date).localeCompare(String(a.meta.date)));

fs.mkdirSync(OUT_DIR, { recursive: true });

// 지운 글의 페이지가 남지 않게 먼저 치운다. blog/ 가 저장소에 들어 있어서
// 정리하지 않으면 글을 지워도 주소는 그대로 살아 있다. 내린 글이 계속
// 서비스되는 상태가 가장 나쁘다.
{
  const keep = new Set(posts.map((p) => p.meta.slug));
  for (const name of fs.readdirSync(OUT_DIR)) {
    if (name === 'index.html' || keep.has(name)) continue;
    fs.rmSync(path.join(OUT_DIR, name), { recursive: true, force: true });
    console.log('  지운 글의 페이지를 치웠다: /blog/' + name + '/');
  }
}

// 목록과 글 하단이 같은 카드를 쓴다. 한쪽만 고쳐 두 곳이 어긋나는 일을 막는다.
function card(p) {
  const img = (p.body.match(/!\[[^\]]*\]\(([^)]+)\)/) || [])[1];
  const size = img ? webpSize(path.join(ROOT, img.replace(/^\//, ''))) : null;
  return (
    `<a class="card" href="/blog/${p.meta.slug}/">` +
    (img
      ? `<img src="${esc(img)}" alt="${esc(p.meta.title)}"${size ? ` width="${size.w}" height="${size.h}"` : ''} loading="lazy" decoding="async">`
      : `<span class="card-ph" aria-hidden="true"></span>`) +
    `<div class="body">` +
    `<div class="card-meta">` +
    (category(p.meta.category) ? `<span class="cat">${esc(category(p.meta.category))}</span>` : '') +
    `<time datetime="${p.meta.date}">${p.meta.date}</time>` +
    `</div>` +
    `<h2>${esc(p.meta.title)}</h2><p>${esc(p.meta.description)}</p></div></a>`
  );
}

for (const post of posts) {
  const { meta, body } = post;
  const url = `${SITE}/blog/${meta.slug}/`;
  const { html, toc } = markdown(body);

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

  // 목차는 제목이 세 개 이상일 때만 세운다. 두 개짜리 목차는 자리만 차지한다.
  const tocHtml =
    toc.length >= 3
      ? `<nav class="toc" aria-label="목차"><b>목차</b><ol>` +
        toc.map((t) => `<li class="l${t.level}"><a href="#${t.id}">${esc(t.text)}</a></li>`).join('') +
        `</ol></nav>`
      : '';

  // 같은 반을 찾아온 독자에게는 같은 반 이야기가 먼저 걸린다. 모자라면 최신 글로 채운다.
  const related = [
    ...posts.filter((p) => p.meta.slug !== meta.slug && p.meta.category === meta.category),
    ...posts.filter((p) => p.meta.slug !== meta.slug && p.meta.category !== meta.category),
  ].slice(0, 3);
  const relatedHtml = related.length
    ? `<section class="more"><h2>이어서 읽어보세요</h2><div class="cards">` +
      related.map((p) => card(p)).join('') +
      `</div></section>`
    : '';

  const bodyHtml =
    header() +
    `<main><article>` +
    `<h1>${esc(meta.title)}</h1>` +
    `<div class="meta">` +
    (category(meta.category) ? `<span class="cat">${esc(category(meta.category))}</span>` : '') +
    `<time datetime="${meta.date}">${meta.date}</time>` +
    `<span>읽는 시간 ${readingMinutes(body)}분</span>` +
    (meta.keywords || []).map((k) => `<span class="tag">${esc(k)}</span>`).join('') +
    `</div>` +
    lead +
    tocHtml +
    rest +
    faqHtml +
    ctaBox('blog-article') +
    relatedHtml +
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

const cards = posts.map((p) => card(p)).join('');

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
      `<main class="wide"><h1>학원 이야기</h1>` +
      `<p style="margin-bottom:36px">일산 백마학원가에서 만화 · 웹툰 · 애니메이션을 가르치며 정리한 이야기입니다.</p>` +
      `<div class="cards">${cards}</div>` +
      ctaBox('blog-index') +
      `</main>` +
      footer(),
  })
);

// sitemap
// 랜딩의 lastmod 는 손으로 관리하는 bundle/sitemap.xml 에 적혀 있다. 여기서
// 지어내면 글 하나 올릴 때마다 랜딩까지 바뀐 것처럼 보고하게 된다.
const authoredLastmod = (() => {
  try {
    const src = fs.readFileSync(path.join(ROOT, 'bundle', 'sitemap.xml'), 'utf8');
    return (src.match(/<lastmod>([^<]+)<\/lastmod>/) || [])[1] || null;
  } catch {
    return null;
  }
})();
// 목록의 lastmod 는 가장 최근 글의 날짜다. 글이 없으면 붙이지 않는다.
const newest = posts.reduce((a, p) => (p.meta.date > a ? p.meta.date : a), '');
const urls = [
  { loc: SITE + '/', pri: '1.0', lastmod: authoredLastmod },
  { loc: SITE + '/blog/', pri: '0.8', lastmod: newest || null },
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
