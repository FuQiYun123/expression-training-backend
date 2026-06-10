const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, '..', '.env.local'));
loadEnvFile(path.join(__dirname, '.env.local'));

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = path.join(__dirname, 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'practice-media';
const HAS_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '';
const phoneLoginCodes = new Map();

function ensureDataDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

function defaultData() {
  return {
    checkins: [],
    records: [],
    favorites: [],
    contents: []
  };
}

function defaultDb() {
  return {
    users: {},
    sync: {},
    media: {}
  };
}

function readDb() {
  ensureDataDirs();
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultDb(), null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function writeDb(db) {
  ensureDataDirs();
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function userIdFrom(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function mediaIdFrom(value) {
  return crypto.createHash('sha256').update(`${Date.now()}:${value}:${crypto.randomUUID()}`).digest('hex').slice(0, 32);
}

function createPhoneLoginCode(phone) {
  const code = String(crypto.randomInt(100000, 1000000));
  const expiresAt = Date.now() + 10 * 60 * 1000;
  phoneLoginCodes.set(phone, { code, expiresAt });
  return { code, expiresAt };
}

function verifyPhoneLoginCode(phone, code) {
  const entry = phoneLoginCodes.get(phone);
  if (!entry || entry.expiresAt < Date.now() || entry.code !== String(code || '').trim()) {
    return false;
  }
  phoneLoginCodes.delete(phone);
  return true;
}

function normalizeSmsPhone(phone) {
  if (/^1\d{10}$/.test(phone)) return `+86${phone}`;
  return phone;
}

function sendTwilioSms(phone, code) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    return Promise.reject(new Error('SMS provider is not configured'));
  }
  const body = new URLSearchParams({
    To: normalizeSmsPhone(phone),
    From: TWILIO_FROM_NUMBER,
    Body: `您的表达训练验证码是 ${code}，10 分钟内有效。`
  }).toString();
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const options = {
    hostname: 'api.twilio.com',
    path: `/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Messages.json`,
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    }
  };
  return new Promise((resolve, reject) => {
    const request = https.request(options, (response) => {
      let data = '';
      response.on('data', (chunk) => {
        data += chunk;
      });
      response.on('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(data);
          return;
        }
        reject(new Error(`SMS provider failed: ${response.statusCode} ${data}`));
      });
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

async function sendPhoneLoginCode(phone, code) {
  await sendTwilioSms(phone, code);
}

function newestValue(item) {
  return (item && (item.updatedAt || item.favoriteAt || item.createdAt)) || 0;
}

function mergeById(a = [], b = []) {
  const map = new Map();
  [...a, ...b].forEach((item) => {
    if (!item || !item.id) return;
    const old = map.get(item.id);
    if (!old || newestValue(item) >= newestValue(old)) {
      map.set(item.id, item);
    }
  });
  return [...map.values()].sort((left, right) => newestValue(right) - newestValue(left));
}

function mergeData(remoteData, incomingData) {
  const remote = remoteData || defaultData();
  const incoming = incomingData || defaultData();
  return {
    checkins: [...new Set([...(remote.checkins || []), ...(incoming.checkins || [])])].sort(),
    records: mergeById(remote.records, incoming.records),
    favorites: mergeById(remote.favorites, incoming.favorites),
    contents: mergeById(remote.contents, incoming.contents)
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type'
  });
  res.end(JSON.stringify(body));
}

function sendBinary(res, status, mimeType, buffer) {
  res.writeHead(status, {
    'content-type': mimeType || 'application/octet-stream',
    'content-length': buffer.length,
    'access-control-allow-origin': '*',
    'cache-control': 'private, max-age=3600'
  });
  res.end(buffer);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 120 * 1024 * 1024) {
        req.destroy(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function parseDataUrl(dataUrl = '') {
  const match = String(dataUrl).match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) return null;
  const mimeType = match[1] || 'application/octet-stream';
  const encoded = match[3] || '';
  const buffer = match[2]
    ? Buffer.from(encoded, 'base64')
    : Buffer.from(decodeURIComponent(encoded), 'utf8');
  return { buffer, mimeType };
}

function extensionFromMime(mimeType = '') {
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('mpeg')) return 'mp3';
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('m4a')) return 'm4a';
  return 'bin';
}

function mediaUrlFor(req, id) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`;
  return `${proto}://${host}/api/media/file?id=${encodeURIComponent(id)}`;
}

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra
  };
}

async function supabaseRequest(pathname, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${pathname}`, {
    ...options,
    headers: supabaseHeaders(options.headers || {})
  });
  const text = await response.text();
  const result = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(result?.message || result?.error || `Supabase request failed: ${response.status}`);
  }
  return result;
}

async function selectOne(table, filter) {
  const rows = await supabaseRequest(`/rest/v1/${table}?select=*&${filter}&limit=1`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function upsertRows(table, rows, conflict = 'id') {
  return supabaseRequest(`/rest/v1/${table}?on_conflict=${encodeURIComponent(conflict)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      prefer: 'resolution=merge-duplicates,return=representation'
    },
    body: JSON.stringify(rows)
  });
}

async function deleteRows(table, filter) {
  return supabaseRequest(`/rest/v1/${table}?${filter}`, {
    method: 'DELETE',
    headers: {
      prefer: 'return=minimal'
    }
  });
}

function localSaveUserData(db, userId, incomingData) {
  const oldSync = db.sync[userId] || { data: defaultData() };
  const data = mergeData(oldSync.data, incomingData);
  db.sync[userId] = {
    data,
    updatedAt: Date.now()
  };
  return data;
}

async function cloudSaveUserData(userId, incomingData) {
  const oldSync = await selectOne('user_sync', `user_id=eq.${encodeURIComponent(userId)}`);
  const data = mergeData(oldSync?.data, incomingData);
  const updatedAt = Date.now();
  await upsertRows('user_sync', [{
    user_id: userId,
    data,
    updated_at: updatedAt
  }], 'user_id');
  return { data, updatedAt };
}

async function localAuthPhone(body) {
  const db = readDb();
  const id = userIdFrom(`phone:${body.phone}`);
  db.users[id] = db.users[id] || {
    id,
    type: 'phone',
    phone: body.phone,
    name: '表达练习者',
    createdAt: Date.now()
  };
  db.users[id].lastLoginAt = Date.now();
  const data = localSaveUserData(db, id, body.data);
  writeDb(db);
  return { user: db.users[id], data };
}

async function cloudAuthPhone(body) {
  const id = userIdFrom(`phone:${body.phone}`);
  const now = Date.now();
  const user = {
    id,
    type: 'phone',
    phone: body.phone,
    name: '表达练习者',
    created_at: now,
    last_login_at: now
  };
  const oldUser = await selectOne('users', `id=eq.${encodeURIComponent(id)}`);
  const [savedUser] = await upsertRows('users', [{
    ...user,
    created_at: oldUser?.created_at || now
  }]);
  const savedSync = await cloudSaveUserData(id, body.data);
  return {
    user: {
      id: savedUser.id,
      type: savedUser.type,
      phone: savedUser.phone,
      name: savedUser.name,
      createdAt: savedUser.created_at,
      lastLoginAt: savedUser.last_login_at
    },
    data: savedSync.data
  };
}

async function localAuthWechat(body) {
  const db = readDb();
  const id = userIdFrom(`wechat:${body.code || 'demo'}`);
  db.users[id] = db.users[id] || {
    id,
    type: 'wechat',
    name: '微信用户',
    createdAt: Date.now()
  };
  db.users[id].lastLoginAt = Date.now();
  const data = localSaveUserData(db, id, body.data);
  writeDb(db);
  return { user: db.users[id], data };
}

async function cloudAuthWechat(body) {
  const id = userIdFrom(`wechat:${body.code || 'demo'}`);
  const now = Date.now();
  const oldUser = await selectOne('users', `id=eq.${encodeURIComponent(id)}`);
  const [savedUser] = await upsertRows('users', [{
    id,
    type: 'wechat',
    phone: null,
    name: '微信用户',
    created_at: oldUser?.created_at || now,
    last_login_at: now
  }]);
  const savedSync = await cloudSaveUserData(id, body.data);
  return {
    user: {
      id: savedUser.id,
      type: savedUser.type,
      name: savedUser.name,
      createdAt: savedUser.created_at,
      lastLoginAt: savedUser.last_login_at
    },
    data: savedSync.data
  };
}

async function localPushSync(body) {
  const db = readDb();
  const data = localSaveUserData(db, body.userId, body.data);
  writeDb(db);
  return { ok: true, data, updatedAt: db.sync[body.userId].updatedAt };
}

async function cloudPushSync(body) {
  const saved = await cloudSaveUserData(body.userId, body.data);
  return { ok: true, data: saved.data, updatedAt: saved.updatedAt };
}

async function localPullSync(userId) {
  const db = readDb();
  return db.sync[userId] || { data: null };
}

async function cloudPullSync(userId) {
  const row = await selectOne('user_sync', `user_id=eq.${encodeURIComponent(userId)}`);
  return row ? { data: row.data, updatedAt: row.updated_at } : { data: null };
}

async function localUploadMedia(req, body) {
  const parsed = parseDataUrl(body.mediaData);
  if (!parsed || !parsed.buffer.length) throw new Error('Missing media data');
  const id = mediaIdFrom(body.userId || 'local');
  const ext = extensionFromMime(parsed.mimeType);
  const fileName = `${id}.${ext}`;
  const filePath = path.join(MEDIA_DIR, fileName);
  fs.writeFileSync(filePath, parsed.buffer);
  const db = readDb();
  db.media[id] = {
    id,
    userId: body.userId,
    kind: body.kind || 'media',
    path: filePath,
    mimeType: parsed.mimeType,
    createdAt: Date.now()
  };
  writeDb(db);
  return {
    ok: true,
    mediaId: id,
    mediaUrl: mediaUrlFor(req, id),
    mimeType: parsed.mimeType
  };
}

async function cloudUploadMedia(req, body) {
  const parsed = parseDataUrl(body.mediaData);
  if (!parsed || !parsed.buffer.length) throw new Error('Missing media data');
  if (!body.userId) throw new Error('Missing userId');
  const id = mediaIdFrom(body.userId);
  const ext = extensionFromMime(parsed.mimeType);
  const safeKind = String(body.kind || 'media').replace(/[^a-z0-9_-]/gi, '');
  const objectPath = `${body.userId}/${safeKind}/${id}.${ext}`;
  const uploadResponse = await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_STORAGE_BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: supabaseHeaders({
      'content-type': parsed.mimeType,
      'x-upsert': 'true'
    }),
    body: parsed.buffer
  });
  const uploadResult = await uploadResponse.json().catch(() => ({}));
  if (!uploadResponse.ok) {
    throw new Error(uploadResult.message || uploadResult.error || 'Supabase media upload failed');
  }
  await upsertRows('media_files', [{
    id,
    user_id: body.userId,
    kind: safeKind,
    storage_path: objectPath,
    mime_type: parsed.mimeType,
    created_at: Date.now()
  }]);
  return {
    ok: true,
    mediaId: id,
    mediaUrl: mediaUrlFor(req, id),
    mimeType: parsed.mimeType
  };
}

async function localReadMedia(id) {
  const db = readDb();
  const media = db.media[id];
  if (!media || !media.path || !fs.existsSync(media.path)) return null;
  return {
    buffer: fs.readFileSync(media.path),
    mimeType: media.mimeType || 'application/octet-stream'
  };
}

async function cloudReadMedia(id) {
  const media = await selectOne('media_files', `id=eq.${encodeURIComponent(id)}`);
  if (!media) return null;
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_STORAGE_BUCKET}/${media.storage_path}`, {
    headers: supabaseHeaders()
  });
  if (!response.ok) return null;
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    mimeType: media.mime_type || 'application/octet-stream'
  };
}

async function localDeleteMedia(id) {
  const db = readDb();
  const media = db.media[id];
  if (media?.path && fs.existsSync(media.path)) {
    fs.unlinkSync(media.path);
  }
  delete db.media[id];
  writeDb(db);
  return { ok: true };
}

async function cloudDeleteMedia(id) {
  const media = await selectOne('media_files', `id=eq.${encodeURIComponent(id)}`);
  if (media?.storage_path) {
    await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_STORAGE_BUCKET}/${media.storage_path}`, {
      method: 'DELETE',
      headers: supabaseHeaders()
    }).catch(() => null);
  }
  await deleteRows('media_files', `id=eq.${encodeURIComponent(id)}`);
  return { ok: true };
}

async function transcribeAudio(audioData) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Missing OPENAI_API_KEY');
  }
  const parsed = parseDataUrl(audioData);
  if (!parsed || !parsed.buffer.length) {
    throw new Error('Missing audio data');
  }
  const form = new FormData();
  const ext = parsed.mimeType.includes('webm')
    ? 'webm'
    : parsed.mimeType.includes('wav')
      ? 'wav'
      : 'm4a';
  form.append('file', new Blob([parsed.buffer], { type: parsed.mimeType }), `review.${ext}`);
  form.append('model', process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe');
  form.append('language', 'zh');
  form.append('response_format', 'json');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: form
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error?.message || 'Transcription failed');
  }
  return result.text || '';
}

async function handleGet(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  if (url.pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      storage: HAS_SUPABASE ? 'supabase' : 'local'
    });
    return;
  }
  if (url.pathname === '/api/media/file') {
    const id = url.searchParams.get('id');
    if (!id) {
      sendJson(res, 400, { error: 'Missing media id' });
      return;
    }
    const media = HAS_SUPABASE ? await cloudReadMedia(id) : await localReadMedia(id);
    if (!media) {
      sendJson(res, 404, { error: 'Media not found' });
      return;
    }
    sendBinary(res, 200, media.mimeType, media.buffer);
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
}

async function handlePost(req, res) {
  const body = await readBody(req);

  if (req.url === '/api/auth/phone/code') {
    if (!/^1\d{10}$/.test(body.phone || '')) {
      sendJson(res, 400, { error: 'Invalid phone' });
      return;
    }
    const result = createPhoneLoginCode(body.phone);
    try {
      await sendPhoneLoginCode(body.phone, result.code);
    } catch (error) {
      phoneLoginCodes.delete(body.phone);
      sendJson(res, 503, { error: 'SMS provider is not configured or failed' });
      return;
    }
    sendJson(res, 200, { ok: true, expiresAt: result.expiresAt });
    return;
  }

  if (req.url === '/api/auth/phone') {
    if (!/^1\d{10}$/.test(body.phone || '')) {
      sendJson(res, 400, { error: 'Invalid phone' });
      return;
    }
    if (!verifyPhoneLoginCode(body.phone, body.code)) {
      sendJson(res, 401, { error: 'Invalid verification code' });
      return;
    }
    const result = HAS_SUPABASE ? await cloudAuthPhone(body) : await localAuthPhone(body);
    sendJson(res, 200, result);
    return;
  }

  if (req.url === '/api/auth/wechat') {
    const result = HAS_SUPABASE ? await cloudAuthWechat(body) : await localAuthWechat(body);
    sendJson(res, 200, result);
    return;
  }

  if (req.url === '/api/sync/push') {
    if (!body.userId) {
      sendJson(res, 400, { error: 'Missing userId' });
      return;
    }
    const result = HAS_SUPABASE ? await cloudPushSync(body) : await localPushSync(body);
    sendJson(res, 200, result);
    return;
  }

  if (req.url === '/api/sync/pull') {
    const result = HAS_SUPABASE ? await cloudPullSync(body.userId) : await localPullSync(body.userId);
    sendJson(res, 200, result);
    return;
  }

  if (req.url === '/api/media/upload') {
    const result = HAS_SUPABASE ? await cloudUploadMedia(req, body) : await localUploadMedia(req, body);
    sendJson(res, 200, result);
    return;
  }

  if (req.url === '/api/media/delete') {
    if (!body.mediaId) {
      sendJson(res, 400, { error: 'Missing mediaId' });
      return;
    }
    const result = HAS_SUPABASE ? await cloudDeleteMedia(body.mediaId) : await localDeleteMedia(body.mediaId);
    sendJson(res, 200, result);
    return;
  }

  if (req.url === '/api/transcribe') {
    const text = await transcribeAudio(body.audioData);
    sendJson(res, 200, { ok: true, text });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'GET') {
    await handleGet(req, res);
    return;
  }
  if (req.method === 'POST') {
    await handlePost(req, res);
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
}

http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    sendJson(res, 500, { error: error.message });
  });
}).listen(PORT, () => {
  console.log(`Expression Training backend listening on http://127.0.0.1:${PORT}`);
  console.log(`Storage mode: ${HAS_SUPABASE ? 'supabase' : 'local json fallback'}`);
});
