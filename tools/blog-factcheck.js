#!/usr/bin/env node
/**
 * Flags factual claims in a rewritten post that do not appear in its source.
 *
 * These are advertisements for a school: admission results, award years, student
 * counts. A rewrite that invents one is not a style problem, it is a false claim
 * about a real business. The rewriter is told not to, but "told not to" is not a
 * control, so every number and every institution name in the draft is checked back
 * against the post it came from.
 *
 * This catches invented figures, not misread ones — a number lifted from the source
 * and attached to the wrong thing still reads as present. A person confirms the
 * draft before it ships.
 *
 * Usage: node tools/blog-factcheck.js [logNo ...]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'content', 'sources');
const POST_DIR = path.join(ROOT, 'content', 'posts');

const wanted = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
const posts = fs
  .readdirSync(POST_DIR)
  .filter((f) => /^\d+\.md$/.test(f))
  .filter((f) => !wanted.length || wanted.includes(f.replace('.md', '')));

// Digits are compared without separators so "3,000" in the source matches "3000" in
// the draft. Institution names are matched on the distinctive stem, since a draft may
// write 청강문화산업대학교 where the source wrote 청강대.
const normalise = (s) => s.replace(/[,\s]/g, '');
const SCHOOL = /([가-힣]{2,10}(?:대학교|대학|예대|고등학교|예고|애니고))/g;

let flagged = 0;
for (const file of posts) {
  const logNo = file.replace('.md', '');
  const srcPath = path.join(SRC_DIR, logNo + '.json');
  if (!fs.existsSync(srcPath)) {
    console.log(logNo + ': no source to check against');
    continue;
  }
  const src = normalise(JSON.parse(fs.readFileSync(srcPath, 'utf8')).body);
  const raw = fs.readFileSync(path.join(POST_DIR, file), 'utf8');
  // Image paths carry digits that are not claims, so they come out first.
  const prose = raw.replace(/^---[\s\S]*?\n---\n/, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  const body = normalise(prose);

  const issues = [];

  // Numbers: 2 digits or more, ignoring image paths and dates already stripped above.
  for (const n of new Set(body.match(/\d{2,}/g) || [])) {
    if (!src.includes(n)) issues.push('숫자 ' + n);
  }
  // Institution names.
  // Matched against the spaced text: with whitespace already collapsed, the leading
  // [가-힣] run swallows whatever words sit in front of the school name.
  for (const m of new Set(prose.match(SCHOOL) || [])) {
    const stem = m.replace(/(대학교|대학|예대|고등학교|예고|애니고)$/, '');
    // Sources use the short form the school is known by (청강대, 계원예대) while a
    // draft may expand it to the registered name (청강문화산업대학교). Matching the
    // full stem misses that, so the two-character root is accepted as well. Loose on
    // purpose: this flags claims for a person to check, and noise gets it ignored.
    if (!src.includes(stem) && !src.includes(stem.slice(0, 2))) issues.push('학교 ' + m);
  }

  if (issues.length) {
    flagged++;
    console.log('\n' + logNo + '  원문에서 확인 안 되는 항목 ' + issues.length + '건');
    issues.forEach((i) => console.log('   - ' + i));
  } else {
    console.log(logNo + '  ok — 모든 숫자·학교명이 원문에 있음');
  }
}

if (flagged) {
  console.log('\n' + flagged + '건에 확인 필요 항목이 있다. 사람이 원문과 대조한 뒤 발행할 것.');
  process.exit(1);
}
