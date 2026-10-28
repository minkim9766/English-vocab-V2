'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const VOCAB_PATH = path.join(ROOT, 'vocab.json');
const RANKINGS_PATH = path.join(ROOT, 'rankings.json');
const ADMIN_AUTH_PATH = path.join(ROOT, 'admin-auth.json');
const ADMIN_AUDIT_PATH = path.join(ROOT, 'admin-audit.jsonl');
const TIME_LIMIT_SECONDS = 10;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const ADMIN_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const ADMIN_COOKIE = 'vocab_admin_session';
const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_LOGIN_MAX_ATTEMPTS = 8;
const adminSessions = new Map();
const loginAttempts = new Map();
let writeQueue = Promise.resolve();

function emptyVocabulary() {
  return Object.fromEntries(Array.from({ length: 13 }, (_, i) => [String(i + 1), []]));
}
async function ensureDataFiles() {
  try { await fs.access(VOCAB_PATH); }
  catch { await fs.writeFile(VOCAB_PATH, JSON.stringify(emptyVocabulary(), null, 2) + '\n', { flag: 'wx' }).catch(() => {}); }
  try { await fs.access(RANKINGS_PATH); }
  catch { await fs.writeFile(RANKINGS_PATH, '[]\n', { flag: 'wx' }).catch(() => {}); }
}
async function readVocabulary() {
  let parsed;
  try { parsed = JSON.parse(await fs.readFile(VOCAB_PATH, 'utf8')); }
  catch (error) { throw new Error(`vocab.json을 읽거나 해석할 수 없습니다: ${error.message}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('vocab.json 최상위 값은 객체여야 합니다.');
  for (let section = 1; section <= 13; section++) {
    if (parsed[String(section)] === undefined) parsed[String(section)] = [];
    if (!Array.isArray(parsed[String(section)])) throw new Error(`vocab.json의 "${section}" 값은 배열이어야 합니다.`);
  }
  return parsed;
}
function getVocabularyItems(data) {
  const items = [];
  for (let section = 1; section <= 13; section++) {
    const entries = data[String(section)] || [];
    entries.forEach((raw, itemIndex) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const word = typeof raw.word === 'string' ? raw.word.trim() : '';
      const meanings = Array.isArray(raw.meanings) ? raw.meanings.filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean) : [];
      if (!word && meanings.length === 0) return;
      items.push({ section: String(section), itemIndex, word: word || '___', meanings, raw });
    });
  }
  return items;
}
function normalizeAnswer(value) {
  let s = String(value ?? '').normalize('NFKC').toLocaleLowerCase('ko-KR');
  for (let i = 0; i < 5; i++) {
    const next = s.replace(/\([^()]*\)|（[^（）]*）/g, '');
    if (next === s) break;
    s = next;
  }
  return s.replace(/[~〜～∼‐‑‒–—―−﹘﹣－]/g, '-').replace(/[\s\u200B-\u200D\uFEFF]+/g, '').trim();
}
function round1(n) { return Math.round((Number(n) + Number.EPSILON) * 10) / 10; }
function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''; let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) { reject(Object.assign(new Error('요청 데이터가 너무 큽니다.'), { statusCode: 413 })); req.destroy(); return; }
      data += chunk.toString('utf8');
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch { reject(Object.assign(new Error('요청 본문이 올바른 JSON이 아닙니다.'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}
// Security headers are applied to every API and static response.
function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
}
function cleanDisplayText(value, maxLength) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
}
function isLoopbackAddress(address) {
  const ip = String(address || '').toLowerCase();
  return ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1' || ip.startsWith('127.');
}
function requestProtocol(req) {
  if (req.socket && req.socket.encrypted) return 'https:';
  if (process.env.TRUST_PROXY === '1' && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https') return 'https:';
  return 'http:';
}
function isSameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;
  try { return new URL(origin).origin === `${requestProtocol(req)}//${host}`; }
  catch { return false; }
}
function isLoopbackSetupRequest(req) {
  if (!isLoopbackAddress(req.socket && req.socket.remoteAddress) || !isSameOrigin(req)) return false;
  try {
    const hostName = new URL(`${requestProtocol(req)}//${req.headers.host}`).hostname.toLowerCase();
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostName);
  } catch { return false; }
}
function cookieValue(req, name) {
  const prefix = `${name}=`;
  for (const item of String(req.headers.cookie || '').split(';')) {
    const part = item.trim();
    if (part.startsWith(prefix)) { try { return decodeURIComponent(part.slice(prefix.length)); } catch { return ''; } }
  }
  return '';
}
function sessionKey(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function clearExpiredSessions() {
  const now = Date.now();
  for (const [key, session] of adminSessions) if (session.expiresAt <= now) adminSessions.delete(key);
}
function adminSessionForRequest(req) {
  clearExpiredSessions();
  const token = cookieValue(req, ADMIN_COOKIE);
  if (!token) return null;
  const key = sessionKey(token);
  const session = adminSessions.get(key);
  return session && session.expiresAt > Date.now() ? { key, ...session } : null;
}
function issueAdminSession(req, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrfToken = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  adminSessions.set(sessionKey(token), { csrfToken, expiresAt, createdAt: Date.now() });
  const secure = requestProtocol(req) === 'https:' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}${secure}`);
  return csrfToken;
}
function clearAdminCookie(req, res) {
  const secure = requestProtocol(req) === 'https:' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}
function scryptPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derivedKey) => error ? reject(error) : resolve(derivedKey));
  });
}
async function readAdminAuth() {
  try {
    const value = JSON.parse(await fs.readFile(ADMIN_AUTH_PATH, 'utf8'));
    if (value.version !== 1 || value.algorithm !== 'scrypt' || !/^[a-f0-9]{32,}$/.test(value.salt || '') || !/^[a-f0-9]{128}$/.test(value.hash || '')) throw new Error('관리자 인증 파일 형식이 올바르지 않습니다.');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function saveAdminAuth(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scryptPassword(password, Buffer.from(salt, 'hex'))).toString('hex');
  const data = { version: 1, algorithm: 'scrypt', salt, hash, createdAt: new Date().toISOString() };
  const temp = path.join(ROOT, `.admin-auth-${process.pid}-${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await fs.rename(temp, ADMIN_AUTH_PATH);
  try { await fs.chmod(ADMIN_AUTH_PATH, 0o600); } catch (_) { /* Windows ACLs control access instead of POSIX mode bits. */ }
}
async function passwordMatches(password, auth) {
  const digest = await scryptPassword(String(password), Buffer.from(auth.salt, 'hex'));
  const expected = Buffer.from(auth.hash, 'hex');
  return digest.length === expected.length && crypto.timingSafeEqual(digest, expected);
}
function loginRateState(req) {
  const key = String(req.socket && req.socket.remoteAddress || 'unknown');
  const now = Date.now();
  let state = loginAttempts.get(key);
  if (!state || now - state.windowStart > ADMIN_LOGIN_WINDOW_MS) {
    state = { windowStart: now, attempts: 0, blockedUntil: 0 };
    loginAttempts.set(key, state);
  }
  return { key, state, now };
}
async function writeJSONAtomic(filePath, value, prefix) {
  const temp = path.join(ROOT, `.${prefix}-${process.pid}-${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await fs.rename(temp, filePath);
}
async function auditAdmin(action, detail = {}) {
  const entry = { at: new Date().toISOString(), action, ...detail };
  await fs.appendFile(ADMIN_AUDIT_PATH, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
  try { await fs.chmod(ADMIN_AUDIT_PATH, 0o600); } catch (_) { /* Windows ACLs apply. */ }
}
function validateWordPayload(body) {
  const word = cleanDisplayText(body.word, 200);
  const meanings = Array.isArray(body.meanings) ? body.meanings.filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean).slice(0, 100) : [];
  const toStringArray = (value, label) => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new Error(`${label}는 문자열 배열이어야 합니다.`);
    return value.map(v => cleanDisplayText(v, 500)).filter(Boolean).slice(0, 100);
  };
  if (!word) throw new Error('표제어를 입력하세요.');
  if (!meanings.length) throw new Error('뜻을 하나 이상 입력하세요.');
  if (body.form !== undefined && typeof body.form !== 'string') throw new Error('품사/형태는 문자열이어야 합니다.');
  return {
    word,
    meanings,
    form: cleanDisplayText(body.form || '', 100),
    other: toStringArray(body.other, '기타 정보'),
    synonyms: toStringArray(body.synonyms, '유의어'),
    antonyms: toStringArray(body.antonyms, '반의어')
  };
}
function answerAlternatives(meanings) {
  return (Array.isArray(meanings) ? meanings : [])
    .flatMap(value => String(value ?? '').split(/[\/,，]/g))
    .map(value => value.trim())
    .filter(Boolean);
}

async function readRankings() {
  try {
    const data = JSON.parse(await fs.readFile(RANKINGS_PATH, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (error) {
    throw new Error(`rankings.json을 읽을 수 없습니다: ${error.message}`);
  }
}
async function writeRankingsAtomic(data) {
  const temp = path.join(ROOT, `.rankings-${process.pid}-${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fs.rename(temp, RANKINGS_PATH);
}
function withRankingLock(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.then(() => undefined, () => undefined);
  return run;
}
function sortedRankings(all, category) {
  const sorted = all.filter(r => r.category === category).sort((a, b) => b.score - a.score || String(a.createdAt).localeCompare(String(b.createdAt)));
  return sorted.map(record => ({ ...record, rank: 1 + sorted.filter(other => other.score > record.score).length }));
}
function publicRanking(record) {
  const { answers, ...summary } = record;
  return summary;
}
function categoryQuestionCount(category, vocabularyLength) {
  if (category === 'all') return vocabularyLength;
  return Math.min(Number(category), vocabularyLength);
}
function answerIsCorrect(entry, direction, answer, elapsedSeconds) {
  if (elapsedSeconds >= TIME_LIMIT_SECONDS) return false;
  const candidate = normalizeAnswer(answer);
  if (!candidate || candidate === normalizeAnswer('시간 초과') || candidate === normalizeAnswer('(미입력)')) return false;
  if (direction === 'ko2en') return candidate === normalizeAnswer(entry.word || '___');
  const meanings = entry.meanings.length ? entry.meanings : ['___'];
  return answerAlternatives(meanings).some(meaning => candidate === normalizeAnswer(meaning));
}

async function handleAdminAPI(req, res, url) {
  const pathname = url.pathname;
  if (req.method === 'GET' && pathname === '/api/admin/status') {
    try { return sendJSON(res, 200, { setupRequired: !(await readAdminAuth()) }); }
    catch { return sendJSON(res, 500, { error: '관리자 인증 정보를 읽을 수 없습니다.' }); }
  }

  if (req.method === 'POST' && pathname === '/api/admin/setup') {
    if (!isSameOrigin(req) || !isLoopbackSetupRequest(req)) return sendJSON(res, 403, { error: '초기 관리자 설정은 서버 컴퓨터의 localhost에서만 할 수 있습니다.' });
    let body;
    try { body = await readBody(req); } catch (error) { return sendJSON(res, error.statusCode || 400, { error: error.message }); }
    const password = String(body.password || '');
    if (password.length < 12 || password.length > 256) return sendJSON(res, 400, { error: '관리자 비밀번호는 12~256자로 설정하세요. 16자 이상의 긴 문구를 권장합니다.' });
    try {
      await withRankingLock(async () => {
        if (await readAdminAuth()) throw Object.assign(new Error('관리자 계정이 이미 설정되어 있습니다. 로그인하세요.'), { statusCode: 409 });
        await saveAdminAuth(password);
      });
      await auditAdmin('setup');
      const csrfToken = issueAdminSession(req, res);
      return sendJSON(res, 201, { authenticated: true, csrfToken });
    } catch (error) {
      return sendJSON(res, error.statusCode || 500, { error: error.statusCode === 409 ? error.message : `초기 설정을 완료하지 못했습니다: ${error.message}` });
    }
  }

  if (req.method === 'POST' && pathname === '/api/admin/login') {
    if (!isSameOrigin(req)) return sendJSON(res, 403, { error: '요청 출처를 확인할 수 없습니다.' });
    const rate = loginRateState(req);
    if (rate.state.blockedUntil > rate.now) {
      res.setHeader('Retry-After', String(Math.ceil((rate.state.blockedUntil - rate.now) / 1000)));
      return sendJSON(res, 429, { error: '로그인 시도가 제한되었습니다. 잠시 후 다시 시도하세요.' });
    }
    let body;
    try { body = await readBody(req); } catch (error) { return sendJSON(res, error.statusCode || 400, { error: error.message }); }
    try {
      const auth = await readAdminAuth();
      const password = String(body.password || '');
      const valid = auth && password.length <= 256 && await passwordMatches(password, auth);
      if (!valid) {
        rate.state.attempts += 1;
        if (rate.state.attempts >= ADMIN_LOGIN_MAX_ATTEMPTS) rate.state.blockedUntil = Date.now() + ADMIN_LOGIN_WINDOW_MS;
        await new Promise(resolve => setTimeout(resolve, 250));
        return sendJSON(res, rate.state.blockedUntil ? 429 : 401, { error: rate.state.blockedUntil ? '로그인 시도가 제한되었습니다. 15분 후 다시 시도하세요.' : '비밀번호가 올바르지 않습니다.' });
      }
      loginAttempts.delete(rate.key);
      const csrfToken = issueAdminSession(req, res);
      return sendJSON(res, 200, { authenticated: true, csrfToken });
    } catch (error) { return sendJSON(res, 500, { error: '로그인 처리 중 오류가 발생했습니다.' }); }
  }

  if (req.method === 'GET' && pathname === '/api/admin/session') {
    const session = adminSessionForRequest(req);
    if (!session) return sendJSON(res, 401, { error: '관리자 로그인이 필요합니다.' });
    return sendJSON(res, 200, { authenticated: true, csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() });
  }

  const session = adminSessionForRequest(req);
  if (!session) return sendJSON(res, 401, { error: '관리자 로그인이 필요합니다.' });

  if (!isSameOrigin(req) && !['GET', 'HEAD'].includes(req.method)) return sendJSON(res, 403, { error: '요청 출처를 확인할 수 없습니다.' });
  if (!['GET', 'HEAD'].includes(req.method)) {
    const submittedCsrf = String(req.headers['x-admin-csrf'] || '');
    const submittedCsrfBytes = Buffer.from(submittedCsrf, 'utf8');
    const expectedCsrfBytes = Buffer.from(session.csrfToken, 'utf8');
    if (!submittedCsrf || submittedCsrfBytes.length !== expectedCsrfBytes.length || !crypto.timingSafeEqual(submittedCsrfBytes, expectedCsrfBytes)) {
      return sendJSON(res, 403, { error: '보안 토큰이 만료되었거나 올바르지 않습니다. 다시 로그인하세요.' });
    }
  }

  if (req.method === 'POST' && pathname === '/api/admin/logout') {
    adminSessions.delete(session.key);
    clearAdminCookie(req, res);
    return sendJSON(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/admin/password') {
    let body;
    try { body = await readBody(req); } catch (error) { return sendJSON(res, error.statusCode || 400, { error: error.message }); }
    const currentPassword = String(body.currentPassword || '');
    const newPassword = String(body.newPassword || '');
    if (newPassword.length < 12 || newPassword.length > 256) return sendJSON(res, 400, { error: '새 비밀번호는 12~256자로 설정하세요.' });
    try {
      const auth = await readAdminAuth();
      if (!auth || !(await passwordMatches(currentPassword, auth))) return sendJSON(res, 401, { error: '현재 비밀번호가 올바르지 않습니다.' });
      if (currentPassword === newPassword) return sendJSON(res, 400, { error: '현재 비밀번호와 다른 비밀번호를 사용하세요.' });
      await saveAdminAuth(newPassword);
      await auditAdmin('password-change');
      adminSessions.clear();
      clearAdminCookie(req, res);
      return sendJSON(res, 200, { ok: true, loginRequired: true });
    } catch (error) { return sendJSON(res, 500, { error: '비밀번호를 변경하지 못했습니다.' }); }
  }

  if (req.method === 'GET' && pathname === '/api/admin/vocabulary') {
    try { return sendJSON(res, 200, await readVocabulary()); }
    catch (error) { return sendJSON(res, 500, { error: error.message }); }
  }

  const vocabItemMatch = pathname.match(/^\/api\/admin\/vocabulary\/(\d+)\/(\d+)$/);
  const vocabSectionMatch = pathname.match(/^\/api\/admin\/vocabulary\/(\d+)$/);
  if ((req.method === 'PUT' || req.method === 'DELETE') && vocabItemMatch) {
    const section = Number(vocabItemMatch[1]);
    const itemIndex = Number(vocabItemMatch[2]);
    if (section < 1 || section > 13 || !Number.isInteger(itemIndex) || itemIndex < 0) return sendJSON(res, 400, { error: '강 또는 단어 번호가 올바르지 않습니다.' });
    try {
      let result;
      await withRankingLock(async () => {
        const vocab = await readVocabulary();
        if (!Array.isArray(vocab[String(section)]) || itemIndex >= vocab[String(section)].length) throw Object.assign(new Error('단어 항목을 찾을 수 없습니다.'), { statusCode: 404 });
        if (req.method === 'DELETE') {
          vocab[String(section)].splice(itemIndex, 1);
          result = { ok: true, deleted: true };
          await writeJSONAtomic(VOCAB_PATH, vocab, 'vocab');
          await auditAdmin('vocab-delete', { section, itemIndex });
        } else {
          const body = await readBody(req);
          const clean = validateWordPayload(body);
          const old = vocab[String(section)][itemIndex];
          vocab[String(section)][itemIndex] = { ...old, ...clean };
          await writeJSONAtomic(VOCAB_PATH, vocab, 'vocab');
          result = { ok: true, section, itemIndex, word: clean.word };
          await auditAdmin('vocab-update', { section, itemIndex, word: clean.word });
        }
      });
      return sendJSON(res, 200, result);
    } catch (error) { return sendJSON(res, error.statusCode || 400, { error: error.message }); }
  }

  if (req.method === 'POST' && vocabSectionMatch) {
    const section = Number(vocabSectionMatch[1]);
    if (section < 1 || section > 13) return sendJSON(res, 400, { error: '강은 1~13 사이여야 합니다.' });
    let body;
    try { body = await readBody(req); } catch (error) { return sendJSON(res, error.statusCode || 400, { error: error.message }); }
    let result;
    try {
      const clean = validateWordPayload(body);
      await withRankingLock(async () => {
        const vocab = await readVocabulary();
        if (!Array.isArray(vocab[String(section)])) vocab[String(section)] = [];
        const itemIndex = vocab[String(section)].length;
        vocab[String(section)].push(clean);
        await writeJSONAtomic(VOCAB_PATH, vocab, 'vocab');
        result = { ok: true, section, itemIndex, word: clean.word };
        await auditAdmin('vocab-create', { section, itemIndex, word: clean.word });
      });
      return sendJSON(res, 201, result);
    } catch (error) { return sendJSON(res, 400, { error: error.message }); }
  }

  if (req.method === 'GET' && pathname === '/api/admin/rankings') {
    const category = url.searchParams.get('category') || '100';
    if (category !== 'all' && !['25', '50', '100', '200'].includes(category)) return sendJSON(res, 400, { error: '랭킹 범위가 올바르지 않습니다.' });
    try {
      const all = await readRankings();
      const ranked = sortedRankings(all, category);
      const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit')) || 500));
      return sendJSON(res, 200, { category, total: ranked.length, rankings: ranked.slice(0, limit).map(publicRanking) });
    } catch (error) { return sendJSON(res, 500, { error: error.message }); }
  }

  if (req.method === 'POST' && pathname === '/api/admin/rankings/perfect') {
    let body;
    try { body = await readBody(req); } catch (error) { return sendJSON(res, error.statusCode || 400, { error: error.message }); }
    const name = cleanDisplayText(body.name, 30);
    const category = String(body.category || '');
    const direction = body.direction === 'ko2en' ? 'ko2en' : 'en2ko';
    if (!name) return sendJSON(res, 400, { error: '랭킹에 표시할 이름을 입력하세요.' });
    if (!['25', '50', '100', '200', 'all'].includes(category)) return sendJSON(res, 400, { error: '랭킹 범위가 올바르지 않습니다.' });
    try {
      const vocab = await readVocabulary();
      const items = getVocabularyItems(vocab);
      if (category !== 'all' && items.length < Number(category)) return sendJSON(res, 400, { error: `${category}개 랭킹을 만들려면 단어가 최소 ${category}개 필요합니다.` });
      const count = categoryQuestionCount(category, items.length);
      if (count < 1) return sendJSON(res, 400, { error: '단어 자료가 없어 랭킹을 만들 수 없습니다.' });
      const shuffled = items.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const selected = shuffled.slice(0, count);
      const answers = selected.map((entry, index) => {
        const meanings = entry.meanings.length ? entry.meanings : ['___'];
        const prompt = direction === 'en2ko' ? entry.word : meanings.join(' / ');
        const target = direction === 'en2ko' ? meanings.join(' / ') : entry.word;
        const answer = direction === 'en2ko' ? (answerAlternatives(meanings)[0] || '___') : (entry.word || '___');
        return { number: index + 1, section: entry.section, itemIndex: entry.itemIndex, word: entry.word, prompt, direction, answer, target, correct: true, timedOut: false, elapsedSeconds: 0, remainingSeconds: 10 };
      });
      const questionCount = answers.length;
      const record = {
        id: crypto.randomUUID(), name, category, score: round1(questionCount * 11), correctCount: questionCount,
        timeBonus: round1(questionCount * 10), totalTime: 0, questionCount, answers,
        createdAt: new Date().toISOString(), adminCreated: true
      };
      await withRankingLock(async () => { const all = await readRankings(); all.push(record); await writeRankingsAtomic(all); });
      await auditAdmin('ranking-perfect-create', { id: record.id, category, name, score: record.score });
      const all = await readRankings();
      const ranked = sortedRankings(all, category).find(r => r.id === record.id);
      return sendJSON(res, 201, { ...publicRanking(record), rank: ranked ? ranked.rank : 1 });
    } catch (error) { return sendJSON(res, 500, { error: error.message }); }
  }

  const rankingMatch = pathname.match(/^\/api\/admin\/rankings\/([0-9a-f-]{36})$/i);
  if (rankingMatch && req.method === 'GET') {
    try {
      const all = await readRankings();
      const record = all.find(r => r.id === rankingMatch[1]);
      if (!record) return sendJSON(res, 404, { error: '랭킹 기록을 찾을 수 없습니다.' });
      const rank = sortedRankings(all, record.category).find(r => r.id === record.id)?.rank || 1;
      return sendJSON(res, 200, { ...record, rank });
    } catch (error) { return sendJSON(res, 500, { error: error.message }); }
  }

  if (rankingMatch && req.method === 'PUT') {
    let body;
    try { body = await readBody(req); } catch (error) { return sendJSON(res, error.statusCode || 400, { error: error.message }); }
    const id = rankingMatch[1];
    try {
      let updated;
      await withRankingLock(async () => {
        const all = await readRankings();
        const position = all.findIndex(r => r.id === id);
        if (position < 0) throw Object.assign(new Error('랭킹 기록을 찾을 수 없습니다.'), { statusCode: 404 });
        const old = all[position];
        const name = cleanDisplayText(body.name === undefined ? old.name : body.name, 30);
        if (!name) throw Object.assign(new Error('이름을 입력하세요.'), { statusCode: 400 });
        let answers = old.answers || [];
        if (body.answers !== undefined) {
          if (!Array.isArray(body.answers) || body.answers.length !== answers.length) throw Object.assign(new Error('문제별 답안 목록의 개수가 기존 기록과 일치하지 않습니다.'), { statusCode: 400 });
          answers = answers.map((original, index) => {
            const editable = body.answers[index] || {};
            const elapsed = Number(editable.elapsedSeconds ?? original.elapsedSeconds ?? 0);
            const remaining = Number(editable.remainingSeconds ?? original.remainingSeconds ?? 0);
            if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > TIME_LIMIT_SECONDS || !Number.isFinite(remaining) || remaining < 0 || remaining > TIME_LIMIT_SECONDS) throw Object.assign(new Error(`${index + 1}번 문제의 시간이 올바르지 않습니다.`), { statusCode: 400 });
            return {
              ...original,
              answer: String(editable.answer ?? original.answer ?? '').slice(0, 500),
              correct: typeof editable.correct === 'boolean' ? editable.correct : Boolean(original.correct),
              elapsedSeconds: round1(elapsed), remainingSeconds: round1(remaining),
              timedOut: elapsed >= TIME_LIMIT_SECONDS && !(typeof editable.correct === 'boolean' ? editable.correct : Boolean(original.correct))
            };
          });
        }
        const questionCount = Number(old.questionCount) || answers.length;
        const derivedCorrect = answers.filter(a => a.correct).length;
        const derivedTimeBonus = round1(answers.reduce((sum, a) => sum + (a.correct ? Number(a.remainingSeconds || 0) : 0), 0));
        const derivedTotalTime = round1(answers.reduce((sum, a) => sum + Number(a.elapsedSeconds || 0), 0));
        const score = body.score === undefined ? round1(derivedCorrect + derivedTimeBonus) : Number(body.score);
        if (!Number.isFinite(score) || score < 0 || score > 10000000) throw Object.assign(new Error('점수는 0~10,000,000 사이의 숫자여야 합니다.'), { statusCode: 400 });
        updated = {
          ...old, name, score: round1(score), answers,
          correctCount: derivedCorrect, timeBonus: derivedTimeBonus, totalTime: derivedTotalTime,
          questionCount, adminEditedAt: new Date().toISOString()
        };
        all[position] = updated;
        await writeRankingsAtomic(all);
      });
      await auditAdmin('ranking-update', { id, name: updated.name, score: updated.score, answerCount: updated.answers.length });
      const all = await readRankings();
      const rank = sortedRankings(all, updated.category).find(r => r.id === id)?.rank || 1;
      return sendJSON(res, 200, { ...updated, rank });
    } catch (error) { return sendJSON(res, error.statusCode || 400, { error: error.message }); }
  }

  if (rankingMatch && req.method === 'DELETE') {
    try {
      let removed = false;
      await withRankingLock(async () => {
        const all = await readRankings();
        const filtered = all.filter(r => r.id !== rankingMatch[1]);
        if (filtered.length === all.length) throw Object.assign(new Error('랭킹 기록을 찾을 수 없습니다.'), { statusCode: 404 });
        await writeRankingsAtomic(filtered);
        removed = true;
      });
      if (removed) await auditAdmin('ranking-delete', { id: rankingMatch[1] });
      return sendJSON(res, 200, { ok: true, deleted: true });
    } catch (error) { return sendJSON(res, error.statusCode || 500, { error: error.message }); }
  }

  return sendJSON(res, 404, { error: '관리자 API 경로를 찾을 수 없습니다.' });
}

async function handleAPI(req, res, url) {
  if (url.pathname.startsWith('/api/admin/')) return handleAdminAPI(req, res, url);
  if (req.method === 'GET' && url.pathname === '/api/vocab') {
    try { return sendJSON(res, 200, await readVocabulary()); }
    catch (error) { return sendJSON(res, 500, { error: error.message }); }
  }

  if (req.method === 'GET' && url.pathname === '/api/rankings') {
    const category = url.searchParams.get('category') || '100';
    if (!['25', '50', '100', '200', 'all'].includes(category)) return sendJSON(res, 400, { error: 'category는 25, 50, 100, 200 또는 all이어야 합니다.' });
    try {
      const all = await readRankings();
      const ranked = sortedRankings(all, category);
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100));
      return sendJSON(res, 200, { category, total: ranked.length, rankings: ranked.slice(0, limit).map(publicRanking) });
    } catch (error) { return sendJSON(res, 500, { error: error.message }); }
  }

  if (req.method === 'POST' && url.pathname === '/api/rankings') {
    let body;
    try { body = await readBody(req); }
    catch (error) { return sendJSON(res, error.statusCode || 400, { error: error.message }); }
    try {
      const name = String(body.name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 30);
      const category = String(body.category || '');
      if (!name) return sendJSON(res, 400, { error: '랭킹에 표시할 이름을 입력하세요.' });
      if (body.mode !== 'random') return sendJSON(res, 400, { error: '랜덤 퀴즈만 랭킹 등록이 가능합니다.' });
      if (!['25', '50', '100', '200', 'all'].includes(category)) return sendJSON(res, 400, { error: '25개, 50개, 100개, 200개 또는 전부 퀴즈만 등록할 수 있습니다.' });
      if (!Array.isArray(body.answers) || body.answers.length === 0 || body.answers.length > 5000) return sendJSON(res, 400, { error: '문제별 답안 기록이 올바르지 않습니다.' });

      const vocab = await readVocabulary();
      const items = getVocabularyItems(vocab);
      if (category !== 'all' && items.length < Number(category)) return sendJSON(res, 400, { error: `${category}개 랭킹을 등록하려면 vocab.json에 최소 ${category}개 단어가 있어야 합니다.` });
      const expectedCount = categoryQuestionCount(category, items.length);
      if (body.answers.length !== expectedCount) return sendJSON(res, 400, { error: `랭킹 등록에는 ${category === 'all' ? '전체' : category + '개'} 단어를 모두 푼 기록이 필요합니다. 현재 기록은 ${body.answers.length}문항입니다.` });

      const itemMap = new Map(items.map(item => [`${item.section}:${item.itemIndex}`, item]));
      const seen = new Set();
      const answers = [];
      for (let i = 0; i < body.answers.length; i++) {
        const submitted = body.answers[i] || {};
        const section = String(submitted.section || '');
        const itemIndex = Number(submitted.itemIndex);
        const key = `${section}:${itemIndex}`;
        const entry = itemMap.get(key);
        if (!entry) return sendJSON(res, 400, { error: `${i + 1}번 문제의 단어 항목이 vocab.json에서 확인되지 않습니다.` });
        if (seen.has(key)) return sendJSON(res, 400, { error: '중복된 단어 항목이 포함되어 있습니다.' });
        seen.add(key);
        if (String(submitted.word || '') !== entry.word) return sendJSON(res, 400, { error: `${i + 1}번 문제의 표제어 정보가 현재 vocab.json과 일치하지 않습니다.` });
        const direction = submitted.direction;
        if (!['en2ko','ko2en'].includes(direction)) return sendJSON(res, 400, { error: `${i + 1}번 문제의 퀴즈 방향이 올바르지 않습니다.` });
        const parsedElapsed = Number(submitted.elapsedSeconds);
        if (!Number.isFinite(parsedElapsed) || parsedElapsed < 0 || parsedElapsed > TIME_LIMIT_SECONDS) return sendJSON(res, 400, { error: `${i + 1}번 문제의 풀이 시간이 올바르지 않습니다.` });
        const elapsedSeconds = round1(parsedElapsed);
        const answer = String(submitted.answer ?? '').slice(0, 500);
        const prompt = String(submitted.prompt ?? '').slice(0, 2000);
        const correct = answerIsCorrect(entry, direction, answer, elapsedSeconds);
        const remainingSeconds = correct ? round1(Math.max(0, TIME_LIMIT_SECONDS - elapsedSeconds)) : 0;
        const target = direction === 'en2ko' ? (entry.meanings.length ? entry.meanings : ['___']).join(' / ') : entry.word;
        answers.push({
          number: i + 1, section, itemIndex, word: entry.word, prompt, direction, answer,
          target, correct, timedOut: elapsedSeconds >= TIME_LIMIT_SECONDS && !correct,
          elapsedSeconds, remainingSeconds
        });
      }
      // Every eligible entry must appear; it is not sufficient to submit the right number of arbitrary items.
      if (seen.size !== expectedCount) return sendJSON(res, 400, { error: '전체 문제 중 일부 항목이 누락되어 랭킹을 등록할 수 없습니다.' });

      const correctCount = answers.filter(a => a.correct).length;
      const timeBonus = round1(answers.reduce((sum, a) => sum + (a.correct ? a.remainingSeconds : 0), 0));
      const score = round1(correctCount + timeBonus);
      const totalTime = round1(answers.reduce((sum, a) => sum + a.elapsedSeconds, 0));
      const record = {
        id: crypto.randomUUID(), name, category, score, correctCount, timeBonus, totalTime,
        questionCount: answers.length, answers, createdAt: new Date().toISOString()
      };
      const saved = await withRankingLock(async () => {
        const all = await readRankings(); all.push(record); await writeRankingsAtomic(all);
        const ranking = sortedRankings(all, category);
        const current = ranking.find(x => x.id === record.id);
        return { ...publicRanking(record), rank: current.rank, topTen: current.rank <= 10 };
      });
      return sendJSON(res, 201, saved);
    } catch (error) { return sendJSON(res, 500, { error: error.message }); }
  }

  const match = url.pathname.match(/^\/api\/rankings\/([0-9a-f-]{36})$/i);
  if (req.method === 'GET' && match) {
    try {
      const id = match[1]; const all = await readRankings(); const record = all.find(r => r.id === id);
      if (!record) return sendJSON(res, 404, { error: '랭킹 기록을 찾을 수 없습니다.' });
      const ranked = sortedRankings(all, record.category); const rankInfo = ranked.find(r => r.id === id);
      return sendJSON(res, 200, { ...record, rank: rankInfo.rank });
    } catch (error) { return sendJSON(res, 500, { error: error.message }); }
  }
  return sendJSON(res, 404, { error: 'API 경로를 찾을 수 없습니다.' });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon'
};
async function handleStatic(req, res, url) {
  if (!['GET','HEAD'].includes(req.method)) { setSecurityHeaders(res); res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end('Method Not Allowed'); }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { setSecurityHeaders(res); res.writeHead(400); return res.end('Bad Request'); }
  if (pathname === '/') pathname = '/index.html';
  if (!pathname.startsWith('/') || pathname.slice(1).includes('/')) { setSecurityHeaders(res); res.writeHead(404); return res.end('Not Found'); }
  const fileName = pathname.slice(1);
  const publicFiles = new Set(['index.html', 'style.css', 'script.js', 'admin.html', 'admin.css', 'admin.js', 'vocab.json', 'favicon.ico']);
  if (!publicFiles.has(fileName)) { setSecurityHeaders(res); res.writeHead(404); return res.end('Not Found'); }
  const filePath = path.join(ROOT, fileName);
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('not file');
    const content = await fs.readFile(filePath);
    setSecurityHeaders(res);
    const cache = fileName === 'vocab.json' || fileName.startsWith('admin.') ? 'no-store' : 'no-cache';
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': cache });
    if (req.method === 'HEAD') return res.end();
    return res.end(content);
  } catch { setSecurityHeaders(res); res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not Found'); }
}

async function main() {
  await ensureDataFiles();
  const server = http.createServer(async (req, res) => {
    setSecurityHeaders(res);
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { return sendJSON(res, 400, { error: '요청 경로가 올바르지 않습니다.' }); }
    if (url.pathname.startsWith('/api/')) return handleAPI(req, res, url);
    return handleStatic(req, res, url);
  });
  server.listen(PORT, HOST, () => {
    console.log(`영단어 암기 도우미 V3 실행: http://localhost:${PORT}`);
    console.log(`단어 자료: ${VOCAB_PATH}`);
    console.log(`랭킹 기록: ${RANKINGS_PATH}`);
    console.log(`관리자 설정: http://localhost:${PORT}/admin.html (최초 설정은 localhost에서만 가능)`);
    console.log(`접속 바인딩: ${HOST} (외부 접속이 필요하면 HOST 환경 변수를 명시적으로 설정하세요)`);
    console.log('중지하려면 Ctrl+C를 누르세요.');
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
