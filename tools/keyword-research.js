#!/usr/bin/env node
/**
 * Mines Naver autocomplete to find which keywords around the academy are actually
 * searched, and what searchers mean by them.
 *
 * What this measures: Naver only autocompletes queries people really type, ordered
 * roughly by how often. Presence is evidence of demand; rank is a rough ordering.
 *
 * What this does NOT measure: search volume or competition. Those need the Naver
 * 검색광고 keywordstool API and the Open API's result counts, both of which need
 * credentials this machine does not have. Nothing here should be read as a volume
 * figure.
 *
 * The intent check matters more than it sounds. "일산애니" autocompletes entirely to
 * 애니골, a restaurant district — targeting it would pull traffic with no interest in
 * an academy at all. Every candidate is checked for what else it completes to.
 *
 * Usage: node tools/keyword-research.js [--out content/keywords.json]
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : path.join(__dirname, '..', 'content', 'keywords.json');

// The academy is in 백마학원가, 일산동구. Neighbouring dongs and the towns whose
// students realistically commute are included; anything further is a different market.
const PLACES = [
  '일산', '고양', '백마', '마두', '정발산', '주엽', '대화', '화정', '행신',
  '탄현', '풍동', '식사동', '덕이동', '파주', '운정', '일산동구', '일산서구',
];
const TOPICS = [
  '만화학원', '웹툰학원', '애니메이션학원', '미술학원', '그림학원', '입시미술학원',
  '만화애니학원', '디지털드로잉', '일러스트학원', '캐릭터학원', '미대입시', '예고입시',
];
// Non-local queries worth knowing about: if the academy ranks for these it reaches
// beyond its own district.
const BARE = [...TOPICS, '웹툰과', '애니메이션과', '만화과', '청강대웹툰과', '애니고', '경기예고'];

// Words that reveal a query means something other than an academy.
const OFF_TOPIC = {
  애니골: '애니골 = 일산 맛집 거리',
  만화카페: '만화카페 수요',
  만화방: '만화방 수요',
  만화책: '만화책 구매/대여',
  대여: '만화 대여',
  맛집: '음식점',
  ott: '만화카페 부가서비스',
  닌텐도: '만화카페 부가서비스',
};

const AC =
  'https://ac.search.naver.com/nx/ac?q=%s&con=0&frm=nv&ans=2&r_format=json&r_enc=UTF-8' +
  '&r_unicode=0&t_koreng=1&run=2&rev=4&q_enc=UTF-8&st=100';

const cache = new Map();
function suggest(q) {
  if (cache.has(q)) return cache.get(q);
  let items = [];
  try {
    const raw = execFileSync('curl', ['-sS', '--max-time', '12', '-A', 'Mozilla/5.0', AC.replace('%s', encodeURIComponent(q))], {
      encoding: 'utf8',
    });
    items = ((JSON.parse(raw).items || [])[0] || []).map((a) => a[0]);
  } catch {
    items = [];
  }
  cache.set(q, items);
  return items;
}

const norm = (s) => s.replace(/\s+/g, '');

function assess(term) {
  const items = suggest(term);
  const flat = items.map(norm);
  const self = flat.indexOf(norm(term));

  const noise = [];
  for (const [word, why] of Object.entries(OFF_TOPIC)) {
    const hits = items.filter((i) => norm(i).includes(word)).length;
    if (hits) noise.push({ word, hits, why });
  }
  const offTopicShare = items.length ? noise.reduce((n, x) => n + x.hits, 0) / items.length : 0;

  return {
    term,
    suggested: items.length,
    selfRank: self < 0 ? null : self + 1, // 1-based; null = Naver does not complete to it
    siblings: items.slice(0, 8),
    offTopic: noise,
    offTopicShare: Math.round(offTopicShare * 100),
  };
}

const results = [];
const seen = new Set();
const add = (t) => {
  const k = norm(t);
  if (seen.has(k)) return;
  seen.add(k);
  results.push(assess(t));
};

console.log('probing…');
for (const p of PLACES) for (const t of TOPICS) add(p + t);
for (const t of BARE) add(t);

// Second pass: whatever Naver itself suggested that we had not thought to ask about,
// as long as it is still about learning to draw somewhere near here.
const discovered = new Set();
for (const r of results) {
  for (const s of r.siblings) {
    const n = norm(s);
    if (seen.has(n)) continue;
    if (!/(학원|입시|과|드로잉|일러스트)/.test(n)) continue;
    if (Object.keys(OFF_TOPIC).some((w) => n.includes(w))) continue;
    discovered.add(s);
  }
}
for (const d of [...discovered].slice(0, 40)) add(d);

// Ranked by: Naver completes to it at all, how near the top, and how clean the intent.
const scored = results
  .map((r) => ({
    ...r,
    score: (r.selfRank ? 100 - (r.selfRank - 1) * 8 : 0) + (r.suggested ? 10 : 0) - r.offTopicShare,
  }))
  .sort((a, b) => b.score - a.score);

const usable = scored.filter((r) => r.selfRank && r.offTopicShare < 40);
const noDemand = scored.filter((r) => !r.suggested);
const mismatched = scored.filter((r) => r.offTopicShare >= 40);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ probedAt: new Date().toISOString().slice(0, 10), results: scored }, null, 2));

console.log('\n검색 수요 확인됨 (네이버가 자동완성하는 것) — ' + usable.length + '개');
usable.slice(0, 25).forEach((r) => console.log('  ' + String(r.selfRank).padStart(2) + '위  ' + r.term));

if (mismatched.length) {
  console.log('\n검색 의도가 다름 — 쓰면 안 되는 키워드');
  mismatched.slice(0, 10).forEach((r) => console.log('  ' + r.term + '  (' + r.offTopic.map((o) => o.why).join(', ') + ')'));
}

console.log('\n자동완성 없음 (수요 거의 없음) — ' + noDemand.length + '개');
console.log('  ' + noDemand.slice(0, 14).map((r) => r.term).join(', '));
console.log('\n→ ' + OUT);
