#!/usr/bin/env node
/**
 * Stages posts from the academy's own Naver blog for rewriting.
 *
 * The RSS feed carries only a ~500 character excerpt, so each item's body is fetched
 * separately from PostView.naver — the public /blogId/logNo URL is a 3KB shell around
 * an iframe and contains no article text. Images sit on postfiles.pstatic.net and are
 * refused without a blog.naver.com referer; they are pulled with one and re-hosted
 * rather than hotlinked. They are the school's own photographs, and serving them from
 * the site keeps them under the same sizing and cache rules as everything else.
 *
 * This writes source material only. Nothing it produces is publishable — rewriting is
 * a separate step (tools/blog-rewrite.js).
 *
 * Usage: node tools/blog-fetch.js [--limit N] [--force]
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FEED = 'https://rss.blog.naver.com/anitalk-ilsan.xml';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'content', 'sources');

const args = process.argv.slice(2);
const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1], 10) : 5;
const force = args.includes('--force');

const curl = (url, extra = []) =>
  execFileSync('curl', ['-sS', '--max-time', '30', '-A', UA, ...extra, url], {
    maxBuffer: 64 * 1024 * 1024,
  });

const cdata = (s) => s.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
const field = (block, tag) => {
  const m = block.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
  return m ? cdata(m[1]) : '';
};

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/​/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function fetchPost(logNo) {
  const url =
    'https://blog.naver.com/PostView.naver?blogId=anitalk-ilsan&logNo=' +
    logNo +
    '&redirect=Dlog&widgetTypeCall=true&directAccess=false';
  const html = curl(url).toString('utf8');

  const start = html.indexOf('se-main-container');
  if (start < 0) return null;
  const end = html.indexOf('post_footer', start);
  const body = html.slice(start, end > 0 ? end : undefined);

  // data-lazy-src holds the real asset; src is a placeholder until the reader scrolls.
  const images = [...new Set([...body.matchAll(/data-lazy-src="([^"]+)"/g)].map((m) => m[1]))]
    .filter((u) => /postfiles\.pstatic\.net/.test(u))
    .map((u) => u.split('?')[0] + '?type=w966');

  return { text: stripHtml(body), images };
}

fs.mkdirSync(SRC_DIR, { recursive: true });
const xml = curl(FEED).toString('utf8');
const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
console.log('feed: ' + items.length + ' items');

let staged = 0;
for (const item of items) {
  if (staged >= limit) break;

  const guid = field(item, 'guid');
  const logNo = (guid.match(/(\d+)\s*$/) || [])[1];
  if (!logNo) continue;

  const out = path.join(SRC_DIR, logNo + '.json');
  if (fs.existsSync(out) && !force) continue;

  const title = field(item, 'title');
  const post = fetchPost(logNo);
  if (!post || post.text.length < 300) {
    console.log('  skip   ' + logNo + '  (no body recovered)');
    continue;
  }

  const imgDir = path.join(ROOT, 'gal', 'blog', logNo);
  fs.mkdirSync(imgDir, { recursive: true });

  const saved = [];
  const pending = [];
  post.images.forEach((src, i) => {
    const webp = path.join(imgDir, i + '.webp');
    if (!fs.existsSync(webp)) {
      const jpg = path.join(imgDir, i + '.jpg');
      fs.writeFileSync(jpg, curl(src, ['-e', 'https://blog.naver.com/']));
      pending.push(jpg);
    }
    saved.push('/gal/blog/' + logNo + '/' + i + '.webp');
  });

  // One conversion pass per post, not per image: npx costs several seconds of startup
  // each time, which at a dozen photos an article dominates the whole run.
  // 1200px covers the widest slot the article layout renders at 2x on a phone;
  // anything beyond that is bytes no reader ever sees.
  if (pending.length) {
    execFileSync(
      'npx',
      ['--yes', 'sharp-cli', '-i', ...pending, '-o', imgDir, '-f', 'webp', 'resize', '1200', '--withoutEnlargement'],
      { stdio: 'ignore', shell: true }
    );
    pending.forEach((jpg) => fs.existsSync(jpg) && fs.unlinkSync(jpg));
  }

  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        logNo: logNo,
        sourceTitle: title,
        sourceUrl: guid,
        category: field(item, 'category'),
        tags: field(item, 'tag').split(',').map((s) => s.trim()).filter(Boolean),
        publishedAt: new Date(field(item, 'pubDate')).toISOString().slice(0, 10),
        body: post.text,
        images: saved,
      },
      null,
      2
    )
  );
  console.log(
    '  staged ' + logNo + '  ' + post.text.length + ' chars, ' + saved.length + ' images  ' + title.slice(0, 36)
  );
  staged++;
}

console.log('\n' + staged + ' post(s) staged in content/sources/');
