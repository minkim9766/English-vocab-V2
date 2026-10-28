'use strict';

const $ = (id) => document.getElementById(id);
let csrfToken = '';
let setupRequired = false;
let activeRankings = [];
let selectedRankId = '';
let vocabularyData = null;
let selectedWordIndex = null;
let toastTimer = null;

window.addEventListener('DOMContentLoaded', initializeAdmin);

async function initializeAdmin() {
  $('authForm').addEventListener('submit', submitAuthentication);
  $('logoutBtn').addEventListener('click', logout);
  $('refreshRankingsBtn').addEventListener('click', loadRankings);
  $('adminRankCategory').addEventListener('change', loadRankings);
  $('rankSearch').addEventListener('input', renderRankings);
  $('perfectRankForm').addEventListener('submit', createPerfectRanking);
  $('closeRankEditorBtn').addEventListener('click', closeRankEditor);
  $('rankEditForm').addEventListener('submit', saveRankingEdits);
  $('recalcScoreBtn').addEventListener('click', recalculateVisibleScore);
  $('deleteRankBtn').addEventListener('click', deleteSelectedRanking);
  $('refreshWordsBtn').addEventListener('click', loadVocabulary);
  $('wordSectionSelect').addEventListener('change', () => {
    selectedWordIndex = null;
    clearWordForm();
    renderWordList();
  });
  $('wordSearch').addEventListener('input', renderWordList);
  $('newWordBtn').addEventListener('click', () => { selectedWordIndex = null; clearWordForm(); });
  $('wordEditForm').addEventListener('submit', saveWord);
  $('deleteWordBtn').addEventListener('click', deleteSelectedWord);
  $('changePasswordForm').addEventListener('submit', changePassword);
  document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => activateTab(button.dataset.tab)));

  for (let section = 1; section <= 13; section++) {
    const option = document.createElement('option');
    option.value = String(section); option.textContent = `${section}강`;
    $('wordSectionSelect').appendChild(option);
  }

  try {
    const status = await requestJSON('/api/admin/status');
    setupRequired = Boolean(status.setupRequired);
    const sessionResponse = await fetch('/api/admin/session', { cache: 'no-store', credentials: 'same-origin' });
    const sessionData = await sessionResponse.json().catch(() => ({}));
    if (sessionResponse.ok) {
      csrfToken = sessionData.csrfToken || '';
      showDashboard();
    } else {
      showAuth(setupRequired, setupRequired ? '' : '관리자 비밀번호를 입력하세요.');
    }
  } catch (error) {
    showAuth(false, `서버에 연결할 수 없습니다: ${error.message}`);
  }
}

async function requestJSON(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function api(url, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  const options = { method, headers, cache: 'no-store', credentials: 'same-origin' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  if (!['GET', 'HEAD'].includes(method.toUpperCase())) headers['X-Admin-CSRF'] = csrfToken;
  try {
    return await requestJSON(url, options);
  } catch (error) {
    if (String(error.message).includes('로그인이 필요합니다') || String(error.message).includes('보안 토큰')) {
      csrfToken = '';
      showAuth(false, '관리자 세션이 만료되었습니다. 다시 로그인하세요.');
    }
    throw error;
  }
}

function showAuth(isSetup, message = '') {
  setupRequired = Boolean(isSetup);
  $('dashboard').classList.add('hidden');
  $('authView').classList.remove('hidden');
  $('authTitle').textContent = setupRequired ? '관리자 최초 설정' : '관리자 로그인';
  $('authDescription').textContent = setupRequired
    ? '관리자 비밀번호를 최초 설정합니다. 이 단계는 서버 컴퓨터의 localhost에서만 허용됩니다.'
    : '관리자 비밀번호를 입력하세요. 로그인 실패가 반복되면 일정 시간 요청이 제한됩니다.';
  $('passwordConfirmWrap').classList.toggle('hidden', !setupRequired);
  $('adminPassword').value = '';
  $('adminPassword').autocomplete = setupRequired ? 'new-password' : 'current-password';
  $('adminPasswordConfirm').value = '';
  $('adminPasswordConfirm').required = setupRequired;
  $('authSubmit').textContent = setupRequired ? '관리자 비밀번호 설정' : '로그인';
  setMessage('authMessage', message, Boolean(message && message.includes('성공')));
  if (!message) $('authMessage').textContent = '';
}

async function submitAuthentication(event) {
  event.preventDefault();
  const password = $('adminPassword').value;
  if (password.length < 12) return setMessage('authMessage', '비밀번호는 12자 이상이어야 합니다. 16자 이상의 긴 문구를 권장합니다.');
  if (setupRequired && password !== $('adminPasswordConfirm').value) return setMessage('authMessage', '비밀번호 확인이 일치하지 않습니다.');
  const button = $('authSubmit'); button.disabled = true;
  setMessage('authMessage', setupRequired ? '관리자 계정을 설정하는 중입니다.' : '로그인 확인 중입니다.');
  try {
    const endpoint = setupRequired ? '/api/admin/setup' : '/api/admin/login';
    const data = await requestJSON(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ password })
    });
    csrfToken = data.csrfToken || '';
    showToast(setupRequired ? '관리자 비밀번호가 설정되었습니다.' : '로그인되었습니다.');
    showDashboard();
  } catch (error) {
    setMessage('authMessage', error.message);
    try {
      const status = await requestJSON('/api/admin/status');
      if (!status.setupRequired) {
        setupRequired = false;
        $('authTitle').textContent = '관리자 로그인';
        $('authDescription').textContent = '관리자 비밀번호를 입력하세요.';
        $('passwordConfirmWrap').classList.add('hidden');
        $('adminPasswordConfirm').required = false;
        $('authSubmit').textContent = '로그인';
      }
    } catch (_) { /* keep the original error visible */ }
  } finally { button.disabled = false; }
}

function showDashboard() {
  $('authView').classList.add('hidden');
  $('dashboard').classList.remove('hidden');
  activateTab('rankingsPanel');
  loadRankings();
}

function activateTab(id) {
  document.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('selected', button.dataset.tab === id));
  document.querySelectorAll('.tabPanel').forEach(panel => panel.classList.toggle('hidden', panel.id !== id));
  if (id === 'vocabularyPanel' && !vocabularyData) loadVocabulary();
}

async function logout() {
  try { await api('/api/admin/logout', { method: 'POST', body: {} }); } catch (_) { /* the session may already have expired */ }
  csrfToken = '';
  showAuth(false, '로그아웃되었습니다.');
}

async function loadRankings() {
  $('rankListStatus').textContent = '랭킹을 불러오는 중입니다.';
  $('adminRankBody').replaceChildren();
  try {
    const category = $('adminRankCategory').value;
    const data = await api(`/api/admin/rankings?category=${encodeURIComponent(category)}&limit=2000`);
    activeRankings = data.rankings || [];
    $('rankListStatus').textContent = `${categoryLabel(category)} · ${Number(data.total || 0).toLocaleString()}개 기록`;
    renderRankings();
  } catch (error) { $('rankListStatus').textContent = `랭킹 조회 실패: ${error.message}`; }
}

function renderRankings() {
  const tbody = $('adminRankBody'); tbody.replaceChildren();
  const query = $('rankSearch').value.trim().toLocaleLowerCase('ko-KR');
  const filtered = activeRankings.filter(record => !query || String(record.name || '').toLocaleLowerCase('ko-KR').includes(query));
  if (!filtered.length) {
    const tr = document.createElement('tr'); const td = document.createElement('td');
    td.colSpan = 7; td.className = 'emptyState'; td.textContent = activeRankings.length ? '검색 결과가 없습니다.' : '아직 등록된 기록이 없습니다.';
    tr.appendChild(td); tbody.appendChild(tr); return;
  }
  filtered.forEach(record => {
    const tr = document.createElement('tr');
    addCell(tr, `${record.rank || '-'}위`); addCell(tr, `${record.name || '(이름 없음)'}${record.adminCreated ? ' · 관리자 생성' : ''}`);
    const score = addCell(tr, `${Number(record.score || 0).toFixed(1)}점`, 'rankScoreText');
    addCell(tr, Number(record.correctCount || 0)); addCell(tr, Number(record.questionCount || 0)); addCell(tr, formatDate(record.createdAt));
    const td = document.createElement('td'); const button = document.createElement('button');
    button.className = 'button secondary editRecordBtn'; button.type = 'button'; button.textContent = '수정';
    button.addEventListener('click', () => openRankEditor(record.id)); td.appendChild(button); tr.appendChild(td); tbody.appendChild(tr);
  });
}

async function openRankEditor(id) {
  $('rankEditorPanel').classList.remove('hidden');
  $('rankEditorTitle').textContent = '랭킹 기록을 불러오는 중입니다.';
  $('answerEditorRows').replaceChildren(); setMessage('rankEditMessage', '');
  try {
    const record = await api(`/api/admin/rankings/${encodeURIComponent(id)}`);
    selectedRankId = record.id;
    $('rankEditorTitle').textContent = `${record.name} · ${record.rank || '-'}위`;
    $('rankEditorMeta').textContent = `${categoryLabel(record.category)} · ${record.questionCount}문항 · ${formatDate(record.createdAt)}${record.adminCreated ? ' · 관리자가 생성한 기록' : ''}`;
    $('editRankName').value = record.name || '';
    $('editRankScore').value = Number(record.score || 0).toFixed(1);
    renderAnswerEditors(record.answers || []);
    $('rankEditorPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { setMessage('rankEditMessage', `기록을 불러오지 못했습니다: ${error.message}`); }
}

function renderAnswerEditors(answers) {
  const host = $('answerEditorRows'); host.replaceChildren();
  if (!answers.length) { const empty = document.createElement('div'); empty.className = 'emptyState'; empty.textContent = '문항별 기록이 없습니다.'; host.appendChild(empty); return; }
  answers.forEach((answer, index) => {
    const row = document.createElement('article'); row.className = 'answerEditRow'; row.dataset.index = String(index);
    const head = document.createElement('div'); head.className = 'answerEditHead';
    const number = document.createElement('span'); number.textContent = `${answer.number || index + 1}. ${answer.prompt || ''}`;
    const word = document.createElement('span'); word.textContent = answer.word || '';
    head.append(number, word); row.appendChild(head);
    const description = document.createElement('p'); description.className = 'answerEditDescription'; description.textContent = `기준 정답: ${answer.target || ''} · ${answer.direction === 'ko2en' ? '한국어 → 영어' : '영어 → 한국어'}`; row.appendChild(description);
    const fields = document.createElement('div'); fields.className = 'answerEditFields';
    const answerWrap = document.createElement('label'); answerWrap.className = 'answerEditAnswerWrap'; answerWrap.textContent = '사용자가 입력한 답안';
    const answerInput = document.createElement('input'); answerInput.className = 'answerEditAnswer'; answerInput.name = 'answer'; answerInput.maxLength = 500; answerInput.value = answer.answer || ''; answerWrap.appendChild(answerInput);
    const correctWrap = document.createElement('label'); correctWrap.className = 'correctCheck';
    const correctInput = document.createElement('input'); correctInput.type = 'checkbox'; correctInput.name = 'correct'; correctInput.checked = Boolean(answer.correct);
    const correctText = document.createElement('span'); correctText.textContent = '정답 처리'; correctWrap.append(correctInput, correctText);
    const elapsedWrap = document.createElement('label'); elapsedWrap.textContent = '풀이 시간(초)';
    const elapsedInput = document.createElement('input'); elapsedInput.type = 'number'; elapsedInput.name = 'elapsedSeconds'; elapsedInput.min = '0'; elapsedInput.max = '10'; elapsedInput.step = '0.1'; elapsedInput.value = Number(answer.elapsedSeconds || 0).toFixed(1); elapsedWrap.appendChild(elapsedInput);
    const remainingWrap = document.createElement('label'); remainingWrap.textContent = '남은 시간(초)';
    const remainingInput = document.createElement('input'); remainingInput.type = 'number'; remainingInput.name = 'remainingSeconds'; remainingInput.min = '0'; remainingInput.max = '10'; remainingInput.step = '0.1'; remainingInput.value = Number(answer.remainingSeconds || 0).toFixed(1); remainingWrap.appendChild(remainingInput);
    fields.append(answerWrap, correctWrap, elapsedWrap, remainingWrap); row.appendChild(fields); host.appendChild(row);
  });
}

function readAnswerEditors() {
  return Array.from($('answerEditorRows').querySelectorAll('.answerEditRow')).map(row => ({
    answer: row.querySelector('[name="answer"]').value,
    correct: row.querySelector('[name="correct"]').checked,
    elapsedSeconds: Number(row.querySelector('[name="elapsedSeconds"]').value),
    remainingSeconds: Number(row.querySelector('[name="remainingSeconds"]').value)
  }));
}

function recalculateVisibleScore() {
  const rows = readAnswerEditors();
  if (rows.some(row => !Number.isFinite(row.elapsedSeconds) || row.elapsedSeconds < 0 || row.elapsedSeconds > 10 || !Number.isFinite(row.remainingSeconds) || row.remainingSeconds < 0 || row.remainingSeconds > 10)) {
    return setMessage('rankEditMessage', '각 문항의 시간은 0~10초로 입력하세요.');
  }
  const correct = rows.filter(row => row.correct).length;
  const timeBonus = rows.reduce((sum, row) => sum + (row.correct ? row.remainingSeconds : 0), 0);
  $('editRankScore').value = (correct + timeBonus).toFixed(1);
  setMessage('rankEditMessage', `계산 결과: ${correct}점 정답 점수 + ${timeBonus.toFixed(1)}점 시간 점수 = ${(correct + timeBonus).toFixed(1)}점`, true);
}

async function saveRankingEdits(event) {
  event.preventDefault();
  if (!selectedRankId) return;
  const name = $('editRankName').value.trim();
  const score = Number($('editRankScore').value);
  const answers = readAnswerEditors();
  if (!name) return setMessage('rankEditMessage', '랭킹 이름을 입력하세요.');
  if (!Number.isFinite(score) || score < 0 || score > 10000000) return setMessage('rankEditMessage', '점수는 0~10,000,000 사이로 입력하세요.');
  if (answers.some(row => !Number.isFinite(row.elapsedSeconds) || row.elapsedSeconds < 0 || row.elapsedSeconds > 10 || !Number.isFinite(row.remainingSeconds) || row.remainingSeconds < 0 || row.remainingSeconds > 10)) return setMessage('rankEditMessage', '각 문항의 시간은 0~10초로 입력하세요.');
  const button = $('rankEditForm').querySelector('button[type="submit"]'); button.disabled = true;
  setMessage('rankEditMessage', '수정 사항 저장 중입니다.');
  try {
    const record = await api(`/api/admin/rankings/${encodeURIComponent(selectedRankId)}`, { method: 'PUT', body: { name, score, answers } });
    setMessage('rankEditMessage', '저장했습니다. 정답 수와 시간 점수는 문항 기록 기준으로 갱신되었습니다.', true);
    showToast('랭킹 기록을 저장했습니다.');
    await loadRankings();
    $('rankEditorTitle').textContent = `${record.name} · ${record.rank || '-'}위`;
    $('rankEditorMeta').textContent = `${categoryLabel(record.category)} · ${record.questionCount}문항 · ${formatDate(record.createdAt)}${record.adminCreated ? ' · 관리자가 생성한 기록' : ''}`;
  } catch (error) { setMessage('rankEditMessage', `저장 실패: ${error.message}`); }
  finally { button.disabled = false; }
}

async function deleteSelectedRanking() {
  if (!selectedRankId) return;
  if (!confirm('이 랭킹 기록을 영구 삭제할까요? 이 작업은 되돌릴 수 없습니다.')) return;
  try {
    await api(`/api/admin/rankings/${encodeURIComponent(selectedRankId)}`, { method: 'DELETE', body: {} });
    selectedRankId = ''; $('rankEditorPanel').classList.add('hidden');
    showToast('랭킹 기록을 삭제했습니다.'); await loadRankings();
  } catch (error) { setMessage('rankEditMessage', `삭제 실패: ${error.message}`); }
}

function closeRankEditor() { selectedRankId = ''; $('rankEditorPanel').classList.add('hidden'); }

async function createPerfectRanking(event) {
  event.preventDefault();
  const name = $('perfectRankName').value.trim();
  const category = $('perfectRankCategory').value;
  const direction = $('perfectRankDirection').value;
  if (!name) return setMessage('perfectRankStatus', '이름을 입력하세요.');
  const button = $('perfectRankForm').querySelector('button[type="submit"]'); button.disabled = true;
  setMessage('perfectRankStatus', '랭킹 기록을 생성하는 중입니다.');
  try {
    const record = await api('/api/admin/rankings/perfect', { method: 'POST', body: { name, category, direction } });
    $('adminRankCategory').value = category;
    $('rankSearch').value = '';
    setMessage('perfectRankStatus', `완료: ${record.name} · ${record.score.toFixed(1)}점 · ${record.questionCount}문항`, true);
    showToast('완벽한 점수의 랭킹 기록을 생성했습니다.');
    await loadRankings(); await openRankEditor(record.id);
  } catch (error) { setMessage('perfectRankStatus', `생성 실패: ${error.message}`); }
  finally { button.disabled = false; }
}

async function loadVocabulary() {
  $('wordListStatus').textContent = '단어 자료를 불러오는 중입니다.';
  try {
    vocabularyData = await api('/api/admin/vocabulary');
    $('wordListStatus').textContent = `1~13강 · ${Object.values(vocabularyData).reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0).toLocaleString()}개 항목`;
    renderWordList();
    if (selectedWordIndex !== null) populateWordEditor(selectedWordIndex);
  } catch (error) { $('wordListStatus').textContent = `단어 자료 조회 실패: ${error.message}`; }
}

function currentSectionWords() {
  const section = $('wordSectionSelect').value;
  return Array.isArray(vocabularyData?.[section]) ? vocabularyData[section] : [];
}

function renderWordList() {
  const host = $('wordList'); host.replaceChildren();
  if (!vocabularyData) { host.textContent = '단어 자료를 불러오는 중입니다.'; return; }
  const search = $('wordSearch').value.trim().toLocaleLowerCase('ko-KR');
  const entries = currentSectionWords();
  let count = 0;
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    const word = String(entry.word || '');
    const meanings = Array.isArray(entry.meanings) ? entry.meanings.join(' / ') : '';
    if (search && !`${word} ${meanings}`.toLocaleLowerCase('ko-KR').includes(search)) return;
    count += 1;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'wordListItem';
    if (selectedWordIndex === index) button.classList.add('selected');
    const title = document.createElement('strong'); title.textContent = `${index + 1}. ${word || '(표제어 없음)'}`;
    const meaningLine = document.createElement('span'); meaningLine.textContent = meanings || '(뜻 없음)';
    button.append(title, meaningLine);
    button.addEventListener('click', () => { selectedWordIndex = index; populateWordEditor(index); renderWordList(); });
    host.appendChild(button);
  });
  if (!count) { const empty = document.createElement('div'); empty.className = 'emptyState'; empty.textContent = search ? '검색 결과가 없습니다.' : '이 강에는 단어가 없습니다.'; host.appendChild(empty); }
}

function populateWordEditor(index) {
  const entries = currentSectionWords(); const entry = entries[index];
  if (!entry || typeof entry !== 'object') return clearWordForm();
  $('wordEditorTitle').textContent = `${$('wordSectionSelect').value}강 · ${index + 1}번 단어 수정`;
  $('wordEnglish').value = String(entry.word || '');
  $('wordMeanings').value = Array.isArray(entry.meanings) ? entry.meanings.join('\n') : '';
  $('wordForm').value = String(entry.form || '');
  $('wordOther').value = linesToText(entry.other);
  $('wordSynonyms').value = linesToText(entry.synonyms);
  $('wordAntonyms').value = linesToText(entry.antonyms);
  $('deleteWordBtn').disabled = false;
  setMessage('wordEditMessage', '');
}

function clearWordForm() {
  $('wordEditorTitle').textContent = `${$('wordSectionSelect').value}강 · 새 단어`;
  ['wordEnglish','wordMeanings','wordForm','wordOther','wordSynonyms','wordAntonyms'].forEach(id => { $(id).value = ''; });
  $('deleteWordBtn').disabled = true;
  setMessage('wordEditMessage', '새 단어를 입력하고 저장하세요.');
  renderWordList();
}

function linesToText(value) { return Array.isArray(value) ? value.join('\n') : ''; }
function textToLines(value) { return String(value || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean); }
function wordPayload() {
  return {
    word: $('wordEnglish').value.trim(), meanings: textToLines($('wordMeanings').value), form: $('wordForm').value.trim(),
    other: textToLines($('wordOther').value), synonyms: textToLines($('wordSynonyms').value), antonyms: textToLines($('wordAntonyms').value)
  };
}

async function saveWord(event) {
  event.preventDefault();
  const section = $('wordSectionSelect').value;
  const body = wordPayload();
  if (!body.word) return setMessage('wordEditMessage', '영단어를 입력하세요.');
  if (!body.meanings.length) return setMessage('wordEditMessage', '뜻을 하나 이상 입력하세요.');
  const button = $('saveWordBtn'); button.disabled = true;
  try {
    const isNew = selectedWordIndex === null;
    const endpoint = isNew ? `/api/admin/vocabulary/${section}` : `/api/admin/vocabulary/${section}/${selectedWordIndex}`;
    const result = await api(endpoint, { method: isNew ? 'POST' : 'PUT', body });
    selectedWordIndex = result.itemIndex;
    await loadVocabulary();
    setMessage('wordEditMessage', isNew ? '새 단어를 추가했습니다.' : '단어를 수정했습니다.', true);
    showToast(isNew ? '단어를 추가했습니다.' : '단어를 수정했습니다.');
    renderWordList();
  } catch (error) { setMessage('wordEditMessage', `저장 실패: ${error.message}`); }
  finally { button.disabled = false; }
}

async function deleteSelectedWord() {
  if (selectedWordIndex === null) return;
  const entry = currentSectionWords()[selectedWordIndex];
  if (!confirm(`“${entry?.word || '이 단어'}”를 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return;
  try {
    await api(`/api/admin/vocabulary/${$('wordSectionSelect').value}/${selectedWordIndex}`, { method: 'DELETE', body: {} });
    selectedWordIndex = null; clearWordForm(); await loadVocabulary();
    showToast('단어를 삭제했습니다.');
  } catch (error) { setMessage('wordEditMessage', `삭제 실패: ${error.message}`); }
}

async function changePassword(event) {
  event.preventDefault();
  const currentPassword = $('currentPassword').value;
  const newPassword = $('newPassword').value;
  const confirmPassword = $('newPasswordConfirm').value;
  if (newPassword.length < 12) return setMessage('changePasswordMessage', '새 비밀번호는 12자 이상이어야 합니다.');
  if (newPassword !== confirmPassword) return setMessage('changePasswordMessage', '새 비밀번호 확인이 일치하지 않습니다.');
  if (currentPassword === newPassword) return setMessage('changePasswordMessage', '현재 비밀번호와 다른 비밀번호를 사용하세요.');
  try {
    await api('/api/admin/password', { method: 'POST', body: { currentPassword, newPassword } });
    csrfToken = '';
    showAuth(false, '비밀번호를 변경했습니다. 새 비밀번호로 다시 로그인하세요.');
    $('currentPassword').value = ''; $('newPassword').value = ''; $('newPasswordConfirm').value = '';
  } catch (error) { setMessage('changePasswordMessage', `변경 실패: ${error.message}`); }
}

function addCell(row, value, className = '') {
  const td = document.createElement('td'); td.textContent = String(value ?? ''); if (className) td.className = className; row.appendChild(td); return td;
}
function categoryLabel(category) { return category === 'all' ? '랜덤 전부' : `랜덤 ${category}개`; }
function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}
function setMessage(id, value, success = false) {
  const element = $(id); if (!element) return;
  element.textContent = value || ''; element.classList.toggle('success', Boolean(success));
}
function showToast(message) {
  const toast = $('toast'); toast.textContent = message; toast.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3500);
}
