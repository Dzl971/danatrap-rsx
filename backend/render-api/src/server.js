import crypto from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';

const PORT = Number(process.env.PORT || 10000);
const VERSION = '5.0.0-phase4.1';
const requiredEnv = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  'FILE_SIGNING_SECRET'
];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);
const rateBuckets = new Map();

if (missingEnv.length) {
  console.warn(`[DanaTrap RSX] Variables manquantes : ${missingEnv.join(', ')}. Les routes concernées renverront une erreur de configuration.`);
}

function configured(name) {
  if (!process.env[name]) {
    const error = new Error(`CONFIG_MISSING:${name}`);
    error.status = 503;
    throw error;
  }
  return process.env[name];
}

function normalizeOrigins() {
  const raw = String(process.env.ALLOWED_ORIGINS || '*').trim();
  if (!raw || raw === '*') return '*';
  return raw.split(',').map((value) => value.trim().replace(/\/$/, '')).filter(Boolean);
}
const originRules = normalizeOrigins();

function corsOrigin(req) {
  const origin = String(req.headers.origin || '').replace(/\/$/, '');
  if (!origin) return '*';
  if (originRules === '*' || originRules.includes(origin)) return origin;
  return 'null';
}

function applyHeaders(req, res) {
  res.setHeader('Access-Control-Allow-Origin', corsOrigin(req));
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Content-Range,X-Upload-Session,X-Upload-Kind');
  res.setHeader('Access-Control-Expose-Headers', 'Range,Content-Range');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

function sendJson(req, res, status, data) {
  applyHeaders(req, res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

function rateAllowed(req, key, limit = 600, windowMs = 60_000) {
  const now = Date.now();
  const id = `${clientIp(req)}:${key}`;
  let bucket = rateBuckets.get(id);
  if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + windowMs };
  bucket.count += 1;
  rateBuckets.set(id, bucket);
  return bucket.count <= limit;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) if (bucket.resetAt <= now) rateBuckets.delete(key);
}, 60_000).unref();

async function readBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error('PAYLOAD_TOO_LARGE');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const body = await readBody(req, 1024 * 1024);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    const error = new Error('JSON_INVALIDE');
    error.status = 400;
    throw error;
  }
}

async function verifyUser(req) {
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ')) {
    const error = new Error('AUTH_REQUIRED');
    error.status = 401;
    throw error;
  }
  const response = await fetch(`${configured('SUPABASE_URL')}/auth/v1/user`, {
    headers: { apikey: configured('SUPABASE_ANON_KEY'), Authorization: auth }
  });
  if (!response.ok) {
    const error = new Error('INVALID_TOKEN');
    error.status = 401;
    throw error;
  }
  return response.json();
}

async function isAdmin(user) {
  const adminEmail = String(process.env.ADMIN_EMAIL || '').toLowerCase();
  if (adminEmail && String(user.email || '').toLowerCase() === adminEmail) return true;
  const response = await fetch(`${configured('SUPABASE_URL')}/rest/v1/profiles?user_id=eq.${encodeURIComponent(user.id)}&select=role`, {
    headers: {
      apikey: configured('SUPABASE_SERVICE_ROLE_KEY'),
      Authorization: `Bearer ${configured('SUPABASE_SERVICE_ROLE_KEY')}`
    }
  });
  if (!response.ok) return false;
  const rows = await response.json();
  return rows[0]?.role === 'Admin';
}

async function profileRole(userId) {
  const response = await fetch(`${configured('SUPABASE_URL')}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&select=role`, {
    headers: {
      apikey: configured('SUPABASE_SERVICE_ROLE_KEY'),
      Authorization: `Bearer ${configured('SUPABASE_SERVICE_ROLE_KEY')}`
    }
  });
  if (!response.ok) return '';
  const rows = await response.json();
  return rows[0]?.role || '';
}

async function authorizeUpload(user, kind, beatId) {
  const role = await profileRole(user.id);
  const admin = role === 'Admin' || (process.env.ADMIN_EMAIL && String(user.email || '').toLowerCase() === String(process.env.ADMIN_EMAIL).toLowerCase());
  const profileAsset = kind === 'cover' && String(beatId || '').startsWith(`profile-${user.id}`);
  if (profileAsset || admin) return true;
  if (!['Beatmaker', 'Producteur'].includes(role)) {
    const error = new Error('Seuls les beatmakers, producteurs et administrateurs peuvent envoyer des fichiers de production.');
    error.status = 403;
    throw error;
  }
  if (!beatId) {
    const error = new Error('Production associée manquante.');
    error.status = 400;
    throw error;
  }
  const response = await fetch(`${configured('SUPABASE_URL')}/rest/v1/beats?id=eq.${encodeURIComponent(beatId)}&select=producer_id`, {
    headers: {
      apikey: configured('SUPABASE_SERVICE_ROLE_KEY'),
      Authorization: `Bearer ${configured('SUPABASE_SERVICE_ROLE_KEY')}`
    }
  });
  if (!response.ok) {
    const error = new Error('Impossible de vérifier la production associée.');
    error.status = 502;
    throw error;
  }
  const rows = await response.json();
  if (!rows[0] || String(rows[0].producer_id) !== String(user.id)) {
    const error = new Error('Tu ne peux envoyer des fichiers que pour tes propres productions.');
    error.status = 403;
    throw error;
  }
  return true;
}

async function googleAccessToken() {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: configured('GOOGLE_CLIENT_ID'),
      client_secret: configured('GOOGLE_CLIENT_SECRET'),
      refresh_token: configured('GOOGLE_REFRESH_TOKEN'),
      grant_type: 'refresh_token'
    })
  });
  if (!response.ok) {
    const details = await response.text();
    const error = new Error(`GOOGLE_TOKEN_${response.status}:${details.slice(0, 250)}`);
    error.status = 502;
    throw error;
  }
  return (await response.json()).access_token;
}

function folderFor(kind) {
  if (kind === 'preview') return process.env.DRIVE_PREVIEWS_FOLDER_ID || process.env.DRIVE_ROOT_FOLDER_ID;
  if (kind === 'cover') return process.env.DRIVE_IMAGES_FOLDER_ID || process.env.DRIVE_ROOT_FOLDER_ID;
  return process.env.DRIVE_PRIVATE_FOLDER_ID || process.env.DRIVE_ROOT_FOLDER_ID;
}

function signMedia(fileId, expiresAt) {
  return crypto.createHmac('sha256', configured('FILE_SIGNING_SECRET')).update(`${fileId}.${expiresAt}`).digest('base64url');
}

function verifyMediaSignature(fileId, expiresAt, signature) {
  if (!expiresAt || Number(expiresAt) < Math.floor(Date.now() / 1000) || !signature) return false;
  const expected = Buffer.from(signMedia(fileId, expiresAt));
  const received = Buffer.from(String(signature));
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

function publicOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  return String(process.env.RENDER_EXTERNAL_URL || `${proto}://${req.headers.host}`).replace(/\/$/, '');
}

const MIME_BY_EXTENSION = new Map([
  ['mp3', 'audio/mpeg'], ['wav', 'audio/wav'], ['wave', 'audio/wav'],
  ['m4a', 'audio/mp4'], ['aac', 'audio/aac'], ['ogg', 'audio/ogg'],
  ['opus', 'audio/ogg; codecs=opus'], ['flac', 'audio/flac'], ['webm', 'audio/webm'],
  ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['png', 'image/png'],
  ['webp', 'image/webp'], ['gif', 'image/gif'], ['svg', 'image/svg+xml']
]);

function safeFileName(name = 'media') {
  return String(name).replace(/[\r\n\"]/g, '_').slice(0, 220) || 'media';
}

function contentDisposition(name = 'media') {
  const safe = safeFileName(name);
  const ascii = safe.replace(/[^\x20-\x7E]/g, '_');
  return `inline; filename=\"${ascii}\"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

function mediaMime(metadata = {}, responseType = '') {
  const reported = String(responseType || metadata.mimeType || '').trim().toLowerCase();
  if (reported && reported !== 'application/octet-stream') return reported;
  const match = String(metadata.name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return (match && MIME_BY_EXTENSION.get(match[1])) || 'application/octet-stream';
}

async function driveMetadata(token, fileId) {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,appProperties`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    const error = new Error(`MEDIA_METADATA_${response.status}:${(await response.text()).slice(0, 250)}`);
    error.status = response.status === 404 ? 404 : 502;
    throw error;
  }
  return response.json();
}

async function pipeDriveMedia(req, res, fileId, token, metadata, cacheControl = 'private, max-age=3600') {
  const guessedType = mediaMime(metadata);
  if (req.method === 'HEAD') {
    applyHeaders(req, res);
    res.statusCode = 200;
    res.setHeader('Content-Type', guessedType);
    if (metadata.size) res.setHeader('Content-Length', String(metadata.size));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', contentDisposition(metadata.name));
    res.setHeader('Cache-Control', cacheControl);
    return res.end();
  }

  const headers = { Authorization: `Bearer ${token}` };
  if (req.headers.range) headers.Range = req.headers.range;
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, { headers });
  applyHeaders(req, res);
  res.statusCode = response.status;
  const responseType = response.headers.get('content-type') || '';
  res.setHeader('Content-Type', mediaMime(metadata, responseType));
  for (const header of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const value = response.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  if (!res.hasHeader('Accept-Ranges')) res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Disposition', contentDisposition(metadata.name));
  res.setHeader('Cache-Control', cacheControl);
  if (!response.ok || !response.body) return res.end();
  return Readable.fromWeb(response.body).pipe(res);
}

async function createUploadSession(req, res) {
  const user = await verifyUser(req);
  const { name, size, mimeType, kind = 'other', beatId = '' } = await readJson(req);
  if (!name || !Number(size)) return sendJson(req, res, 400, { error: 'Nom ou taille manquante.' });
  if (Number(size) > Number(process.env.MAX_UPLOAD_BYTES || 5 * 1024 * 1024 * 1024)) return sendJson(req, res, 413, { error: 'Le fichier dépasse la limite configurée.' });
  await authorizeUpload(user, kind, beatId);

  const token = await googleAccessToken();
  const folder = folderFor(kind);
  const metadata = {
    name: String(name).slice(0, 220),
    ...(folder ? { parents: [folder] } : {}),
    description: `DanaTrap RSX · ${kind} · ${user.email || user.id}`,
    appProperties: {
      danatrap: 'true',
      owner_user_id: String(user.id),
      beat_id: String(beatId || ''),
      kind: String(kind || 'other')
    }
  };
  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,size', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType || 'application/octet-stream',
      'X-Upload-Content-Length': String(size)
    },
    body: JSON.stringify(metadata)
  });
  if (!response.ok) return sendJson(req, res, 502, { error: 'Google Drive a refusé la session.', details: (await response.text()).slice(0, 500) });
  return sendJson(req, res, 200, { sessionUrl: response.headers.get('Location') });
}

async function uploadChunk(req, res) {
  await verifyUser(req);
  const sessionUrl = String(req.headers['x-upload-session'] || '');
  if (!sessionUrl.startsWith('https://www.googleapis.com/upload/drive/')) return sendJson(req, res, 400, { error: 'Session Drive invalide.' });
  if (!req.headers['content-range']) return sendJson(req, res, 400, { error: 'Content-Range manquant.' });

  const chunk = await readBody(req, 9 * 1024 * 1024);
  const token = await googleAccessToken();
  const response = await fetch(sessionUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': req.headers['content-type'] || 'application/octet-stream',
      'Content-Range': req.headers['content-range']
    },
    body: chunk,
    redirect: 'manual'
  });
  applyHeaders(req, res);
  if (response.status === 308) {
    if (response.headers.get('Range')) res.setHeader('Range', response.headers.get('Range'));
    res.statusCode = 308;
    return res.end();
  }
  if (!response.ok) return sendJson(req, res, response.status, { error: 'Un morceau du fichier a été refusé.', details: (await response.text()).slice(0, 500) });

  const file = await response.json();
  const kind = String(req.headers['x-upload-kind'] || 'other');
  let stream_url = '';
  let signed_stream_url = '';
  if (['preview', 'cover'].includes(kind)) {
    // URL stable pour les médias publics. Le serveur vérifie toujours dans Drive
    // que le fichier a bien été créé par DanaTrap et qu'il s'agit d'une preview/couverture.
    stream_url = `${publicOrigin(req)}/public-media/${encodeURIComponent(file.id)}`;
    const ttl = Math.max(3600, Number(process.env.MEDIA_LINK_TTL_SECONDS || 31536000));
    const exp = Math.floor(Date.now() / 1000) + ttl;
    signed_stream_url = `${publicOrigin(req)}/media/${encodeURIComponent(file.id)}?exp=${exp}&sig=${encodeURIComponent(signMedia(file.id, exp))}`;
  }
  return sendJson(req, res, 200, { ...file, kind, stream_url, signed_stream_url });
}

async function streamMedia(req, res, fileId, url) {
  if (!verifyMediaSignature(fileId, url.searchParams.get('exp'), url.searchParams.get('sig'))) return sendJson(req, res, 403, { error: 'Lien expiré ou invalide.' });
  const token = await googleAccessToken();
  const metadata = await driveMetadata(token, fileId);
  return pipeDriveMedia(req, res, fileId, token, metadata, 'private, max-age=3600');
}

async function streamPublicMedia(req, res, fileId) {
  const token = await googleAccessToken();
  const metadata = await driveMetadata(token, fileId);
  const props = metadata.appProperties || {};
  const kind = String(props.kind || '');
  if (String(props.danatrap || '') !== 'true' || !['preview', 'cover'].includes(kind)) {
    return sendJson(req, res, 403, { error: 'Ce fichier n’est pas un média public DanaTrap.' });
  }
  return pipeDriveMedia(req, res, fileId, token, metadata, 'public, max-age=604800, stale-while-revalidate=2592000, immutable');
}

async function listUsers(req, res) {
  const admin = await verifyUser(req);
  if (!(await isAdmin(admin))) return sendJson(req, res, 403, { error: 'Administrateur requis.' });
  const response = await fetch(`${configured('SUPABASE_URL')}/auth/v1/admin/users?per_page=1000&page=1`, {
    headers: {
      apikey: configured('SUPABASE_SERVICE_ROLE_KEY'),
      Authorization: `Bearer ${configured('SUPABASE_SERVICE_ROLE_KEY')}`
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return sendJson(req, res, response.status, { error: data.msg || data.message || 'Lecture des utilisateurs Supabase impossible.' });
  const users = (data.users || []).map((user) => ({
    id: user.id,
    email: user.email || '',
    name: user.user_metadata?.name || user.email?.split('@')[0] || 'Utilisateur',
    role: user.user_metadata?.role || 'Artiste',
    created_at: user.created_at,
    last_sign_in_at: user.last_sign_in_at || null
  }));
  return sendJson(req, res, 200, { users });
}

async function createUser(req, res) {
  const admin = await verifyUser(req);
  if (!(await isAdmin(admin))) return sendJson(req, res, 403, { error: 'Administrateur requis.' });
  const { email, password, name, role = 'Artiste' } = await readJson(req);
  if (!email || !password || !name) return sendJson(req, res, 400, { error: 'Nom, e-mail et mot de passe requis.' });

  const response = await fetch(`${configured('SUPABASE_URL')}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: configured('SUPABASE_SERVICE_ROLE_KEY'),
      Authorization: `Bearer ${configured('SUPABASE_SERVICE_ROLE_KEY')}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { name, role } })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return sendJson(req, res, response.status, { error: data.msg || data.message || 'Création Supabase impossible.' });
  return sendJson(req, res, 200, { user: data });
}

async function deleteUser(req, res) {
  const admin = await verifyUser(req);
  if (!(await isAdmin(admin))) return sendJson(req, res, 403, { error: 'Administrateur requis.' });
  const { userId } = await readJson(req);
  if (!userId) return sendJson(req, res, 400, { error: 'Identifiant utilisateur manquant.' });
  if (String(userId) === String(admin.id)) return sendJson(req, res, 400, { error: 'Tu ne peux pas supprimer ton propre compte administrateur.' });

  const response = await fetch(`${configured('SUPABASE_URL')}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    headers: {
      apikey: configured('SUPABASE_SERVICE_ROLE_KEY'),
      Authorization: `Bearer ${configured('SUPABASE_SERVICE_ROLE_KEY')}`
    }
  });
  if (!response.ok) return sendJson(req, res, response.status, { error: 'Suppression Supabase impossible.', details: (await response.text()).slice(0, 500) });
  return sendJson(req, res, 200, { ok: true });
}

const server = http.createServer(async (req, res) => {
  applyHeaders(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (!rateAllowed(req, 'global')) return sendJson(req, res, 429, { error: 'Trop de requêtes. Réessaie dans une minute.' });

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(req, res, 200, { ok: true, service: 'DanaTrap RSX Render API', version: VERSION, configured: missingEnv.length === 0, missing: missingEnv });
    }
    if (req.method === 'POST' && url.pathname === '/upload-session') {
      if (!rateAllowed(req, 'upload-session', 60)) return sendJson(req, res, 429, { error: 'Trop de créations de session d’upload.' });
      return await createUploadSession(req, res);
    }
    if (req.method === 'PUT' && url.pathname === '/upload-chunk') {
      if (!rateAllowed(req, 'upload-chunk', 600)) return sendJson(req, res, 429, { error: 'Trop de morceaux envoyés en une minute.' });
      return await uploadChunk(req, res);
    }
    if (['GET', 'HEAD'].includes(req.method) && url.pathname.startsWith('/public-media/')) {
      return await streamPublicMedia(req, res, decodeURIComponent(url.pathname.slice('/public-media/'.length)));
    }
    if (['GET', 'HEAD'].includes(req.method) && url.pathname.startsWith('/media/')) {
      return await streamMedia(req, res, decodeURIComponent(url.pathname.slice('/media/'.length)), url);
    }
    if (req.method === 'GET' && url.pathname === '/admin/users') {
      if (!rateAllowed(req, 'admin', 30)) return sendJson(req, res, 429, { error: 'Trop de requêtes administrateur.' });
      return await listUsers(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/admin/create-user') {
      if (!rateAllowed(req, 'admin', 30)) return sendJson(req, res, 429, { error: 'Trop de requêtes administrateur.' });
      return await createUser(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/admin/delete-user') {
      if (!rateAllowed(req, 'admin', 30)) return sendJson(req, res, 429, { error: 'Trop de requêtes administrateur.' });
      return await deleteUser(req, res);
    }
    return sendJson(req, res, 404, { error: 'Route inconnue.' });
  } catch (error) {
    console.error('[DanaTrap RSX API]', error);
    const message = error instanceof Error ? error.message : 'Erreur interne';
    const status = Number(error?.status || 500);
    const publicMessage = message.startsWith('CONFIG_MISSING:')
      ? `Configuration Render incomplète : ${message.split(':')[1]}`
      : message === 'PAYLOAD_TOO_LARGE'
        ? 'Fichier ou requête trop volumineuse.'
        : message === 'JSON_INVALIDE'
          ? 'Corps JSON invalide.'
          : message;
    return sendJson(req, res, status, { error: publicMessage });
  }
});

server.requestTimeout = 10 * 60 * 1000;
server.headersTimeout = 65 * 1000;
server.listen(PORT, '0.0.0.0', () => console.log(`[DanaTrap RSX] API démarrée sur le port ${PORT}`));
