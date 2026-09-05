#!/usr/bin/env node
/**
 * Rewrites a staged Naver post into an article for this site, via Codex CLI.
 *
 * Why a rewrite and not a copy: the Naver original is already indexed and its domain
 * outranks this one. A near-duplicate does not sit alongside it — a search engine
 * keeps one and drops the other, and the one it keeps is the blog. The site version
 * has to be a genuinely different piece, organised around what someone searching
 * "일산만화학원" wants to know. Reworded sentences do not achieve that.
 *
 * Codex runs read-only and returns the article on stdout between sentinels; this
 * script validates it and writes the file. Codex needs no write access for a
 * writing task, and keeping the write here means nothing reaches the repo without
 * passing the checks below.
 *
 * Usage: node tools/blog-rewrite.js [logNo ...]   (default: sources without a post)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'content', 'sources');
const POST_DIR = path.join(ROOT, 'content', 'posts');
const BEGIN = '<<<POST_BEGIN>>>';
const END = '<<<POST_END>>>';

fs.mkdirSync(POST_DIR, { recursive: true });

const wanted = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
const sources = fs
  .readdirSync(SRC_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(SRC_DIR, f), 'utf8')))
  .filter((s) => (wanted.length ? wanted.includes(s.logNo) : !fs.existsSync(path.join(POST_DIR, s.logNo + '.md'))));

if (!sources.length) {
  console.log('nothing to rewrite');
  process.exit(0);
}

function prompt(src) {
  return `당신은 "일산애니톡만화애니학원"의 콘텐츠 담당자다. 경기도 고양시 일산동구 백마학원가에 있는 만화·웹툰·애니메이션 전문 입시학원이다.

아래는 이 학원이 자사 네이버 블로그에 올린 글의 원문이다. 이것을 학원 공식 홈페이지에 실을 글로 **다시 쓴다**.

## 왜 다시 쓰는가
네이버 원문은 이미 색인돼 있고 도메인 신뢰도도 그쪽이 높다. 홈페이지에 비슷한 글을 올리면 검색엔진이 둘 중 하나만 남긴다. 남는 쪽은 네이버다. 문장만 바꾼 글은 가치가 없다. **진입 각도와 구조가 다른 별개의 글**이어야 한다.
- 원문이 상담 일화로 시작하면, 홈페이지 글은 질문에 대한 답부터 시작한다
- 원문 순서를 따라가지 말고, 검색해 들어온 사람이 궁금해하는 순서로 재배열한다
- 원문의 사실·수치·사례는 살리되 설명과 맥락은 새로 쓴다

## 절대 규칙
- **원문에 없는 사실을 지어내지 마라.** 합격 실적, 수상 내역, 연도, 인원수, 학교명은 원문에 있는 것만 쓴다. 학원 홍보물이라 없는 실적을 만들면 실제 피해가 생긴다.
- 근거가 없으면 그 문장은 뺀다. 애매하면 뺀다.
- 학생 이름은 원문처럼 익명(김ㅇㅇ)으로 둔다.

## 검색 최적화
- **타겟 키워드: ${src.targetKeyword || src.tags[0] || '일산만화학원'}** — 이 글은 이 검색어 하나를 노린다
${src.keywordRationale ? '  (배정 근거: ' + src.keywordRationale + ')' : ''}
- 보조 키워드: ${(src.supportKeywords || src.tags.slice(0, 3)).join(', ')}
- 제목 30~40자, **타겟 키워드를 그대로** 포함(띄어쓰기까지 유지)
- 첫 문단과 h2 하나에 타겟 키워드가 들어가되 억지 반복 금지. 보조 키워드는 맥락이 맞는 곳에만.
- description 80~120자, 타겟 키워드 포함
- 이 키워드는 네이버 자동완성으로 실제 검색 수요를 확인한 것이다. 다른 키워드로 바꾸지 마라.
- 다른 글이 각자 다른 키워드를 맡고 있다. 배정된 것 외의 지역·학과 키워드를 끌어와 채우지 마라.

## AI 검색 대응
- **첫 문단이 질문에 대한 직접적인 답이어야 한다.** 2~3문장으로 결론부터. AI가 인용하는 건 이 덩어리다.
- h2는 사람이 실제로 검색할 법한 질문 형태로 쓴다
- 각 h2 아래 첫 문장은 앞 문맥 없이도 뜻이 통하는 완결된 답으로 쓴다
- 구체적인 숫자·기간·학교명을 문장 안에 남긴다

## 형식
- 한국어. 학원이 학부모·학생에게 말하는 톤. 과장·낚시 금지.
- 본문 1,200~1,800자, h2 3~5개, 각 h2 아래 2~4문단
- 사용 가능한 이미지 ${src.images.length}장:
${src.images.map((p, i) => '  [' + i + '] ' + p).join('\n')}
  이 중 3~6장을 흐름에 맞는 위치에 배치하고 내용을 설명하는 alt를 붙인다. "이미지", "사진" 같은 장식 문구 금지.

## 출력 방법
${BEGIN} 과 ${END} 사이에 글만 출력한다. 파일을 만들지 마라. 설명·요약·인사말을 붙이지 마라.

${BEGIN}
---
title: "제목"
description: "메타 설명"
keywords: ["키워드1", "키워드2", "키워드3"]
slug: "url-slug-in-english"
date: "${src.publishedAt}"
category: "${src.category}"
sourceUrl: "${src.sourceUrl}"
faq:
  - q: "질문"
    a: "답변 한두 문장"
---

본문 마크다운. h2는 "## ", 이미지는 "![alt](경로)".
${END}

slug는 소문자 영문·숫자·하이픈만 (예: ilsan-webtoon-talent).
faq는 본문에서 뽑은 실제 질답 2~3개. 근거가 없으면 faq 항목을 비운다.

---
# 원문 (블로그 제목: ${src.sourceTitle})

${src.body}
`;
}

// Structural checks only — they cannot catch an invented statistic, which is why the
// prompt forbids inventing one and why a person still reads the draft before it ships.
function validate(md, src) {
  const problems = [];
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fm) return ['no frontmatter'];
  const head = fm[1];
  const body = fm[2];

  for (const key of ['title', 'description', 'slug', 'date']) {
    if (!new RegExp('^' + key + ':\\s*\\S', 'm').test(head)) problems.push('missing ' + key);
  }
  const slug = (head.match(/^slug:\s*"?([^"\n]+)"?/m) || [])[1];
  if (slug && !/^[a-z0-9-]+$/.test(slug.trim())) problems.push('slug not url-safe: ' + slug);

  const chars = body.replace(/\s+/g, '').length;
  if (chars < 700) problems.push('body too short: ' + chars + ' chars');
  if ((body.match(/^## /gm) || []).length < 2) problems.push('fewer than 2 sections');

  // Every referenced image must be one that was actually downloaded, or the page
  // ships a broken figure.
  for (const m of body.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    if (!src.images.includes(m[1])) problems.push('unknown image: ' + m[1]);
    if (!/!\[[^\]]+\]/.test(m[0])) problems.push('image without alt text');
  }
  return problems;
}

let ok = 0;
for (const src of sources) {
  process.stdout.write('rewriting ' + src.logNo + ' … ');
  const started = Date.now();

  const res = spawnSync('codex', ['exec', '-s', 'read-only', '-'], {
    input: prompt(src),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: true,
    timeout: 20 * 60 * 1000,
  });
  const secs = Math.round((Date.now() - started) / 1000);
  const stdout = String(res.stdout || '');

  const cut = stdout.match(new RegExp(BEGIN + '\\r?\\n([\\s\\S]*?)\\r?\\n' + END));
  if (!cut) {
    console.log('FAILED ' + secs + 's — no delimited output');
    fs.writeFileSync(path.join(POST_DIR, src.logNo + '.failed.log'), stdout);
    continue;
  }

  // Codex sometimes escapes the slashes in image paths (\/gal\/blog\/…), which is
  // valid JSON-string habit leaking into markdown. Harmless and deterministic, so it
  // is normalised rather than bounced back for a rerun.
  const md = cut[1].trim().replace(/\\\//g, '/') + '\n';
  const problems = validate(md, src);
  if (problems.length) {
    console.log('REJECTED ' + secs + 's — ' + problems.join('; '));
    fs.writeFileSync(path.join(POST_DIR, src.logNo + '.rejected.md'), md);
    continue;
  }

  fs.writeFileSync(path.join(POST_DIR, src.logNo + '.md'), md);
  const body = md.replace(/^---[\s\S]*?\n---\n/, '');
  console.log(
    'ok ' + secs + 's  ' + body.replace(/\s+/g, '').length + ' chars, ' +
      (body.match(/^## /gm) || []).length + ' sections, ' +
      (body.match(/!\[/g) || []).length + ' images'
  );
  ok++;
}

console.log('\n' + ok + '/' + sources.length + ' written to content/posts/');
