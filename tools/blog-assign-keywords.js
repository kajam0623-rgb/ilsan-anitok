#!/usr/bin/env node
/**
 * Gives each staged post its own target keyword.
 *
 * Ten articles all aimed at 일산만화학원 do not rank ten times — they compete with
 * each other for one slot and split whatever authority the section earns. Each post
 * gets a distinct primary keyword instead, matched to what that post is actually
 * about, so the section covers a spread of queries rather than stacking on one.
 *
 * Every keyword here was checked against Naver autocomplete (tools/keyword-research.js).
 * Naver only completes queries people really type, so a term that autocompletes has
 * demand behind it. Terms that did not autocomplete are listed at the bottom and are
 * deliberately not used — 일산웹툰학원 among them, despite the site currently putting
 * it in the homepage title.
 *
 * Assignments are honest matches, not stretches: a geographic variant is only used
 * where the article genuinely speaks to students from that area.
 *
 * Usage: node tools/blog-assign-keywords.js
 */

const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'content', 'sources');

// primary: the one query this article is written to win.
// support: related terms that belong in the copy where they fit naturally.
const PLAN = {
  '224376694697': {
    primary: '일산만화학원',
    support: ['웹툰학과', '애니과', '그림 재능'],
    why: '학원 이름값 그대로의 핵심 키워드. 자동완성 1위.',
  },
  '224327324789': {
    primary: '청강대 웹툰과 내신',
    support: ['청강대 웹툰과 수시', '내신 등급', '만화애니 입시'],
    why: '내신 6.9등급 합격 사례라 내신 롱테일과 정확히 맞는다.',
  },
  '224328355787': {
    primary: '초등 미술학원',
    support: ['일산 미술학원', '초등 미술학원 고르는법', '웹툰'],
    why: '초3 학생 성장기. 초등 미술학원은 자동완성 6건으로 수요가 넓다.',
  },
  '224335139573': {
    primary: '일산미술학원',
    support: ['청강대 공모전', '실기대전', '백마학원가'],
    why: '공모전 입상 실적 글. 지역 대표 키워드에 실적으로 붙인다.',
  },
  '224341864749': {
    primary: '중학생 미술학원',
    support: ['일산 미술학원', '웹툰', '캐릭터'],
    why: '초·중생 대상 안내 글.',
  },
  '224350331153': {
    primary: '청강대 웹툰과 실기',
    support: ['청강대 웹툰과 경쟁률', '청강대 웹툰과 포트폴리오', '청강대 만화과'],
    why: '2027 입시 분석 글. 실기·경쟁률·포폴 롱테일이 전부 붙는다.',
  },
  '224351847587': {
    primary: '운정 만화학원',
    support: ['파주 만화학원', '중학생 미술학원', '일산만화학원'],
    why: '중학생 실력 변화 사례. 운정·파주에서 통학하는 학생층에 정직하게 닿는다.',
  },
  '224352076052': {
    primary: '청강대 애니메이션과 가는법',
    support: ['청강대 애니메이션과', '애니메이션과 입시'],
    why: '청강대 애니과 입시 분석 글과 그대로 대응.',
  },
  '224352328619': {
    primary: '만화학원',
    support: ['만화학원 고르는법', '웹툰학원', '미대입시'],
    why: '학원 고르는 기준을 다루는 글이라 지역을 뺀 상위 키워드가 맞다.',
  },
  '224361490631': {
    primary: '미대입시 수시',
    support: ['학생부전형', '만화애니과 입시', '내신 5등급제'],
    why: '학생부전형 분석 글.',
  },
  '224364975940': {
    primary: '일산 일러스트학원',
    support: ['웹툰학원', '초등 미술학원', '일산 미술학원'],
    why: '"미술학원 말고 어디"가 주제. 일러스트 학원 수요와 겹친다.',
  },
  '224372191796': {
    primary: '화정 미술학원',
    support: ['일산미술학원', '백마학원가', '신한엽서공모전'],
    why: '수상 실적 글. 화정은 자동완성이 잡히는 인접 상권이라 실적으로 진입한다.',
  },

  // 2차 10편. 동네 단위(후곡·마두·주엽·풍동·백석동)는 전부 자동완성 0건이라 쓰지 않았다.
  '224268579145': {
    primary: '초등 미술학원 고르는법',
    support: ['초등 미술학원', '일산미술학원'],
    why: '칭찬법을 다루는 학부모 대상 글. 고르는 기준을 찾는 검색과 맞는다.',
  },
  '224270875494': {
    primary: '식사동 미술학원',
    support: ['일산미술학원', '백마학원가', '만화학원'],
    why: '어느 동네에서 통학하는지가 글의 주제다. 식사동은 자동완성이 잡힌다.',
  },
  '224272597471': {
    primary: '취미만화학원',
    support: ['만화학원 취미반', '초등 미술학원'],
    why: '키링 만들기 활동 글. 취미 수요와 맞는다.',
  },
  '224277045383': {
    primary: '웹툰학원',
    support: ['웹툰작가 되는법', '중학생 미술학원'],
    why: '중학생 웹툰작가 지망 글. 지역 없는 상위 키워드로 붙인다.',
  },
  '224279361745': {
    primary: '성인취미미술학원',
    support: ['디지털 드로잉 학원', '만화학원 취미반'],
    why: '직장인 디지털드로잉 비포애프터. 성인 취미 수요와 정확히 맞는다.',
  },
  '224287417822': {
    primary: '애니메이션학원',
    support: ['만화학원', '초등 미술학원'],
    why: '어느 학원에 보낼지 묻는 글.',
  },
  '224294400828': {
    primary: '청강대 웹툰과 주제',
    support: ['청강대 실기대전', '청강대 웹툰과 실기'],
    why: '실기대전 주제 정리 글과 그대로 대응.',
  },
  '224307215002': {
    primary: '애니메이션과 입시',
    support: ['한예종 애니메이션과', '미대입시 수시'],
    why: '2027 입시 변경 분석. 한예종 단독 키워드는 자동완성 0건이라 상위어로 잡았다.',
  },
  '224323264733': {
    primary: '청강대 웹툰과 포트폴리오',
    support: ['청강대 만화과', '청강대 웹툰과 합격작'],
    why: '포폴 합격작 공개 글.',
  },
  '224327365049': {
    primary: '파주 만화학원',
    support: ['운정 만화학원', '일산만화학원', '백마학원가'],
    why: '통학 범위를 안내하는 글이라 인접 도시 검색에 정직하게 닿는다.',
  },
};

// Checked and rejected: Naver returns no autocomplete for these, so there is close to
// no demand behind them. Kept here so nobody re-adds them from intuition.
const NO_DEMAND = [
  '일산웹툰학원', '일산애니메이션학원', '일산그림학원', '일산입시미술학원',
  '일산만화애니학원', '일산캐릭터학원', '일산미대입시', '일산예고입시',
  '고양만화학원', '고양웹툰학원', '고양미술학원',
];
// Checked and rejected for intent: autocomplete shows a different meaning entirely.
const WRONG_INTENT = { 일산애니: '애니골 — 맛집 거리', 애니고: '애니골', 일산만화: '만화카페·만화방이 상위' };

let updated = 0;
for (const [logNo, plan] of Object.entries(PLAN)) {
  const file = path.join(SRC_DIR, logNo + '.json');
  if (!fs.existsSync(file)) {
    console.log('  missing source ' + logNo);
    continue;
  }
  const src = JSON.parse(fs.readFileSync(file, 'utf8'));
  src.targetKeyword = plan.primary;
  src.supportKeywords = plan.support;
  src.keywordRationale = plan.why;
  fs.writeFileSync(file, JSON.stringify(src, null, 2));
  console.log('  ' + logNo + '  → ' + plan.primary);
  updated++;
}

console.log('\n' + updated + ' source(s) assigned');
console.log('수요 없어 제외: ' + NO_DEMAND.join(', '));
console.log('의도 불일치로 제외: ' + Object.entries(WRONG_INTENT).map(([k, v]) => k + ' (' + v + ')').join(', '));
