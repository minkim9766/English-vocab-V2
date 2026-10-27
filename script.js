let words = [];
let currentList = [];
let currentIndex = 0;
let mode = 'ko2en';
let sessionType = 'flash';
let known = new Set();
let unknown = new Set();
// Swipe tracking
let isDragging = false;
let startX = 0;
let startY = 0;
let currentX = 0;
let currentY = 0;
let lastDragDistance = 0;
let quizCorrectCnt = 0;
let quizExactCnt = 0;
let quizPartialCnt = 0;
let quizWrongItems = [];
let quizCount = 'all';
let quizMastery = Object.create(null);
let quizEffectTimers = [];

const STORAGE_KEY = '영단어_progress_v1';
const CSV_URL = '영단어.csv';
const CSV_POLL_MS = 5000;
let lastCsvHash = '';
let pollTimer = null;

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.modeCard').forEach(card => {
        card.addEventListener('click', () => startSession(card.dataset.mode));
    });
    document.querySelectorAll('.quizCountBtn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.quizCountBtn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            quizCount = btn.dataset.count || 'all';
        });
    });
    document.getElementById('exitBtn')?.addEventListener('click', exitToHome);
    document.getElementById('openQuizBtn')?.addEventListener('click', () => openSessionView('quiz'));
    document.getElementById('openFlashBtn')?.addEventListener('click', () => openSessionView('flash'));
    document.getElementById('card').addEventListener('click', (e) => {
        if (Math.abs(lastDragDistance) > 10) {
            lastDragDistance = 0;
            return;
        }
        toggleFlip();
    });
    document.getElementById('knowBtn').addEventListener('click', markKnown);
    document.getElementById('dontKnowBtn').addEventListener('click', markUnknown);
    document.getElementById('skipBtn').addEventListener('click', nextCard);
    document.getElementById('submitAnswer').addEventListener('click', submitAnswer);
    document.getElementById('nextQuiz').addEventListener('click', nextQuiz);
    document.getElementById('card').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleFlip();
        }
    });

    // Drag/Swipe handlers for flashcards
    const cardEl = document.getElementById('card');
    if (cardEl) {
        cardEl.addEventListener('pointerdown', handleDragStart);
        window.addEventListener('pointermove', handleDragMove);
        window.addEventListener('pointerup', handleDragEnd);
        window.addEventListener('pointercancel', handleDragEnd);
    }

    // allow Enter in quiz input to submit or advance
    const quizInput = document.getElementById('quizInput');
    if (quizInput) {
        quizInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (quizAnswered) nextQuiz();
                else submitAnswer();
            }
        });
    }

    loadCsvAndInit();
    startCsvPolling();
});

function hideAllViews() {
    document.getElementById('homeScreen').classList.add('hidden');

    document.getElementById('sessionArea').classList.add('hidden');

    document.getElementById('flashArea').classList.add('hidden');
    document.getElementById('quizArea').classList.add('hidden');

    document.getElementById('flashResultArea').classList.add('hidden');
    document.getElementById('quizResultArea').classList.add('hidden');
    clearQuizResultEffect();

    document.querySelector('.cardWrap')?.classList.remove('hidden');
    document.querySelector('.flashTopStats')?.classList.remove('hidden');
}

function loadCsvAndInit() {
    fetchCsvText()
        .then(t => {
            applyCsvText(t);
            loadProgress();
            updateStats();
            // auto-start if opened with params
            const params = new URLSearchParams(location.search);
            const pmode = params.get('mode');
            const pstart = params.get('start');
            if (pmode) mode = pmode;
            if (pstart === 'flash') {

                if (currentList.length) {
                    hideAllViews();

                    document.getElementById('sessionArea')
                        .classList.remove('hidden');

                    showFlashArea();
                    showCard();

                } else {
                    startFlashcards();
                }

            } else if (pstart === 'quiz') {

                if (quizList.length) {

                    hideAllViews();

                    document.getElementById('sessionArea')
                        .classList.remove('hidden');

                    document.getElementById('quizArea')
                        .classList.remove('hidden');

                    showQuiz();

                } else {
                    beginQuizSession();
                }

            } else {
                // Explicitly show home
                document.getElementById('homeScreen').classList.remove('hidden');
                document.getElementById('sessionArea').classList.add('hidden');
            }
        })
        .catch(err => {
            const statsEl = document.getElementById('stats');
            if (statsEl) {
                statsEl.textContent = 'CSV 파일을 불러올 수 없습니다. 로컬 서버로 서빙하세요.';
            } else {
                console.warn('CSV 파일을 불러올 수 없습니다. 로컬 서버로 서빙하세요.', err);
            }
        });
}

function startCsvPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
        fetchCsvText()
            .then(t => {
                const changed = applyCsvText(t);
                if (changed) showCsvToast();
            })
            .catch(() => {});
    }, CSV_POLL_MS);
}

function fetchCsvText() {
    const bust = Date.now();
    const url = `${CSV_URL}?t=${bust}`;
    return fetch(url, {
        cache: 'no-store'
    }).then(r => r.text());
}

function applyCsvText(text) {
    const hash = simpleHash(text);
    if (hash === lastCsvHash) return false;
    lastCsvHash = hash;
    words = parseCSV(text);
    updateStats();
    syncSessionListsWithWords();
    refreshVisibleCardIfSafe();
    return true;
}

function applyUpdatedWordsToSession() {
    if (!words.length) return;
    if (sessionType === 'flash' && !document.getElementById('flashArea').classList.contains('hidden')) {
        currentList = shuffle(words.slice());
        currentIndex = 0;
        showCard();
        return;
    }
    if (sessionType === 'quiz' && !document.getElementById('quizArea').classList.contains('hidden')) {
        quizList = shuffle(words.slice());
        quizIndex = 0;
        showQuiz();
    }
}

function simpleHash(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return String(hash >>> 0);
}

function showCsvToast() {
    const host = document.getElementById('toastHost');
    if (!host) return;

    const existing = host.querySelector('.toast');
    if (existing) removeToast(existing);

    const toast = document.createElement('div');
    toast.className = 'toast';

    const text = document.createElement('div');
    text.className = 'toastText';
    text.textContent = 'CSV가 업데이트됨';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'toastClose';
    closeBtn.setAttribute('aria-label', '알림 닫기');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => removeToast(toast));

    toast.appendChild(text);
    toast.appendChild(closeBtn);
    host.appendChild(toast);

    const timer = setTimeout(() => removeToast(toast), 5000);
    toast.dataset.timer = String(timer);
}

function syncSessionListsWithWords() {
    if (!words.length) return;
    const map = new Map(words.map(w => [w.en, w]));
    if (currentList.length) {
        currentList = currentList.map(item => map.get(item.en) || item);
    }
    if (quizList.length) {
        quizList = quizList.map(item => map.get(item.en) || item);
    }
}

function refreshVisibleCardIfSafe() {
    if (sessionType === 'flash' && !document.getElementById('flashArea').classList.contains('hidden')) {
        if (currentIndex < currentList.length) {
            showCard();
        }
        return;
    }
    if (sessionType === 'quiz' && !document.getElementById('quizArea').classList.contains('hidden')) {
        if (quizAnswered) {
            showQuiz();
        }
    }
}

function removeToast(toast) {
    if (!toast) return;
    const timer = Number(toast.dataset.timer || 0);
    if (timer) clearTimeout(timer);
    if (toast.parentNode) toast.parentNode.removeChild(toast);
}

function parseCSV(text) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length);
    const delimiter = detectDelimiterFromText(text);
    const arr = [];
    for (const line of lines) {
        const fields = parseCSVLine(line, delimiter);
        if (fields.length < 2) continue;
        const a = fields[0].trim();
        const b = fields.slice(1).join(delimiter).trim();
        if (!a || !b) continue;
        arr.push({
            en: a,
            kr: b
        });
    }
    return arr;
}

function detectDelimiterFromText(text) {
    return text.includes('\t') ? '\t' : ',';
}

function parseCSVLine(line, delimiter) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            const next = line[i + 1];
            if (inQuotes && next === '"') {
                cur += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }
        if (ch === delimiter && !inQuotes) {
            out.push(cur);
            cur = '';
            continue;
        }
        cur += ch;
    }
    out.push(cur);
    return out;
}

function startFlashcards() {
    sessionType = 'flash';

    if (!words.length) {
        alert('단어 목록이 없습니다.');
        return;
    }

    hideAllViews();

    currentList = shuffle(words.slice());
    currentIndex = 0;

    known.clear();
    unknown.clear();

    const labelEl = document.getElementById('sessionLabel');

    if (labelEl) {
        labelEl.textContent = modeLabel(mode) + ' · 플래시카드';
    }

    document.getElementById('sessionArea').classList.remove('hidden');

    showFlashArea();
    showCard();
}

function startSession(selectedMode) {
    mode = selectedMode;
    // Use history push state to act like a redirect without a page reload
    const url = `${location.pathname}?mode=${encodeURIComponent(selectedMode)}&start=flash`;
    window.history.pushState({
        mode: selectedMode,
        start: 'flash'
    }, '', url);
    startFlashcards();
}

function exitToHome() {
    window.history.pushState({}, '', location.pathname);

    hideAllViews();

    document.getElementById('homeScreen').classList.remove('hidden');

    sessionType = '';
    quizAnswered = false;

    currentIndex = 0;
    quizIndex = 0;
}

function showFlashArea() {
    document.getElementById('flashArea').classList.remove('hidden');
    document.getElementById('quizArea').classList.add('hidden');
}

function openSessionView(view) {
    // switch views in the same window, updating URL seamlessly
    const url = `${location.pathname}?mode=${encodeURIComponent(mode)}&start=${view}`;
    window.history.pushState({
        mode: mode,
        start: view
    }, '', url);
    if (view === 'quiz') {
        beginQuizSession();
        return;
    }
    if (view === 'flash') {
        startFlashcards();
        return;
    }
}

function beginQuizSession() {
    sessionType = 'quiz';

    if (!words.length) {
        alert('단어 목록이 없습니다.');
        return;
    }

    hideAllViews();

    const baseList =
        currentList.length ?
        currentList.slice() :
        shuffle(words.slice());

    const shuffled = prioritizeQuizWords(baseList.slice());

    if (quizCount !== 'all') {
        const countNum = Math.max(1, Number(quizCount) || 0);

        quizList = shuffled.slice(
            0,
            Math.min(countNum, shuffled.length)
        );
    } else {
        quizList = shuffled.slice();
    }

    quizIndex = 0;
    quizCorrectCnt = 0;
    quizExactCnt = 0;
    quizPartialCnt = 0;
    quizWrongItems = [];

    const labelEl = document.getElementById('sessionLabel');

    if (labelEl) {
        labelEl.textContent = modeLabel(mode) + ' · 퀴즈';
    }

    document.getElementById('sessionArea').classList.remove('hidden');
    document.getElementById('quizArea').classList.remove('hidden');

    updateQuizStats();
    showQuiz();
}

function showCard() {
    const item = currentList[currentIndex];
    const card = document.getElementById('card');
    const cardInner = card ? card.querySelector('.cardInner') : null;
    const front = document.getElementById('cardFront');
    const back = document.getElementById('cardBack');

    if (!item) {
        endFlashcards();
        return;
    }

    const dir = mode === 'random' ? (Math.random() < 0.5 ? 'en2ko' : 'ko2en') : mode;
    isFlipped = false;
    if (card) card.classList.remove('show-back');
    if (cardInner) {
        cardInner.style.transition = 'none';
        cardInner.style.transform = 'rotateY(0deg)';
        setTimeout(() => cardInner.style.transition = 'transform .8s cubic-bezier(.2,.9,.3,1)', 50);
    }

    // remember which direction this card is shown so flip always reveals the matching translation
    if (card) card.dataset.dir = dir;
    if (dir === 'en2ko') {
        front.innerHTML = renderSide(item.en, '문제', '영어');
        back.innerHTML = renderSide('...', '정답', '확인하려면 뒤집기');
        requestAnimationFrame(() => {
            back.innerHTML = renderSide(item.kr, '정답', '한국어 뜻');
        });
    } else {
        front.innerHTML = renderSide(item.kr, '문제', '한국어');
        back.innerHTML = renderSide('...', '정답', '확인하려면 뒤집기');
        requestAnimationFrame(() => {
            back.innerHTML = renderSide(item.en, '정답', '영어 뜻');
        });
    }

    updateFlashStats();
    updateStats();
}

function updateFlashStats() {
    const countUnk = unknown.size;
    const countKnw = known.size;
    const elUnk = document.getElementById('flUnk');
    const elKnw = document.getElementById('flKnw');
    if (elUnk) elUnk.textContent = countUnk;
    if (elKnw) elKnw.textContent = countKnw;
}

function endFlashcards() {
    // Hide flashcard area & top stats, show Result Area
    document.querySelector('.cardWrap').classList.add('hidden');
    document.querySelector('.flashTopStats').classList.add('hidden');
    document.getElementById('flashResultArea').classList.remove('hidden');

    const total = known.size + unknown.size;
    const acc = total > 0 ? Math.round((known.size / total) * 100) : 0;

    const resultStats = document.querySelector('.flashResultStats');
    if (resultStats) resultStats.innerHTML = `
    <p>총 <strong>${total}</strong>단어 중</p>
    <p><span style="color:#10b981;font-weight:bold;">${known.size}</span>개의 단어를 외웠습니다.</p>
    <p><span style="color:#ef4444;font-weight:bold;">${unknown.size}</span>개의 단어를 놓쳤습니다.</p>
  `;
}

function toggleFlip() {
    const card = document.getElementById('card');
    const inner = card.querySelector('.cardInner');
    if (card.classList.contains('flipping')) return;
    card.classList.add('flipping');

    // squeeze animation without mirrored glyph artifacts
    inner.classList.remove('flipPulse');
    void inner.offsetWidth;
    inner.classList.add('flipPulse');

    setTimeout(() => {
        card.classList.toggle('show-back');
    }, 140);

    setTimeout(() => {
        inner.classList.remove('flipPulse');
        card.classList.remove('flipping');
    }, 300);
}

function handleDragStart(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    currentX = 0;
    currentY = 0;
    lastDragDistance = 0;
    document.body.classList.add('dragLock');
    document.documentElement.classList.add('dragLock');
    const card = document.getElementById('card');
    if (card) {
        card.style.transition = 'none';
        card.setPointerCapture?.(e.pointerId);
    }
}

function handleDragMove(e) {
    if (!isDragging) return;
    const card = document.getElementById('card');
    if (!card) return;
    currentX = e.clientX - startX;
    currentY = e.clientY - startY;
    const showDown = currentY > 80 && Math.abs(currentX) < 80;
    const wrap = document.querySelector('.cardWrap');
    if (wrap) {
        wrap.classList.toggle('show-left', currentX < -80 && !showDown);
        wrap.classList.toggle('show-right', currentX > 80 && !showDown);
        wrap.classList.toggle('show-down', showDown);
    }

    const overlay = document.querySelector('.dragOverlay');
    if (overlay) {
        const leftLabel = overlay.querySelector('.dragLabel.left');
        const rightLabel = overlay.querySelector('.dragLabel.right');
        const downLabel = overlay.querySelector('.dragLabel.down');
        const divider = overlay.querySelector('.dragDivider');
        const strengthX = Math.min(1, Math.abs(currentX) / 180);
        const strengthY = Math.min(1, Math.max(0, currentY) / 180);
        if (leftLabel) leftLabel.style.opacity = currentX < 0 && !showDown ? (0.15 + strengthX * 0.75).toFixed(2) : '0';
        if (rightLabel) rightLabel.style.opacity = currentX > 0 && !showDown ? (0.15 + strengthX * 0.75).toFixed(2) : '0';
        if (downLabel) downLabel.style.opacity = showDown ? (0.2 + strengthY * 0.75).toFixed(2) : '0';
        if (divider) divider.style.opacity = (Math.min(1, strengthX * 1.2)).toFixed(2);
    }

    card.style.transform = `translateX(${currentX}px) translateY(${Math.max(0, currentY)}px) rotate(${currentX * 0.05}deg)`;
    card.classList.toggle('is-skip', showDown);

    if (currentX < -100) card.style.boxShadow = '0 0 40px rgba(16,185,129,0.45)';
    else if (currentX > 100) card.style.boxShadow = '0 0 40px rgba(239,68,68,0.4)';
    else card.style.boxShadow = '';

    e.preventDefault();
}

function handleDragEnd() {
    if (!isDragging) return;
    isDragging = false;
    document.body.classList.remove('dragLock');
    document.documentElement.classList.remove('dragLock');
    const card = document.getElementById('card');
    if (!card) return;
    lastDragDistance = Math.max(Math.abs(currentX), Math.abs(currentY));
    card.style.transition = 'transform 0.35s cubic-bezier(0.2, 0.9, 0.3, 1), opacity 0.35s';
    card.style.boxShadow = '';
    card.classList.remove('is-skip');

    const wrap = document.querySelector('.cardWrap');
    if (wrap) {
        wrap.classList.remove('show-left', 'show-right', 'show-down');
    }

    if (currentY > 120 && Math.abs(currentX) < 120) {
        card.style.transform = `translateY(${window.innerHeight}px)`;
        card.style.opacity = '0';
        setTimeout(() => {
            nextCard();
            resetCardPosition();
        }, 200);
    } else if (currentX < -120) {
        card.style.transform = `translateX(-${window.innerWidth}px) rotate(-30deg)`;
        card.style.opacity = '0';
        setTimeout(() => {
            markKnown();
            resetCardPosition();
        }, 200);
    } else if (currentX > 120) {
        card.style.transform = `translateX(${window.innerWidth}px) rotate(30deg)`;
        card.style.opacity = '0';
        setTimeout(() => {
            markUnknown();
            resetCardPosition();
        }, 200);
    } else {
        resetCardPosition();
    }
}

function resetCardPosition() {
    const card = document.getElementById('card');
    if (!card) return;
    card.style.transform = 'translateZ(0) translateX(0) rotate(0)';
    card.style.opacity = '1';
    card.classList.remove('is-skip');
    const wrap = document.querySelector('.cardWrap');
    if (wrap) {
        wrap.classList.remove('show-left', 'show-right', 'show-down');
    }
    const overlay = document.querySelector('.dragOverlay');
    if (overlay) {
        overlay.querySelectorAll('.dragLabel').forEach(el => el.style.opacity = '0');
        const divider = overlay.querySelector('.dragDivider');
        if (divider) divider.style.opacity = '0';
    }
    currentX = 0;
    currentY = 0;
}

function markKnown() {
    const item = currentList[currentIndex];
    if (!item) return;
    known.add(item.en);
    unknown.delete(item.en);
    saveProgress();
    nextCard();
}

function markUnknown() {
    const item = currentList[currentIndex];
    if (!item) return;
    unknown.add(item.en);
    known.delete(item.en);
    saveProgress();
    nextCard();
}

function saveProgress() {
    try {
        const payload = {
            known: [...known],
            unknown: [...unknown],
            quizMastery: { ...quizMastery }
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
        console.warn('저장 실패', e)
    }
}

function loadProgress() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const obj = JSON.parse(raw);
        if (obj.known && Array.isArray(obj.known)) known = new Set(obj.known);
        if (obj.unknown && Array.isArray(obj.unknown)) unknown = new Set(obj.unknown);
        if (obj.quizMastery && typeof obj.quizMastery === 'object') {
            const nextQuizMastery = Object.create(null);
            Object.entries(obj.quizMastery).forEach(([en, count]) => {
                const normalized = Number(count);
                if (!Number.isFinite(normalized) || normalized <= 0) return;
                nextQuizMastery[en] = Math.min(3, Math.max(1, Math.floor(normalized)));
            });
            quizMastery = nextQuizMastery;
        }
    } catch (e) {
        console.warn('로컬스토리지 로드 실패', e)
    }
}

function nextCard() {
    currentIndex++;
    if (currentIndex >= currentList.length) {
        endFlashcards();
        updateFlashStats();
        updateStats();
    } else showCard();
}

function updateStats() {
    const total = words.length;
    const statsEl = document.getElementById('stats');
    if (statsEl) {
        statsEl.textContent = `전체 ${total}개 | 외운 것 ${known.size} | 못 외운 것 ${unknown.size}`;
    }
}

function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

const QUIZ_RESULT_EFFECTS = {
    low: {
        pulseCount: 6,
        pulseSize: [140, 240],
        pulseBlur: [14, 24],
        pulseDuration: [1900, 3000],
        pulseAlpha: 0.28,
        pulseDelay: 500,
        ringCount: 1,
        ringSize: [220, 290],
        ringAlpha: 0.22,
        ringDuration: [1300, 1800],
        ringDelay: 220,
        particleCount: 0,
        particleDistance: [0, 0],
        particleSize: [0, 0],
        particleDuration: [0, 0],
        particleDelay: 0,
        palette: ['#fb7185', '#f97316', '#facc15'],
        confettiBursts: []
    },
    steady: {
        pulseCount: 4,
        pulseSize: [88, 150],
        pulseBlur: [8, 16],
        pulseDuration: [1500, 2300],
        pulseAlpha: 0.22,
        pulseDelay: 360,
        ringCount: 1,
        ringSize: [190, 250],
        ringAlpha: 0.28,
        ringDuration: [1100, 1600],
        ringDelay: 140,
        particleCount: 12,
        particleDistance: [86, 150],
        particleSize: [4, 7],
        particleDuration: [900, 1300],
        particleDelay: 220,
        palette: ['#60a5fa', '#22d3ee', '#a78bfa'],
        confettiBursts: [{
            particleCount: 34,
            spread: 62,
            startVelocity: 24,
            gravity: 1.03,
            scalar: 0.82,
            colors: ['#60a5fa', '#22d3ee', '#a78bfa'],
            origin: {
                x: 0.5,
                y: 0.64
            }
        }]
    },
    strong: {
        pulseCount: 5,
        pulseSize: [82, 132],
        pulseBlur: [7, 14],
        pulseDuration: [1300, 2100],
        pulseAlpha: 0.2,
        pulseDelay: 280,
        ringCount: 2,
        ringSize: [190, 290],
        ringAlpha: 0.3,
        ringDuration: [1000, 1500],
        ringDelay: 160,
        particleCount: 18,
        particleDistance: [92, 190],
        particleSize: [4, 8],
        particleDuration: [850, 1250],
        particleDelay: 220,
        palette: ['#34d399', '#22d3ee', '#facc15'],
        confettiBursts: [{
                particleCount: 52,
                spread: 78,
                startVelocity: 30,
                gravity: 0.94,
                scalar: 0.95,
                colors: ['#34d399', '#22d3ee', '#facc15'],
                origin: {
                    x: 0.5,
                    y: 0.62
                }
            },
            {
                particleCount: 22,
                spread: 86,
                startVelocity: 24,
                gravity: 0.92,
                scalar: 0.82,
                colors: ['#34d399', '#22d3ee'],
                origin: {
                    x: 0.16,
                    y: 0.62
                }
            },
            {
                particleCount: 22,
                spread: 86,
                startVelocity: 24,
                gravity: 0.92,
                scalar: 0.82,
                colors: ['#facc15', '#fb7185'],
                origin: {
                    x: 0.84,
                    y: 0.62
                }
            }
        ]
    },
    perfect: {
        pulseCount: 7,
        pulseSize: [84, 144],
        pulseBlur: [6, 12],
        pulseDuration: [1200, 1900],
        pulseAlpha: 0.18,
        pulseDelay: 260,
        ringCount: 3,
        ringSize: [200, 320],
        ringAlpha: 0.34,
        ringDuration: [900, 1400],
        ringDelay: 120,
        particleCount: 26,
        particleDistance: [110, 230],
        particleSize: [4, 9],
        particleDuration: [800, 1200],
        particleDelay: 180,
        palette: ['#fde68a', '#facc15', '#ffffff'],
        confettiBursts: [{
                particleCount: 64,
                spread: 96,
                startVelocity: 36,
                gravity: 0.9,
                scalar: 1.1,
                colors: ['#fde68a', '#facc15', '#ffffff'],
                origin: {
                    x: 0.5,
                    y: 0.6
                }
            },
            {
                particleCount: 26,
                spread: 98,
                startVelocity: 30,
                gravity: 0.88,
                scalar: 0.9,
                colors: ['#fde68a', '#facc15'],
                origin: {
                    x: 0.16,
                    y: 0.56
                }
            },
            {
                particleCount: 26,
                spread: 98,
                startVelocity: 30,
                gravity: 0.88,
                scalar: 0.9,
                colors: ['#fde68a', '#facc15'],
                origin: {
                    x: 0.84,
                    y: 0.56
                }
            },
            {
                particleCount: 18,
                spread: 70,
                startVelocity: 24,
                gravity: 0.92,
                scalar: 0.75,
                colors: ['#ffffff', '#fde68a'],
                origin: {
                    x: 0.5,
                    y: 0.74
                }
            }
        ]
    }
};

function getQuizMastery(en) {
    return Math.max(0, Math.min(3, Number(quizMastery[en]) || 0));
}

function adjustQuizMastery(en, delta) {
    if (!en) return;
    const next = Math.max(0, Math.min(3, getQuizMastery(en) + delta));
    if (next > 0) {
        quizMastery[en] = next;
    } else {
        delete quizMastery[en];
    }
}

function prioritizeQuizWords(list) {
    return list
        .map((item, index) => {
            const mastery = getQuizMastery(item.en);
            const weight = Math.max(0.7, 1 - (mastery * 0.1));
            const priority = -Math.log(Math.max(Math.random(), Number.EPSILON)) / weight;
            return {
                item,
                priority,
                index
            };
        })
        .sort((a, b) => a.priority - b.priority || a.index - b.index)
        .map(entry => entry.item);
}

function getQuizResultTier(acc) {
    if (acc >= 95) return 'perfect';
    if (acc >= 80) return 'strong';
    if (acc >= 55) return 'steady';
    return 'low';
}

function clearQuizResultEffect() {
    const resultBox = document.querySelector('#quizResultArea .resultBox');
    quizEffectTimers.forEach(timerId => clearTimeout(timerId));
    quizEffectTimers = [];
    if (!resultBox) return;
    delete resultBox.dataset.tier;
    resultBox.classList.remove('quizResultBox', 'quizTier-low', 'quizTier-steady', 'quizTier-strong', 'quizTier-perfect');
    const host = resultBox.querySelector('.quizEffectHost');
    if (host) host.innerHTML = '';
}

function ensureQuizResultEffectHost() {
    const resultBox = document.querySelector('#quizResultArea .resultBox');
    if (!resultBox) return null;
    resultBox.classList.add('quizResultBox');
    let host = resultBox.querySelector('.quizEffectHost');
    if (!host) {
        host = document.createElement('div');
        host.className = 'quizEffectHost';
        host.setAttribute('aria-hidden', 'true');
        resultBox.insertBefore(host, resultBox.firstChild);
    }
    return host;
}

function randRange(min, max) {
    return min + (Math.random() * (max - min));
}

function hexToRgba(hex, alpha) {
    if (typeof hex !== 'string') return `rgba(255,255,255,${alpha})`;
    const value = hex.replace('#', '').trim();
    if (value.length === 3) {
        const r = parseInt(value[0] + value[0], 16);
        const g = parseInt(value[1] + value[1], 16);
        const b = parseInt(value[2] + value[2], 16);
        return `rgba(${r},${g},${b},${alpha})`;
    }
    if (value.length === 6) {
        const r = parseInt(value.slice(0, 2), 16);
        const g = parseInt(value.slice(2, 4), 16);
        const b = parseInt(value.slice(4, 6), 16);
        return `rgba(${r},${g},${b},${alpha})`;
    }
    return hex;
}

function spawnQuizPulses(host, effect, tier) {
    for (let i = 0; i < effect.pulseCount; i++) {
        const pulse = document.createElement('span');
        pulse.className = 'quizPulse';
        const color = effect.palette[i % effect.palette.length];
        const xMin = tier === 'low' ? 18 : 22;
        const xMax = tier === 'low' ? 82 : 78;
        const yMin = tier === 'low' ? 18 : 20;
        const yMax = tier === 'low' ? 66 : 58;
        pulse.style.setProperty('--x', `${randRange(xMin, xMax).toFixed(1)}%`);
        pulse.style.setProperty('--y', `${randRange(yMin, yMax).toFixed(1)}%`);
        pulse.style.setProperty('--size', `${randRange(effect.pulseSize[0], effect.pulseSize[1]).toFixed(1)}px`);
        pulse.style.setProperty('--blur', `${randRange(effect.pulseBlur[0], effect.pulseBlur[1]).toFixed(1)}px`);
        pulse.style.setProperty('--duration', `${randRange(effect.pulseDuration[0], effect.pulseDuration[1]).toFixed(0)}ms`);
        pulse.style.setProperty('--delay', `${randRange(0, effect.pulseDelay).toFixed(0)}ms`);
        pulse.style.setProperty('--pulse-color', hexToRgba(color, effect.pulseAlpha));
        host.appendChild(pulse);
    }
}

function spawnQuizRings(host, effect) {
    for (let i = 0; i < effect.ringCount; i++) {
        const ring = document.createElement('span');
        ring.className = 'quizRing';
        const color = effect.palette[i % effect.palette.length];
        ring.style.setProperty('--size', `${randRange(effect.ringSize[0], effect.ringSize[1]).toFixed(1)}px`);
        ring.style.setProperty('--duration', `${randRange(effect.ringDuration[0], effect.ringDuration[1]).toFixed(0)}ms`);
        ring.style.setProperty('--delay', `${randRange(0, effect.ringDelay).toFixed(0)}ms`);
        ring.style.setProperty('--ring-color', hexToRgba(color, effect.ringAlpha));
        host.appendChild(ring);
    }
}

function spawnQuizParticles(host, effect) {
    if (!effect.particleCount) return;
    for (let i = 0; i < effect.particleCount; i++) {
        const particle = document.createElement('span');
        particle.className = i % 4 === 0 ? 'quizParticle quizSpark' : 'quizParticle';
        const color = effect.palette[i % effect.palette.length];
        const angle = Math.random() * Math.PI * 2;
        const distance = randRange(effect.particleDistance[0], effect.particleDistance[1]);
        const driftX = Math.cos(angle) * distance;
        const driftY = Math.sin(angle) * distance - randRange(28, 86);
        particle.style.setProperty('--dx', `${driftX.toFixed(1)}px`);
        particle.style.setProperty('--dy', `${driftY.toFixed(1)}px`);
        particle.style.setProperty('--size', `${randRange(effect.particleSize[0], effect.particleSize[1]).toFixed(1)}px`);
        particle.style.setProperty('--duration', `${randRange(effect.particleDuration[0], effect.particleDuration[1]).toFixed(0)}ms`);
        particle.style.setProperty('--delay', `${randRange(0, effect.particleDelay).toFixed(0)}ms`);
        particle.style.setProperty('--particle-color', color);
        host.appendChild(particle);
    }
}

function playQuizConfetti(effect) {
    if (typeof confetti !== 'function' || !effect.confettiBursts.length) return;
    effect.confettiBursts.forEach((burst, index) => {
        const timerId = window.setTimeout(() => {
            confetti({
                particleCount: burst.particleCount,
                spread: burst.spread,
                startVelocity: burst.startVelocity,
                gravity: burst.gravity,
                scalar: burst.scalar,
                decay: burst.decay,
                ticks: burst.ticks,
                colors: burst.colors,
                origin: burst.origin
            });
        }, burst.delay ?? (index * 120));
        quizEffectTimers.push(timerId);
    });
}

function renderQuizResultEffect(acc) {
    clearQuizResultEffect();
    const tier = getQuizResultTier(acc);
    const effect = QUIZ_RESULT_EFFECTS[tier];
    const resultBox = document.querySelector('#quizResultArea .resultBox');
    const host = ensureQuizResultEffectHost();
    if (!resultBox || !host) return;

    resultBox.dataset.tier = tier;
    host.innerHTML = '';

    spawnQuizPulses(host, effect, tier);
    spawnQuizRings(host, effect);
    spawnQuizParticles(host, effect);
    playQuizConfetti(effect);
}

// Quiz mode
let quizList = [];
let quizIndex = 0;
let quizAnswered = false;

function startQuiz() {
    quizCorrectCnt = 0;
    quizExactCnt = 0;
    quizPartialCnt = 0;
    quizWrongItems = [];
    beginQuizSession();
}

function showQuiz() {
    const item = quizList[quizIndex];
    if (!item) {
        endQuizSession();
        return;
    }
    const dir = mode === 'random' ? (Math.random() < 0.5 ? 'en2ko' : 'ko2en') : mode;
    const promptEl = document.getElementById('quizPrompt');
    if (!promptEl) return;
    // store the direction used for this prompt so submission uses the same
    promptEl.dataset.dir = dir;
    // also store the actual target text to avoid recomputing in submit
    const target = dir === 'en2ko' ? item.kr : item.en;
    promptEl.dataset.target = target;
    promptEl.textContent = dir === 'en2ko' ? item.en : item.kr;
    const quizInputEl = document.getElementById('quizInput');
    if (quizInputEl) quizInputEl.value = '';
    const quizFeedbackEl = document.getElementById('quizFeedback');
    if (quizFeedbackEl) quizFeedbackEl.textContent = '';
    quizAnswered = false;
    updateQuizStats();
}

function updateQuizStats() {
    const elCorrect = document.getElementById('qCorrect');
    const elWrong = document.getElementById('qWrong');
    if (elCorrect) elCorrect.textContent = String(quizCorrectCnt);
    if (elWrong) elWrong.textContent = String(quizWrongItems.length);
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": "&#39;"
    })[c]);
}

function renderSide(mainText, badgeText, subtitleText) {
    return `
    <div class="textInner reveal">
      <span class="badge">${escapeHtml(badgeText)}</span>
      <span class="mainText">${escapeHtml(mainText)}</span>
      <span class="sub">${escapeHtml(subtitleText)}</span>
    </div>
  `;
}

function submitAnswer() {
    const item = quizList[quizIndex];
    if (!item) return;
    if (quizAnswered) return;
    // reuse the same direction that was shown to the user
    const promptEl = document.getElementById('quizPrompt');
    let dir = promptEl.dataset.dir || mode;
    if (dir === 'random') {
        // infer direction from prompt text to keep answer stable
        dir = (promptEl.textContent === item.en) ? 'en2ko' : 'ko2en';
    }
    // prefer stored target (set when showing prompt) to avoid recomputation
    const storedTarget = promptEl.dataset.target;
    const target = (storedTarget && storedTarget.length) ? storedTarget : (dir === 'en2ko' ? item.kr : item.en);
    const ans = document.getElementById('quizInput').value.trim();
    const result = evaluateAnswer(ans, target, {
        quizIndex,
        shownDir: dir,
        prompt: promptEl.textContent
    });

    const fEl = document.getElementById('quizFeedback');
    if (result.kind === 'exact') {
        fEl.textContent = '정답!';
        fEl.style.color = '#10b981';
        quizCorrectCnt++;
        quizExactCnt++;
        adjustQuizMastery(item.en, 1);
    } else if (result.kind === 'partial') {
        fEl.textContent = `부분 정답! 정답: ${target}`;
        fEl.style.color = '#f59e0b';
        quizCorrectCnt++;
        quizPartialCnt++;
        adjustQuizMastery(item.en, 1);
    } else {
        fEl.textContent = `오답 — 정답: ${target}`;
        fEl.style.color = '#ef4444';
        quizWrongItems.push(item);
        adjustQuizMastery(item.en, -1);
    }
    saveProgress();
    updateQuizStats();

    quizAnswered = true;
}

function nextQuiz() {
    quizIndex++;
    quizAnswered = false;
    showQuiz();
}

function modeLabel(value) {
    if (value === 'ko2en') return '한국어 → 영어';
    if (value === 'en2ko') return '영어 → 한국어';
    return '랜덤';
}

function evaluateAnswer(answer, target, ctx = {}) {
    if (!answer) {
        console.log('evaluateAnswer: empty answer', ctx);
        return { kind: 'wrong' };
    }
    const a = normalize(answer);
    const t = normalize(target);
    if (!a) {
        console.log('evaluateAnswer: normalized answer empty', {
            answer,
            ctx
        });
        return { kind: 'wrong' };
    }

    const answerVariants = splitMeaningVariants(a);
    const targetVariants = splitMeaningVariants(t);
    let sawPartial = false;
    for (const tv of targetVariants) {
        for (const av of answerVariants) {
            const kind = checkAnswerVariant(av, tv, ctx);
            if (kind === 'exact') {
                return {
                    kind: 'exact',
                    answer: a,
                    target: t
                };
            }
            if (kind === 'partial') {
                sawPartial = true;
            }
        }
    }

    return {
        kind: sawPartial ? 'partial' : 'wrong',
        answer: a,
        target: t
    };
}

function isCorrect(answer, target, ctx = {}) {
    return evaluateAnswer(answer, target, ctx).kind !== 'wrong';
}

function splitMeaningVariants(text) {
    return text
        .split(/\s*(?:\||\/|;|,|·|•|\band\b|\b또는\b|\b및\b|\b그리고\b)\s*/gi)
        .map(s => s.trim())
        .filter(Boolean);
}

function checkAnswerVariant(a, t, ctx = {}) {
    if (a === t) {
        console.log('isCorrect: exact match', {
            a,
            t,
            ctx
        });
        return 'exact';
    }

    const short = Math.min(a.length, t.length) <= 3;
    if (!short && (t.includes(a) || a.includes(t))) {
        console.log('isCorrect: substring match', {
            a,
            t,
            ctx
        });
        return 'partial';
    }

    const atoks = new Set(a.split(/\s+/).filter(Boolean));
    const ttoks = new Set(t.split(/\s+/).filter(Boolean));
    const common = [...ttoks].filter(x => atoks.has(x)).length;
    if (ttoks.size > 0 && (common / ttoks.size) >= 0.6) {
        console.log('isCorrect: token overlap', {
            a,
            t,
            common,
            ttoksSize: ttoks.size,
            ctx
        });
        return 'partial';
    }

    const d = levenshtein(a, t);
    const thresh = Math.max(1, Math.floor(t.length * 0.25));
    const ok = d <= thresh;
    console.log('isCorrect: levenshtein', {
        a,
        t,
        d,
        thresh,
        ok,
        ctx
    });
    return ok ? 'partial' : false;
}

function normalize(s) {
    return s
        .toLowerCase()
        .replace(/[^0-9a-z\uac00-\ud7a3\s]+/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function levenshtein(a, b) {
    if (a === b) return 0;
    const m = a.length,
        n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = Array.from({
        length: m + 1
    }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
        }
    }
    return dp[m][n];
}

function endQuizSession() {
    document.getElementById('quizArea').classList.add('hidden');
    document.getElementById('quizResultArea').classList.remove('hidden');

    const total = quizList.length;
    const earned = quizExactCnt + (quizPartialCnt * 0.5);
    const acc = total > 0 ? Math.round((earned / total) * 100) : 0;

    const emojiEl = document.getElementById('quizResultEmoji');
    if (acc >= 90) emojiEl.textContent = '🏅';
    else if (acc >= 70) emojiEl.textContent = '👍';
    else emojiEl.textContent = '📚';

    const scoreEl = document.getElementById('quizScoreText');
    scoreEl.textContent = `점수: ${acc}점 (정답 ${quizExactCnt}, 부분 ${quizPartialCnt} / ${total})`;

    const revBtn = document.getElementById('reviewWrongBtn');
    if (quizWrongItems.length > 0) {
        revBtn.classList.remove('hidden');
    } else {
        revBtn.classList.add('hidden');
    }

    renderQuizResultEffect(acc);
}

// ----------------------------------------------------
// UI Logic && Initial Start
// ----------------------------------------------------

// Result Area Actions
document.getElementById('retryUnknownBtn').addEventListener('click', () => {
    if (unknown.size === 0) return alert('모두 외우셨습니다!');
    const unkList = [];
    unknown.forEach(en => {
        const item = words.find(w => w.en === en);
        if (item) unkList.push(item);
    });
    currentList = shuffle(unkList);
    currentIndex = 0;
    known.clear();
    unknown.clear();
    document.getElementById('flashResultArea').classList.add('hidden');
    document.querySelector('.cardWrap').classList.remove('hidden');
    document.querySelector('.flashTopStats').classList.remove('hidden');
    showCard();
});

document.getElementById('retryAllFlashBtn').addEventListener('click', () => {
    document.getElementById('flashResultArea').classList.add('hidden');
    document.querySelector('.cardWrap').classList.remove('hidden');
    document.querySelector('.flashTopStats').classList.remove('hidden');
    startFlashcards();
});

document.getElementById('fromFlashToQuizBtn').addEventListener('click', () => {
    document.getElementById('flashResultArea').classList.add('hidden');
    document.querySelector('.cardWrap').classList.remove('hidden');
    document.querySelector('.flashTopStats').classList.remove('hidden');
    openSessionView('quiz');
});

document.getElementById('reviewWrongBtn').addEventListener('click', () => {
    if (quizWrongItems.length === 0) return;
    document.getElementById('quizResultArea').classList.add('hidden');
    // Switch to flashcard with wrong items only
    currentList = shuffle(quizWrongItems.slice());
    currentIndex = 0;
    known.clear();
    unknown.clear();
    // Force URL state just to keep it somewhat in sync
    const url = `${location.pathname}?mode=${encodeURIComponent(mode)}&start=flash`;
    window.history.pushState({
        mode,
        start: 'flash'
    }, '', url);

    const labelEl = document.getElementById('sessionLabel');
    if (labelEl) labelEl.textContent = modeLabel(mode) + ' · 오답 복습';
    showFlashArea();
    document.querySelector('.cardWrap').classList.remove('hidden');
    document.querySelector('.flashTopStats').classList.remove('hidden');
    showCard();
});

document.getElementById('retryAllQuizBtn').addEventListener('click', () => {
    document.getElementById('quizResultArea').classList.add('hidden');
    startQuiz();
});

document.getElementById('quizToHomeBtn').addEventListener('click', () => {
    document.getElementById('quizResultArea').classList.add('hidden');
    exitToHome();
});

window.addEventListener('popstate', (e) => {

    hideAllViews();

    if (!e.state || !e.state.start) {
        document.getElementById('homeScreen')
            .classList.remove('hidden');

        return;
    }

    mode = e.state.mode || 'ko2en';

    document.getElementById('sessionArea')
        .classList.remove('hidden');

    if (e.state.start === 'flash') {

        showFlashArea();

        if (!currentList.length) {
            startFlashcards();
        } else {
            showCard();
        }

    } else if (e.state.start === 'quiz') {

        document.getElementById('quizArea')
            .classList.remove('hidden');

        if (!quizList.length) {
            beginQuizSession();
        } else {
            showQuiz();
        }
    }
});
// Initialization is handled in DOMContentLoaded
