'use strict';

const TIME_LIMIT_SECONDS = 10;
const PROGRESS_KEY = 'vocab_progress_v3';
const RELATION_KEY = 'vocab_relations_visible_v3';
let words = [];
let currentList = [];
let currentIndex = 0;
let mode = 'ko2en';
let sessionType = 'flash';
let known = new Set();
let unknown = new Set();
let quizCount = 'all';
let quizList = [];
let quizIndex = 0;
let quizAnswered = false;
let quizAnswerLog = [];
let quizCorrectCnt = 0;
let quizWrongCnt = 0;
let currentQuestion = null;
let quizStartAt = 0;
let quizTimerFrame = null;
let quizTimerDeadline = 0;
let timeoutAdvanceHandle = null;
// State for the existing quiz briefing/countdown modal.
let quizCountdownActive = false;
let quizCountdownToken = 0;
let quizStartUpdateHistory = true;
let relationVisible = false;
let scoreAnimationDone = false;
let rankEligible = false;
let currentResult = null;
let returnAfterRanking = 'home';
let selectedRankingCategory = '100';
let lastSubmittedRankId = null;
let lastVocabHash = '';
let pendingVocabData = null;
let vocabPollTimer = null;
let isDragging = false;
let startX = 0, startY = 0, currentX = 0, currentY = 0, lastDragDistance = 0;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

window.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.modeCard').forEach(btn => btn.addEventListener('click', () => startSession(btn.dataset.mode)));
  document.querySelectorAll('.quizCountBtn').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.quizCountBtn').forEach(b => b.classList.toggle('selected', b === btn));
    quizCount = btn.dataset.count || 'all';
  }));

  $('exitBtn').addEventListener('click', exitToHome);
  $('openQuizBtn').addEventListener('click', () => openSessionView('quiz'));
  $('startQuizBtn').addEventListener('click', startQuizCountdown);
  $('cancelQuizStartBtn').addEventListener('click', closeQuizStartModal);
  $('closeQuizStartBtn').addEventListener('click', closeQuizStartModal);
  $('openFlashBtn').addEventListener('click', () => openSessionView('flash'));
  $('card').addEventListener('click', () => { if (Math.abs(lastDragDistance) > 10) { lastDragDistance = 0; return; } toggleFlip(); });
  $('card').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFlip(); } });
  $('card').addEventListener('pointerdown', handleDragStart);
  window.addEventListener('pointermove', handleDragMove);
  window.addEventListener('pointerup', handleDragEnd);
  window.addEventListener('pointercancel', handleDragEnd);
  $('relationToggle').addEventListener('click', toggleRelations);
  $('knowBtn').addEventListener('click', markKnown);
  $('dontKnowBtn').addEventListener('click', markUnknown);
  $('skipBtn').addEventListener('click', nextCard);
  $('submitAnswer').addEventListener('click', () => submitAnswer(false));
  $('nextQuiz').addEventListener('click', nextQuiz);
  $('quizInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); if (quizAnswered) nextQuiz(); else submitAnswer(false); } });
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('quizStartModal').classList.contains('hidden') && !quizCountdownActive) closeQuizStartModal();
  });

  $('retryUnknownBtn').addEventListener('click', retryUnknownFlashcards);
  $('retryAllFlashBtn').addEventListener('click', startFlashcards);
  $('fromFlashToQuizBtn').addEventListener('click', () => openSessionView('quiz'));
  $('reviewWrongBtn').addEventListener('click', reviewWrongFlashcards);
  $('retryAllQuizBtn').addEventListener('click', () => requestQuizStart({ updateHistory: false }));
  $('quizToHomeBtn').addEventListener('click', exitToHome);

  $('openRankingsHome').addEventListener('click', () => openRankings('home'));
  $('openRankingsResultBtn').addEventListener('click', () => openRankings('result'));
  $('closeRankingsBtn').addEventListener('click', closeRankings);
  document.querySelectorAll('.rankingTab').forEach(btn => btn.addEventListener('click', () => {
    selectedRankingCategory = btn.dataset.rankCategory;
    document.querySelectorAll('.rankingTab').forEach(b => b.classList.toggle('selected', b === btn));
    loadRankings();
  }));
  $('closeRankingDetailBtn').addEventListener('click', () => $('rankingDetail').classList.add('hidden'));

  $('registerRankBtn').addEventListener('click', openRankModal);
  $('closeRankModalBtn').addEventListener('click', closeRankModal);
  $('cancelRankBtn').addEventListener('click', closeRankModal);
  $('rankNameForm').addEventListener('submit', submitRankRegistration);
  $('rankNameModal').addEventListener('click', e => { if (e.target === $('rankNameModal')) closeRankModal(); });
  window.addEventListener('popstate', onPopState);

  relationVisible = localStorage.getItem(RELATION_KEY) === 'true';
  updateRelationToggle();
  loadVocabulary();
});

async function loadVocabulary() {
  setDataStatus('vocab.json 자료를 불러오는 중입니다.');
  try {
    const response = await fetch('/api/vocab', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    applyVocabularyData(data, false);
    const params = new URLSearchParams(location.search);
    const initialMode = params.get('mode');
    const initialStart = params.get('start');
    if (['ko2en','en2ko','random'].includes(initialMode)) mode = initialMode;
    if (initialStart === 'flash') startFlashcards();
    else if (initialStart === 'quiz') requestQuizStart({ updateHistory: false });
    startVocabularyPolling();
  } catch (error) {
    setDataStatus(`자료를 불러오지 못했습니다: ${error.message}. Node.js 서버를 실행하고 vocab.json을 같은 폴더에 두세요.`, true);
  }
}


function applyVocabularyData(data, announce = true) {
  words = normalizeVocabulary(data);
  lastVocabHash = JSON.stringify(data);
  loadProgress();
  updateStats();
  setDataStatus(words.length ? `vocab.json 불러오기 완료 · ${words.length.toLocaleString()}개 단어` : 'vocab.json에 학습할 단어가 없습니다. 1~13강 배열에 단어 항목을 추가하세요.', !words.length);
  if (announce) toast(`vocab.json 변경사항을 반영했습니다. 단어 ${words.length.toLocaleString()}개`);
}
function startVocabularyPolling() {
  if (vocabPollTimer) clearInterval(vocabPollTimer);
  vocabPollTimer = setInterval(async () => {
    try {
      const response = await fetch(`/api/vocab?ts=${Date.now()}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const hash = JSON.stringify(data);
      if (hash === lastVocabHash) return;
      lastVocabHash = hash;
      const homeVisible = !$('homeScreen').classList.contains('hidden') && $('rankingArea').classList.contains('hidden');
      if (homeVisible) applyVocabularyData(data, true);
      else { pendingVocabData = data; toast('vocab.json이 변경되었습니다. 현재 학습은 그대로 유지하며, 홈으로 돌아간 뒤 최신 자료를 적용합니다.'); }
    } catch (_) { /* temporary read failures do not interrupt a session */ }
  }, 5000);
}
function applyPendingVocabulary() {
  if (!pendingVocabData) return;
  const data = pendingVocabData; pendingVocabData = null;
  applyVocabularyData(data, true);
}

function normalizeVocabulary(data) {
  const list = [];
  for (let section = 1; section <= 13; section++) {
    const sectionWords = data && Array.isArray(data[String(section)]) ? data[String(section)] : [];
    sectionWords.forEach((raw, itemIndex) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const word = typeof raw.word === 'string' ? raw.word.trim() : '';
      const meanings = Array.isArray(raw.meanings) ? raw.meanings.filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean) : [];
      if (!word && !meanings.length) return;
      list.push({
        id: `${section}:${itemIndex}`,
        section: String(section), itemIndex,
        word: word || '___', meanings,
        form: typeof raw.form === 'string' ? raw.form.trim() : '',
        other: normalizeStringArray(raw.other),
        synonyms: normalizeStringArray(raw.synonyms),
        antonyms: normalizeStringArray(raw.antonyms)
      });
    });
  }
  return list;
}
function normalizeStringArray(value) { return Array.isArray(value) ? value.filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean) : []; }
function setDataStatus(message, isError = false) { const el = $('dataStatus'); if (el) { el.textContent = message; el.classList.toggle('error', isError); } }

function hideAllViews() {
  stopQuizTimer();
  ['homeScreen','sessionArea','rankingArea'].forEach(id => $(id).classList.add('hidden'));
  ['flashArea','quizArea','flashResultArea','quizResultArea'].forEach(id => $(id).classList.add('hidden'));
  $('rankingDetail').classList.add('hidden');
  document.querySelector('.cardWrap').classList.remove('hidden');
  document.querySelector('.flashTopStats').classList.remove('hidden');
}
function startSession(selectedMode) {
  if (!words.length) { alert('vocab.json에서 단어 자료를 불러오지 못했습니다.'); return; }
  mode = selectedMode;
  history.pushState({ mode, start: 'flash' }, '', `${location.pathname}?mode=${encodeURIComponent(mode)}&start=flash`);
  startFlashcards();
}
function startFlashcards() {
  if (!words.length) { alert('단어 목록이 없습니다.'); return; }
  stopQuizTimer();
  sessionType = 'flash';
  currentList = shuffle(words.slice());
  currentIndex = 0;
  known.clear(); unknown.clear();
  hideAllViews();
  $('sessionArea').classList.remove('hidden');
  $('flashArea').classList.remove('hidden');
  $('sessionLabel').textContent = `${modeLabel(mode)} · 플래시카드`;
  showCard();
}
function exitToHome() {
  stopQuizTimer();
  applyPendingVocabulary();
  history.pushState({}, '', location.pathname);
  hideAllViews();
  $('homeScreen').classList.remove('hidden');
  sessionType = '';
  currentIndex = 0; quizIndex = 0;
}
function openSessionView(view) {
  if (view === 'quiz') {
    requestQuizStart({ updateHistory: true });
    return;
  }
  history.pushState({ mode, start: view }, '', `${location.pathname}?mode=${encodeURIComponent(mode)}&start=${view}`);
  startFlashcards();
}
function getQuizStartPlan() {
  const baseList = currentList.length ? currentList.slice() : words.slice();
  const shuffledCount = quizCount === 'all' ? baseList.length : Math.max(1, Number(quizCount) || baseList.length);
  const questionCount = Math.min(shuffledCount, baseList.length);
  const sourceIsFullVocabulary = baseList.length === words.length && new Set(baseList.map(item => item.id)).size === words.length;
  const countIsEligible = quizCount === 'all' || words.length >= Number(quizCount);
  const rankAllowed = mode === 'random' && ['25','50','100','200','all'].includes(quizCount) && sourceIsFullVocabulary && countIsEligible && questionCount === (quizCount === 'all' ? words.length : Number(quizCount));
  return { baseList, questionCount, rankAllowed };
}
function requestQuizStart({ updateHistory = true } = {}) {
  if (!words.length) { alert('단어 목록이 없습니다.'); return; }
  if (quizCountdownActive) return;
  quizStartUpdateHistory = updateHistory;
  const plan = getQuizStartPlan();
  $('quizStartCount').textContent = `${plan.questionCount.toLocaleString()}문항${quizCount === 'all' ? ' · 전부' : ` · 선택 ${quizCount}개`}`;
  $('quizStartType').textContent = modeLabel(mode);
  $('quizStartLimit').textContent = `문제당 ${TIME_LIMIT_SECONDS}초 · 시간 초과는 오답`;
  $('quizStartRankNotice').classList.toggle('eligible', plan.rankAllowed);
  $('quizStartRankNotice').classList.toggle('ineligible', !plan.rankAllowed);
  $('quizStartRankStatus').textContent = plan.rankAllowed ? '랭킹 기록에 포함됩니다' : '랭킹 기록에 포함되지 않습니다';
  $('quizStartRankNote').textContent = plan.rankAllowed
    ? `${categoryLabel(quizCount)} · 랜덤 유형과 전체 단어 자료 조건을 충족했습니다. 완료 후 결과 화면에서 이름을 입력해 등록할 수 있습니다.`
    : '랭킹은 랜덤 유형에서 25개·50개·100개·200개·전부를 전체 단어 자료로 완료한 경우에만 등록할 수 있습니다.';
  $('quizStartContent').classList.remove('hidden');
  $('quizCountdown').classList.add('hidden');
  $('quizStartActions').classList.remove('hidden');
  $('startQuizBtn').disabled = false;
  $('cancelQuizStartBtn').disabled = false;
  $('quizStartModal').classList.remove('hidden');
  setTimeout(() => $('startQuizBtn').focus({ preventScroll: true }), 0);
}
function closeQuizStartModal() {
  if (quizCountdownActive) return;
  quizCountdownToken++;
  $('quizStartModal').classList.add('hidden');
  $('quizStartContent').classList.remove('hidden');
  $('quizCountdown').classList.add('hidden');
  $('quizStartActions').classList.remove('hidden');
}
async function startQuizCountdown() {
  if (quizCountdownActive) return;
  quizCountdownActive = true;
  const token = ++quizCountdownToken;
  $('startQuizBtn').disabled = true;
  $('cancelQuizStartBtn').disabled = true;
  $('closeQuizStartBtn').disabled = true;
  $('quizStartContent').classList.add('hidden');
  $('quizStartActions').classList.add('hidden');
  const countEl = $('quizCountdown');
  countEl.classList.remove('hidden');
  for (const number of [3, 2, 1]) {
    if (token !== quizCountdownToken) return;
    countEl.textContent = String(number);
    countEl.classList.remove('countPulse');
    void countEl.offsetWidth;
    countEl.classList.add('countPulse');
    await sleep(700);
  }
  if (token !== quizCountdownToken) return;
  $('quizStartModal').classList.add('hidden');
  quizCountdownActive = false;
  $('closeQuizStartBtn').disabled = false;
  if (quizStartUpdateHistory) history.pushState({ mode, start: 'quiz' }, '', `${location.pathname}?mode=${encodeURIComponent(mode)}&start=quiz`);
  beginQuizSession();
}
function showFlashArea() { $('flashArea').classList.remove('hidden'); $('quizArea').classList.add('hidden'); $('flashResultArea').classList.add('hidden'); $('quizResultArea').classList.add('hidden'); }
function toggleRelations() {
  relationVisible = !relationVisible;
  localStorage.setItem(RELATION_KEY, String(relationVisible));
  updateRelationToggle();
  if (sessionType === 'flash' && currentList[currentIndex]) renderFlashBack(currentList[currentIndex]);
}
function updateRelationToggle() {
  const btn = $('relationToggle');
  if (!btn) return;
  btn.classList.toggle('active', relationVisible);
  btn.setAttribute('aria-pressed', String(relationVisible));
  btn.textContent = relationVisible ? '유의어·반의어 표시 중' : '유의어·반의어';
}

function showCard() {
  const item = currentList[currentIndex];
  if (!item) { endFlashcards(); return; }
  const card = $('card');
  const inner = card.querySelector('.cardInner');
  const dir = mode === 'random' ? (Math.random() < 0.5 ? 'en2ko' : 'ko2en') : mode;
  card.dataset.dir = dir;
  card.classList.remove('show-back','flipped');
  inner.style.transition = 'none'; inner.style.transform = 'rotateY(0deg)';
  setTimeout(() => { inner.style.transition = 'transform .8s cubic-bezier(.2,.9,.3,1)'; }, 30);
  $('cardFront').innerHTML = renderFlashFront(item, dir);
  renderFlashBack(item);
  updateFlashStats();
  resetCardPosition();
}
function renderFlashFront(item, dir) {
  if (dir === 'en2ko') return `<div class="textInner reveal"><span class="badge">문제 · 영어</span><span class="mainText">${escapeHtml(item.word)}</span><span class="sub">카드를 뒤집어 뜻 확인</span></div>`;
  const meanings = item.meanings.length ? item.meanings : ['___'];
  return `<div class="textInner reveal flashFrontMeanings"><span class="badge">문제 · 한국어</span><span class="mainText">${escapeHtml(meanings[0])}</span>${meanings.slice(1).map(m => `<span class="secondaryMeaning">${escapeHtml(m)}</span>`).join('')}<span class="sub">카드를 뒤집어 영어 확인</span></div>`;
}
function renderFlashBack(item) {
  const meanings = item.meanings.length ? item.meanings : ['___'];
  const relations = relationVisible ? `<div class="detailSection relationsGrid">
    <div><span class="detailLabel">유의어</span><div class="detailValues">${renderPills(item.synonyms)}</div></div>
    <div><span class="detailLabel">반의어</span><div class="detailValues">${renderPills(item.antonyms)}</div></div>
  </div>` : '';
  const form = item.form ? `<span class="metaPill">${escapeHtml(item.form)}</span>` : '';
  $('cardBack').innerHTML = `<div class="textInner flashDetails reveal">
    <div class="detailTop"><span class="badge">정답</span><span class="metaPill">${escapeHtml(item.section)}강</span>${form}</div>
    <div class="detailWord">${escapeHtml(item.word)}</div>
    <section class="detailSection"><span class="detailLabel">대표 뜻</span><div class="meaningPrimary">${escapeHtml(meanings[0])}</div></section>
    ${meanings.length > 1 ? `<section class="detailSection"><span class="detailLabel">나머지 뜻</span><ol class="meaningList">${meanings.slice(1).map(m => `<li>${escapeHtml(m)}</li>`).join('')}</ol></section>` : ''}
    ${relations}
    ${item.other.length ? `<section class="detailSection"><span class="detailLabel">기타</span><ul class="otherList">${item.other.map(v => `<li>${escapeHtml(v)}</li>`).join('')}</ul></section>` : ''}
  </div>`;
}
function renderPills(items) { return items.length ? items.map(v => `<span class="wordPill">${escapeHtml(v)}</span>`).join('') : '<span class="emptyValue">없음</span>'; }
function updateFlashStats() { $('flKnw').textContent = String(known.size); $('flUnk').textContent = String(unknown.size); }
function endFlashcards() {
  $('flashArea').classList.add('hidden'); $('flashResultArea').classList.remove('hidden');
  const total = known.size + unknown.size;
  $('flashResultArea').querySelector('.flashResultStats').innerHTML = `<p>학습 완료 <strong>${total.toLocaleString()}</strong>개</p><p><span class="greenText">${known.size.toLocaleString()}</span>개 외움 · <span class="redText">${unknown.size.toLocaleString()}</span>개 미암기</p>`;
}
function toggleFlip() {
  const card = $('card'); const inner = card.querySelector('.cardInner');
  if (card.classList.contains('flipping')) return;
  card.classList.add('flipping'); inner.classList.remove('flipPulse'); void inner.offsetWidth; inner.classList.add('flipPulse');
  setTimeout(() => card.classList.toggle('show-back'), 140);
  setTimeout(() => { inner.classList.remove('flipPulse'); card.classList.remove('flipping'); }, 310);
}
function handleDragStart(e) {
  if (e.target.closest('button')) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  isDragging = true; startX = e.clientX; startY = e.clientY; currentX = 0; currentY = 0; lastDragDistance = 0;
  document.body.classList.add('dragLock'); document.documentElement.classList.add('dragLock');
  const card = $('card'); card.style.transition = 'none'; card.setPointerCapture?.(e.pointerId);
}
function handleDragMove(e) {
  if (!isDragging) return;
  const card = $('card'); currentX = e.clientX - startX; currentY = e.clientY - startY;
  const showDown = currentY > 80 && Math.abs(currentX) < 80;
  const wrap = document.querySelector('.cardWrap');
  wrap.classList.toggle('show-left', currentX < -80 && !showDown);
  wrap.classList.toggle('show-right', currentX > 80 && !showDown);
  wrap.classList.toggle('show-down', showDown);
  const strengthX = Math.min(1, Math.abs(currentX) / 180); const strengthY = Math.min(1, Math.max(0, currentY) / 180);
  const left = wrap.querySelector('.dragLabel.left'); const right = wrap.querySelector('.dragLabel.right'); const down = wrap.querySelector('.dragLabel.down'); const divider = wrap.querySelector('.dragDivider');
  left.style.opacity = currentX < 0 && !showDown ? String(0.15 + strengthX * 0.75) : '0';
  right.style.opacity = currentX > 0 && !showDown ? String(0.15 + strengthX * 0.75) : '0';
  down.style.opacity = showDown ? String(0.2 + strengthY * 0.75) : '0'; divider.style.opacity = String(Math.min(1, strengthX * 1.2));
  card.style.transform = `translateX(${currentX}px) translateY(${Math.max(0,currentY)}px) rotate(${currentX * 0.05}deg)`;
  card.classList.toggle('is-skip', showDown);
  if (currentX < -100) card.style.boxShadow = '0 0 40px rgba(16,185,129,.45)'; else if (currentX > 100) card.style.boxShadow = '0 0 40px rgba(239,68,68,.4)'; else card.style.boxShadow = '';
  e.preventDefault();
}
function handleDragEnd() {
  if (!isDragging) return;
  isDragging = false; document.body.classList.remove('dragLock'); document.documentElement.classList.remove('dragLock');
  const card = $('card'); lastDragDistance = Math.max(Math.abs(currentX), Math.abs(currentY)); card.style.transition = 'transform .35s cubic-bezier(.2,.9,.3,1), opacity .35s'; card.style.boxShadow = ''; card.classList.remove('is-skip');
  document.querySelector('.cardWrap').classList.remove('show-left','show-right','show-down');
  if (currentY > 120 && Math.abs(currentX) < 120) { card.style.transform = `translateY(${window.innerHeight}px)`; card.style.opacity = '0'; setTimeout(() => { nextCard(); resetCardPosition(); }, 200); }
  else if (currentX < -120) { card.style.transform = `translateX(-${window.innerWidth}px) rotate(-30deg)`; card.style.opacity = '0'; setTimeout(() => { markKnown(); resetCardPosition(); }, 200); }
  else if (currentX > 120) { card.style.transform = `translateX(${window.innerWidth}px) rotate(30deg)`; card.style.opacity = '0'; setTimeout(() => { markUnknown(); resetCardPosition(); }, 200); }
  else resetCardPosition();
}
function resetCardPosition() {
  const card = $('card'); if (!card) return;
  card.style.transform = 'translateZ(0) translateX(0) rotate(0)'; card.style.opacity = '1'; card.classList.remove('is-skip');
  const wrap = document.querySelector('.cardWrap'); if (wrap) wrap.classList.remove('show-left','show-right','show-down');
  wrap?.querySelectorAll('.dragLabel').forEach(el => el.style.opacity = '0'); const divider = wrap?.querySelector('.dragDivider'); if (divider) divider.style.opacity = '0';
  currentX = 0; currentY = 0;
}
function markKnown() { const item = currentList[currentIndex]; if (!item) return; known.add(item.id); unknown.delete(item.id); saveProgress(); nextCard(); }
function markUnknown() { const item = currentList[currentIndex]; if (!item) return; unknown.add(item.id); known.delete(item.id); saveProgress(); nextCard(); }
function nextCard() { currentIndex++; if (currentIndex >= currentList.length) endFlashcards(); else showCard(); updateStats(); }
function retryUnknownFlashcards() {
  const list = words.filter(item => unknown.has(item.id));
  if (!list.length) { alert('미암기 단어가 없습니다.'); return; }
  currentList = shuffle(list.slice()); currentIndex = 0; known.clear(); unknown.clear(); sessionType = 'flash';
  $('flashResultArea').classList.add('hidden'); $('flashArea').classList.remove('hidden'); document.querySelector('.cardWrap').classList.remove('hidden'); document.querySelector('.flashTopStats').classList.remove('hidden'); showCard();
}
function reviewWrongFlashcards() {
  const listById = new Map(words.map(w => [w.id,w]));
  const missed = quizAnswerLog.filter(row => !row.correct).map(row => listById.get(`${row.section}:${row.itemIndex}`)).filter(Boolean);
  if (!missed.length) return;
  stopQuizTimer(); currentList = shuffle(missed); currentIndex = 0; known.clear(); unknown.clear(); sessionType = 'flash';
  history.pushState({ mode, start: 'flash' }, '', `${location.pathname}?mode=${encodeURIComponent(mode)}&start=flash`);
  $('quizResultArea').classList.add('hidden'); $('sessionArea').classList.remove('hidden'); $('sessionLabel').textContent = `${modeLabel(mode)} · 오답 복습`; showFlashArea(); document.querySelector('.cardWrap').classList.remove('hidden'); document.querySelector('.flashTopStats').classList.remove('hidden'); showCard();
}
function saveProgress() { try { localStorage.setItem(PROGRESS_KEY, JSON.stringify({ known: [...known], unknown: [...unknown] })); } catch (_) {} }
function loadProgress() { try { const data = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}'); known = new Set(Array.isArray(data.known) ? data.known : []); unknown = new Set(Array.isArray(data.unknown) ? data.unknown : []); } catch (_) {} }
function updateStats() { /* compact status is displayed in the home data line */ }

function beginQuizSession() {
  if (!words.length) { alert('단어 목록이 없습니다.'); return; }
  stopQuizTimer(); sessionType = 'quiz';
  const plan = getQuizStartPlan();
  const baseList = plan.baseList;
  const shuffled = shuffle(baseList);
  const limit = quizCount === 'all' ? shuffled.length : Math.max(1, Number(quizCount) || shuffled.length);
  quizList = shuffled.slice(0, Math.min(limit, shuffled.length));
  quizIndex = 0; quizAnswered = false; quizAnswerLog = []; quizCorrectCnt = 0; quizWrongCnt = 0; currentQuestion = null; currentResult = null; scoreAnimationDone = false; lastSubmittedRankId = null;
  rankEligible = plan.rankAllowed && quizList.length === (quizCount === 'all' ? words.length : Number(quizCount));
  hideAllViews(); $('sessionArea').classList.remove('hidden'); $('quizArea').classList.remove('hidden'); $('sessionLabel').textContent = `${modeLabel(mode)} · 퀴즈`;
  $('liveLogArea').classList.add('hidden'); $('liveLogBody').replaceChildren(); updateQuizStats(); showQuiz();
}
function showQuiz() {
  stopQuizTimer();
  const item = quizList[quizIndex];
  if (!item) { endQuizSession(); return; }

  const dir = mode === 'random'
    ? (Math.random() < 0.5 ? 'en2ko' : 'ko2en')
    : mode;
  const meanings = item.meanings.length ? item.meanings : ['___'];
  const prompt = dir === 'en2ko' ? item.word : meanings.join(' / ');
  const targets = dir === 'en2ko' ? splitMeaningAlternatives(meanings) : [item.word];
  currentQuestion = {
    item,
    direction: dir,
    prompt,
    targets,
    targetDisplay: dir === 'en2ko' ? meanings.join(' / ') : item.word
  };

  $('quizPrompt').textContent = prompt;
  $('quizProgress').textContent = `${quizIndex + 1} / ${quizList.length}`;
  $('quizInput').value = '';
  $('quizInput').disabled = false;
  $('quizInput').readOnly = false;
  $('submitAnswer').disabled = false;
  $('nextQuiz').disabled = true;
  $('quizFeedback').textContent = '';
  $('quizFeedback').className = '';
  $('timerBadge').classList.remove('timerDanger');
  $('timerValue').textContent = TIME_LIMIT_SECONDS.toFixed(1);
  $('timerBar').style.transform = 'scaleX(1)';
  $('timerBar').classList.remove('timerDangerBar');

  quizAnswered = false;
  startQuizTimer();
  $('quizInput').focus({ preventScroll: true });
}

function startQuizTimer() {
  stopQuizTimer();
  quizStartAt = performance.now();
  quizTimerDeadline = quizStartAt + TIME_LIMIT_SECONDS * 1000;

  const valueEl = $('timerValue');
  const barEl = $('timerBar');
  const badgeEl = $('timerBadge');

  const tick = (now) => {
    if (quizAnswered || !currentQuestion) {
      quizTimerFrame = null;
      return;
    }

    const remainingMs = Math.max(0, quizTimerDeadline - now);
    const remainingSeconds = remainingMs / 1000;
    const fraction = Math.max(0, Math.min(1, remainingMs / (TIME_LIMIT_SECONDS * 1000)));

    if (valueEl) valueEl.textContent = remainingSeconds.toFixed(1);
    // Transform-based scaling is smoother and avoids repeated width layout/reflow.
    if (barEl) barEl.style.transform = `scaleX(${fraction})`;

    const danger = remainingSeconds <= 3;
    if (badgeEl) badgeEl.classList.toggle('timerDanger', danger);
    if (barEl) barEl.classList.toggle('timerDangerBar', danger);

    if (remainingMs <= 0) {
      if (valueEl) valueEl.textContent = '0.0';
      if (barEl) barEl.style.transform = 'scaleX(0)';
      quizTimerFrame = null;
      submitAnswer(true);
      return;
    }

    quizTimerFrame = requestAnimationFrame(tick);
  };

  quizTimerFrame = requestAnimationFrame(tick);
}

function stopQuizTimer() {
  if (quizTimerFrame !== null) {
    cancelAnimationFrame(quizTimerFrame);
    quizTimerFrame = null;
  }
  if (timeoutAdvanceHandle !== null) {
    clearTimeout(timeoutAdvanceHandle);
    timeoutAdvanceHandle = null;
  }
}

function submitAnswer(timedOut = false) {
  if (quizAnswered || !currentQuestion) return;
  const elapsed = timedOut ? TIME_LIMIT_SECONDS : Math.max(0, (performance.now() - quizStartAt) / 1000);
  stopQuizTimer(); quizAnswered = true;
  const typed = $('quizInput').value.trim();
  const answer = timedOut && !typed ? '시간 초과' : (typed || '(미입력)');
  const elapsedSeconds = round1(Math.min(TIME_LIMIT_SECONDS, elapsed));
  const correct = !timedOut && elapsedSeconds < TIME_LIMIT_SECONDS && currentQuestion.targets.some(target => normalizeAnswer(typed) === normalizeAnswer(target));
  const remainingSeconds = correct ? round1(Math.max(0, TIME_LIMIT_SECONDS - elapsedSeconds)) : 0;
  const row = {
    number: quizIndex + 1,
    section: currentQuestion.item.section,
    itemIndex: currentQuestion.item.itemIndex,
    word: currentQuestion.item.word,
    prompt: currentQuestion.prompt,
    direction: currentQuestion.direction,
    answer,
    target: currentQuestion.targetDisplay,
    correct,
    timedOut,
    elapsedSeconds,
    remainingSeconds
  };
  quizAnswerLog.push(row);
  if (correct) {
    quizCorrectCnt++;
    adjustKnownStatus(currentQuestion.item.id, true);
    $('quizFeedback').textContent = `정답 · +1점${remainingSeconds > 0 ? ` · 시간 추가 ${remainingSeconds.toFixed(1)}점` : ''}`;
    $('quizFeedback').className = 'feedbackCorrect';
  } else {
    quizWrongCnt++;
    adjustKnownStatus(currentQuestion.item.id, false);
    $('quizFeedback').textContent = timedOut ? `시간 초과 · 정답: ${currentQuestion.targetDisplay}` : `오답 · 정답: ${currentQuestion.targetDisplay}`;
    $('quizFeedback').className = 'feedbackWrong';
  }
  $('quizInput').readOnly = true; $('quizInput').disabled = false; $('submitAnswer').disabled = true; $('nextQuiz').disabled = false;
  if (!timedOut) $('quizInput').focus({ preventScroll: true });
  updateQuizStats();
  if (!correct || quizWrongCnt > 0) $('liveLogArea').classList.remove('hidden');
  renderLogTable($('liveLogBody'), quizAnswerLog, false);
  saveProgress();
  if (timedOut) timeoutAdvanceHandle = setTimeout(nextQuiz, 650);
}
function adjustKnownStatus(id, correct) { if (correct) { known.add(id); unknown.delete(id); } else { unknown.add(id); known.delete(id); } }
function nextQuiz() { if (!quizAnswered) return; if (quizIndex + 1 >= quizList.length) { endQuizSession(); return; } quizIndex++; quizAnswered = false; showQuiz(); }
function updateQuizStats() { $('qCorrect').textContent = String(quizCorrectCnt); $('qWrong').textContent = String(quizWrongCnt); }
function endQuizSession() {
  stopQuizTimer(); $('quizArea').classList.add('hidden'); $('quizResultArea').classList.remove('hidden');
  const correctCount = quizAnswerLog.filter(r => r.correct).length;
  const timeBonus = round1(quizAnswerLog.reduce((sum, r) => sum + (r.correct ? r.remainingSeconds : 0), 0));
  const totalElapsed = round1(quizAnswerLog.reduce((sum, r) => sum + r.elapsedSeconds, 0));
  currentResult = { correctCount, timeBonus, totalElapsed, score: round1(correctCount + timeBonus), total: quizAnswerLog.length };
  $('quizResultEmoji').textContent = correctCount === quizAnswerLog.length ? '완벽' : correctCount / Math.max(1,quizAnswerLog.length) >= .7 ? '양호' : '복습';
  $('quizResultSub').textContent = `${quizAnswerLog.length}문항 · 총 풀이 시간 ${formatDuration(totalElapsed)}`;
  $('resultLogSummary').textContent = `정답 ${correctCount} · 오답 ${quizAnswerLog.length - correctCount}`;
  renderLogTable($('resultLogBody'), quizAnswerLog, true);
  $('reviewWrongBtn').classList.toggle('hidden', !quizAnswerLog.some(r => !r.correct));
  $('registerRankBtn').classList.toggle('hidden', !rankEligible);
  $('registerRankBtn').disabled = true;
  $('registerRankBtn').textContent = '랭킹 등록';
  $('quizResultBox').dataset.tier = correctCount === quizAnswerLog.length ? 'perfect' : correctCount / Math.max(1,quizAnswerLog.length) >= .7 ? 'strong' : 'low';
  animateScoreBreakdown(currentResult, quizAnswerLog);
}
function round1(n) { return Math.round((Number(n) + Number.EPSILON) * 10) / 10; }
function splitMeaningAlternatives(values) {
  // A meaning can contain multiple accepted answers separated by / or comma.
  // Splitting before comparison makes `look after / take care of` accept either phrase.
  return (Array.isArray(values) ? values : [values])
    .flatMap(value => String(value ?? '').split(/[\/,，]/g))
    .map(value => value.trim())
    .filter(Boolean);
}

function normalizeAnswer(value) {
  let s = String(value ?? '').normalize('NFKC').toLocaleLowerCase('ko-KR');
  // Parenthetical material is optional: ignore the content and brackets.
  for (let i = 0; i < 5; i++) {
    const next = s.replace(/\([^()]*\)|（[^（）]*）/g, '');
    if (next === s) break;
    s = next;
  }
  // Treat tilde and common dash characters equivalently.
  s = s.replace(/[~〜～∼‐‑‒–—―−﹘﹣－]/g, '-');
  // Ignore whitespace differences, but do not use similarity/partial matching.
  return s.replace(/[\s\u200B-\u200D\uFEFF]+/g, '').trim();
}

function modeLabel(value) { if (value === 'ko2en') return '한국어 → 영어'; if (value === 'en2ko') return '영어 → 한국어'; return '랜덤'; }
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]); }
function shuffle(array) { const out = array.slice(); for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i],out[j]] = [out[j],out[i]]; } return out; }

function renderLogTable(tbody, rows, animate = false) {
  tbody.replaceChildren();
  rows.forEach((row, index) => {
    const tr = document.createElement('tr'); tr.className = row.correct ? 'logCorrect' : 'logWrong'; tr.dataset.idx = String(index);
    const values = [row.number || index + 1, row.prompt, row.word, row.answer, row.target, row.correct ? '맞음' : (row.timedOut ? '시간 초과' : '틀림'), `${Number(row.elapsedSeconds).toFixed(1)}초`];
    values.forEach((value, cellIndex) => { const td = document.createElement('td'); td.textContent = String(value ?? ''); if (cellIndex === 5) td.className = row.correct ? 'resultBadgeCell correctBadge' : 'resultBadgeCell wrongBadge'; tr.appendChild(td); });
    if (animate) tr.style.setProperty('--row-delay', `${Math.min(index * 12, 1200)}ms`);
    tbody.appendChild(tr);
  });
}
async function animateScoreBreakdown(result, rows) {
  scoreAnimationDone = false;
  const stage = $('scoreStage'); stage.classList.remove('merging','merged');
  $('baseCounter').classList.remove('counterActive'); $('timeCounter').classList.remove('counterActive');
  $('baseScoreCount').textContent = '0'; $('timeScoreCount').textContent = '0.0'; $('finalScoreCount').textContent = '0.0';
  $('finalScoreDetails').textContent = ''; $('finalScorePanel').classList.remove('visible'); $('mergeLine').classList.remove('visible'); $('scoreOperator').classList.remove('visible');
  $('scoreAnimationStatus').textContent = '문제별 결과를 따라 점수를 합산합니다.';
  const scroller = document.querySelector('.resultTableScroll');
  const delay = Math.min(130, Math.max(18, 11000 / Math.max(1, rows.length)));
  let base = 0, time = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]; const tr = $('resultLogBody').querySelector(`tr[data-idx="${i}"]`);
    if (tr) {
      tr.classList.add('rowProcessing');
      if (scroller) scroller.scrollTop = Math.max(0, tr.offsetTop - $('resultLogBody').offsetTop - 80);
    }
    if (row.correct) {
      base += 1; time = round1(time + row.remainingSeconds);
      $('baseScoreCount').textContent = String(base); $('timeScoreCount').textContent = time.toFixed(1);
      floatPoint($('baseFloat'), '+1');
      if (row.remainingSeconds > 0) floatPoint($('timeFloat'), `+${row.remainingSeconds.toFixed(1)}`);
      $('baseCounter').classList.add('counterActive'); $('timeCounter').classList.add('counterActive');
    }
    await sleep(delay);
    if (tr) tr.classList.remove('rowProcessing');
  }
  // The server recomputes this value when a ranking is registered.
  $('baseScoreCount').textContent = String(result.correctCount); $('timeScoreCount').textContent = result.timeBonus.toFixed(1);
  $('scoreOperator').classList.add('visible'); $('mergeLine').classList.add('visible');
  await sleep(400); stage.classList.add('merging'); await sleep(650); stage.classList.add('merged');
  $('finalScoreCount').textContent = result.score.toFixed(1);
  $('finalScoreDetails').textContent = `${result.correctCount}점 정답 점수 + ${result.timeBonus.toFixed(1)}점 시간 점수`;
  $('finalScorePanel').classList.add('visible'); $('scoreAnimationStatus').textContent = `총 ${result.total}문항 · 풀이 시간 ${formatDuration(result.totalElapsed)}`;
  scoreAnimationDone = true; $('registerRankBtn').disabled = !rankEligible;
  $('registerRankBtn').textContent = lastSubmittedRankId ? '이미 등록한 기록' : '랭킹 등록';
}
function floatPoint(el, value) { el.textContent = value; el.classList.remove('show'); void el.offsetWidth; el.classList.add('show'); }
function formatDuration(seconds) { const whole = Math.max(0, Number(seconds) || 0); const mm = Math.floor(whole / 60); const ss = (whole % 60).toFixed(1).padStart(4,'0'); return mm ? `${mm}분 ${ss}초` : `${ss}초`; }

function openRankModal() {
  if (!rankEligible || !currentResult || !scoreAnimationDone) return;
  $('rankSubmitError').textContent = '';
  $('rankNameDescription').textContent = `${quizCount === 'all' ? '랜덤 전부' : `랜덤 ${quizCount}개`} · ${currentResult.score.toFixed(1)}점 기록을 등록합니다.`;
  $('rankNameModal').classList.remove('hidden'); $('rankNameInput').value = ''; setTimeout(() => $('rankNameInput').focus(), 0);
}
function closeRankModal() { $('rankNameModal').classList.add('hidden'); }
async function submitRankRegistration(e) {
  e.preventDefault();
  const name = $('rankNameInput').value.trim();
  if (!name) { $('rankSubmitError').textContent = '이름을 입력하세요.'; return; }
  const btn = $('confirmRankBtn'); btn.disabled = true; btn.textContent = '등록 중…'; $('rankSubmitError').textContent = '';
  try {
    const payload = {
      name, category: quizCount, mode: mode,
      answers: quizAnswerLog.map(row => ({ section: row.section, itemIndex: row.itemIndex, word: row.word, prompt: row.prompt, direction: row.direction, answer: row.answer, elapsedSeconds: row.elapsedSeconds }))
    };
    const response = await fetch('/api/rankings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    lastSubmittedRankId = data.id;
    closeRankModal();
    $('registerRankBtn').textContent = `등록 완료 · ${data.rank}위`;
    $('registerRankBtn').disabled = true;
    toast(`${name} · ${data.rank}위로 등록되었습니다.`);
    if (data.rank <= 10 && typeof window.confetti === 'function') playLeaderboardConfetti();
  } catch (error) {
    $('rankSubmitError').textContent = `등록 실패: ${error.message}`;
  } finally {
    btn.disabled = false; btn.textContent = '등록하기';
  }
}
function playLeaderboardConfetti() {
  if (typeof window.confetti !== 'function') return;
  const end = Date.now() + 1800;
  (function frame() {
    window.confetti({ particleCount: 7, angle: 60, spread: 70, origin: { x: 0, y: 0.65 }, zIndex: 3000 });
    window.confetti({ particleCount: 7, angle: 120, spread: 70, origin: { x: 1, y: 0.65 }, zIndex: 3000 });
    if (Date.now() < end) requestAnimationFrame(frame);
  })();
}

function openRankings(returnView) {
  returnAfterRanking = returnView;
  hideAllViews(); $('rankingArea').classList.remove('hidden'); $('rankingDetail').classList.add('hidden');
  selectedRankingCategory = selectedRankingCategory || '100';
  document.querySelectorAll('.rankingTab').forEach(btn => btn.classList.toggle('selected', btn.dataset.rankCategory === selectedRankingCategory));
  loadRankings();
}
function closeRankings() {
  $('rankingArea').classList.add('hidden');
  if (returnAfterRanking === 'result' && currentResult) { $('sessionArea').classList.remove('hidden'); $('quizResultArea').classList.remove('hidden'); }
  else { $('homeScreen').classList.remove('hidden'); applyPendingVocabulary(); }
}
async function loadRankings() {
  $('rankingStatus').textContent = '랭킹을 불러오는 중입니다.';
  $('rankingBody').replaceChildren();
  try {
    const response = await fetch(`/api/rankings?category=${encodeURIComponent(selectedRankingCategory)}&limit=100`, { cache: 'no-store' });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (!data.rankings.length) { $('rankingStatus').textContent = '아직 등록된 기록이 없습니다.'; return; }
    $('rankingStatus').textContent = `${categoryLabel(selectedRankingCategory)} · ${data.total.toLocaleString()}개 기록`;
    data.rankings.forEach(record => {
      const tr = document.createElement('tr');
      addCell(tr, `${record.rank}위`, 'rankPosition'); addCell(tr, record.name); addCell(tr, `${Number(record.score).toFixed(1)}점`, 'rankScore'); addCell(tr, `${record.correctCount} / ${record.questionCount}`); addCell(tr, formatDuration(record.totalTime)); addCell(tr, formatDate(record.createdAt));
      const td = document.createElement('td'); const button = document.createElement('button'); button.type = 'button'; button.className = 'detailBtn'; button.textContent = '상세보기'; button.addEventListener('click', () => loadRankingDetail(record.id)); td.appendChild(button); tr.appendChild(td);
      $('rankingBody').appendChild(tr);
    });
  } catch (error) { $('rankingStatus').textContent = `랭킹을 불러오지 못했습니다: ${error.message}`; }
}
async function loadRankingDetail(id) {
  $('rankingDetail').classList.remove('hidden'); $('rankingDetailTitle').textContent = '기록을 불러오는 중입니다.'; $('rankingDetailMeta').textContent = ''; $('rankingDetailBody').replaceChildren();
  try {
    const response = await fetch(`/api/rankings/${encodeURIComponent(id)}`, { cache: 'no-store' });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    $('rankingDetailTitle').textContent = `${data.name} · ${data.rank}위`;
    $('rankingDetailMeta').textContent = `${categoryLabel(data.category)} · ${Number(data.score).toFixed(1)}점 · 정답 ${data.correctCount}/${data.questionCount} · 총 ${formatDuration(data.totalTime)} · ${formatDate(data.createdAt)}`;
    renderLogTable($('rankingDetailBody'), data.answers, false);
    $('rankingDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { $('rankingDetailTitle').textContent = '기록을 불러오지 못했습니다.'; $('rankingDetailMeta').textContent = error.message; }
}
function addCell(tr, value, className = '') { const td = document.createElement('td'); td.textContent = String(value ?? ''); if (className) td.className = className; tr.appendChild(td); }
function categoryLabel(value) { return value === 'all' ? '랜덤 전부' : `랜덤 ${value}개`; }
function formatDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '-' : new Intl.DateTimeFormat('ko-KR', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }).format(date); }
function toast(message) { const host = $('toastHost'); const node = document.createElement('div'); node.className = 'toast'; const text = document.createElement('div'); text.className = 'toastText'; text.textContent = message; const close = document.createElement('button'); close.className = 'toastClose'; close.textContent = '×'; close.addEventListener('click', () => node.remove()); node.append(text, close); host.appendChild(node); setTimeout(() => node.remove(), 4500); }
function onPopState(e) {
  stopQuizTimer();
  hideAllViews();
  if (!e.state || !e.state.start) { $('homeScreen').classList.remove('hidden'); return; }
  mode = e.state.mode || 'ko2en'; $('sessionArea').classList.remove('hidden'); $('homeScreen').classList.add('hidden'); $('rankingArea').classList.add('hidden');
  if (e.state.start === 'flash') { showFlashArea(); if (!currentList.length) startFlashcards(); else showCard(); }
  else { if (!quizList.length) requestQuizStart({ updateHistory: false }); else { $('quizArea').classList.remove('hidden'); showQuiz(); } }
}
