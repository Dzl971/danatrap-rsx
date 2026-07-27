import crypto from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';

const PORT = Number(process.env.PORT || 10000);
const VERSION = '5.0.0-phase11.1';
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
const uploadSessions = new Map();
const backgroundState = { running: false, lastRunAt: null, lastResult: null, lastError: '' };
const authUserCache = new Map();

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
  const response = await fetch(`${configured('SUPABASE_URL')}/rest/v1/profiles?user_id=eq.${encodeURIComponent(user.id)}&select=role,is_admin`, {
    headers: {
      apikey: configured('SUPABASE_SERVICE_ROLE_KEY'),
      Authorization: `Bearer ${configured('SUPABASE_SERVICE_ROLE_KEY')}`
    }
  });
  if (!response.ok) return false;
  const rows = await response.json();
  return rows[0]?.role === 'Admin' || rows[0]?.is_admin === true;
}

async function profileRole(userId) {
  const response = await fetch(`${configured('SUPABASE_URL')}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&select=role,roles,is_admin`, {
    headers: {
      apikey: configured('SUPABASE_SERVICE_ROLE_KEY'),
      Authorization: `Bearer ${configured('SUPABASE_SERVICE_ROLE_KEY')}`
    }
  });
  if (!response.ok) return '';
  const rows = await response.json();
  const p=rows[0]||{};return p.is_admin?'Admin':(Array.isArray(p.roles)&&p.roles[0])||p.role||'';
}

async function authorizeUpload(user, kind, beatId) {
  const response=await fetch(`${configured('SUPABASE_URL')}/rest/v1/profiles?user_id=eq.${encodeURIComponent(user.id)}&select=role,roles,is_admin`,{headers:serviceHeaders()});
  const rows=response.ok?await response.json():[];const profile=rows[0]||{};const roles=Array.isArray(profile.roles)?profile.roles:[profile.role].filter(Boolean);
  const admin=profile.is_admin===true||profile.role==='Admin'||(process.env.ADMIN_EMAIL&&String(user.email||'').toLowerCase()===String(process.env.ADMIN_EMAIL).toLowerCase());
  const profileAsset = kind === 'cover' && String(beatId || '').startsWith(`profile-${user.id}`);
  if (profileAsset || admin) return true;
  if (!roles.some(role=>['Beatmaker','Producteur'].includes(role))) { const error=new Error('Seuls les beatmakers, producteurs et administrateurs peuvent envoyer des fichiers de production.');error.status=403;throw error; }
  if (!beatId) { const error=new Error('Production associée manquante.');error.status=400;throw error; }
  const beatResponse=await fetch(`${configured('SUPABASE_URL')}/rest/v1/beats?id=eq.${encodeURIComponent(beatId)}&select=producer_id`,{headers:serviceHeaders()});
  if(!beatResponse.ok){const error=new Error('Impossible de vérifier la production associée.');error.status=502;throw error;}
  const beats=await beatResponse.json();if(!beats[0]||String(beats[0].producer_id)!==String(user.id)){const error=new Error('Tu ne peux envoyer des fichiers que pour tes propres productions.');error.status=403;throw error;}
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

function publicSiteUrl() {
  return String(process.env.PUBLIC_SITE_URL || 'https://danatrap-rsx-site.onrender.com').replace(/\/$/, '');
}

function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

function htmlEscape(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
}

async function sendTransactionalEmail({ to, subject, text = '', html = '' }) {
  if (!emailConfigured()) return { sent: false, skipped: true, reason: 'EMAIL_NOT_CONFIGURED' };
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [to],
      subject: String(subject || 'DanaTrap RSX').slice(0, 180),
      text: String(text || '').slice(0, 10000),
      html: html || `<div style="font-family:Arial,sans-serif;background:#090a0c;color:#f5f5f2;padding:28px;border-radius:18px"><h2 style="color:#f6c90e">DanaTrap RSX</h2><p>${htmlEscape(text)}</p></div>`
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.message || `E-mail refusé (${response.status})`);
    error.status = 502;
    throw error;
  }
  return { sent: true, id: body.id || '' };
}

async function authUserById(userId) {
  const cached = authUserCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.user;
  const response = await fetch(`${configured('SUPABASE_URL')}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    headers: {
      apikey: configured('SUPABASE_SERVICE_ROLE_KEY'),
      Authorization: `Bearer ${configured('SUPABASE_SERVICE_ROLE_KEY')}`
    }
  });
  if (!response.ok) return null;
  const user = await response.json();
  authUserCache.set(userId, { user, expiresAt: Date.now() + 10 * 60_000 });
  return user;
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


const SERVER_FILE_RULES={
  preview:['mp3','wav'],wav:['wav'],project:['flp','als','zip','rar'],stems:['zip','rar'],cover:['jpg','jpeg','png','webp','gif']
};
function extensionOf(name=''){return String(name).toLowerCase().split('.').pop();}
function ascii(buffer,start=0,length=4){return buffer.subarray(start,start+length).toString('latin1');}
function magicValid(ext,buffer){
  if(ext==='mp3')return ascii(buffer,0,3)==='ID3'||(buffer[0]===0xff&&(buffer[1]&0xe0)===0xe0);
  if(ext==='wav')return ascii(buffer,0,4)==='RIFF'&&ascii(buffer,8,4)==='WAVE';
  if(['jpg','jpeg'].includes(ext))return buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff;
  if(ext==='png')return buffer[0]===0x89&&ascii(buffer,1,3)==='PNG';
  if(ext==='webp')return ascii(buffer,0,4)==='RIFF'&&ascii(buffer,8,4)==='WEBP';
  if(ext==='gif')return ascii(buffer,0,4)==='GIF8';
  if(ext==='zip')return ascii(buffer,0,2)==='PK';
  if(ext==='rar')return ascii(buffer,0,4)==='Rar!';
  if(ext==='flp')return ascii(buffer,0,4)==='FLhd';
  if(ext==='als')return (buffer[0]===0x1f&&buffer[1]===0x8b)||ascii(buffer,0,2)==='PK';
  return true;
}
function validateUploadDeclaration({name,kind,size,fingerprint}){
  const ext=extensionOf(name),allowed=SERVER_FILE_RULES[kind];
  if(allowed&&!allowed.includes(ext)){const e=new Error(`Extension .${ext||'?'} refusée pour ${kind}.`);e.status=415;throw e;}
  if(fingerprint&&!/^[a-f0-9]{64}$/i.test(String(fingerprint))){const e=new Error('Empreinte de fichier invalide.');e.status=400;throw e;}
  if(Number(size)<=0){const e=new Error('Fichier vide.');e.status=400;throw e;}
  return ext;
}
function mediaUrls(req,file,kind){
  let stream_url='',signed_stream_url='';
  if(['preview','cover'].includes(kind)){
    stream_url=`${publicOrigin(req)}/public-media/${encodeURIComponent(file.id)}`;
    const ttl=Math.max(3600,Number(process.env.MEDIA_LINK_TTL_SECONDS||31536000)),exp=Math.floor(Date.now()/1000)+ttl;
    signed_stream_url=`${publicOrigin(req)}/media/${encodeURIComponent(file.id)}?exp=${exp}&sig=${encodeURIComponent(signMedia(file.id,exp))}`;
  }
  return {...file,kind,stream_url,signed_stream_url};
}
async function findDuplicateDriveFile(token,{userId,fingerprint,kind,size}){
  if(!fingerprint)return null;
  const q=`trashed = false and appProperties has { key='danatrap' and value='true' } and appProperties has { key='owner_user_id' and value='${String(userId).replaceAll("'","")}' } and appProperties has { key='fingerprint' and value='${String(fingerprint)}' } and appProperties has { key='kind' and value='${String(kind).replaceAll("'","")}' }`;
  const url=new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set('q',q);url.searchParams.set('fields','files(id,name,mimeType,size,appProperties,createdTime)');url.searchParams.set('pageSize','10');
  const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});
  if(!response.ok)return null;
  const files=(await response.json()).files||[];
  return files.find(file=>!size||Number(file.size||0)===Number(size))||null;
}
setInterval(()=>{const limit=Date.now()-24*3600_000;for(const [key,value] of uploadSessions){if(value.createdAt<limit)uploadSessions.delete(key);}},3600_000).unref();

async function createUploadSession(req, res) {
  const user = await verifyUser(req);
  const { name, size, mimeType, kind = 'other', beatId = '', fingerprint = '', head = '' } = await readJson(req);
  if (!name || !Number(size)) return sendJson(req, res, 400, { error: 'Nom ou taille manquante.' });
  if (Number(size) > Number(process.env.MAX_UPLOAD_BYTES || 5 * 1024 * 1024 * 1024)) return sendJson(req, res, 413, { error: 'Le fichier dépasse la limite configurée.' });
  const ext=validateUploadDeclaration({name,kind,size,fingerprint});
  if(head&&/^[a-f0-9]+$/i.test(head)){const bytes=Buffer.from(head,'hex');if(!magicValid(ext,bytes))return sendJson(req,res,415,{error:`Le contenu de « ${safeFileName(name)} » ne correspond pas à son extension.`});}
  await authorizeUpload(user, kind, beatId);

  const token = await googleAccessToken();
  const duplicate=await findDuplicateDriveFile(token,{userId:user.id,fingerprint,kind,size});
  if(duplicate)return sendJson(req,res,200,{duplicate:true,file:mediaUrls(req,duplicate,kind)});

  const folder = folderFor(kind);
  const metadata = {
    name: String(name).slice(0, 220),
    ...(folder ? { parents: [folder] } : {}),
    description: `DanaTrap RSX · ${kind} · ${user.email || user.id}`,
    appProperties: {
      danatrap: 'true',
      owner_user_id: String(user.id),
      beat_id: String(beatId || ''),
      kind: String(kind || 'other'),
      fingerprint:String(fingerprint||''),
      original_size:String(size),
      extension:ext
    }
  };
  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,size,appProperties', {
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
  const sessionUrl=response.headers.get('Location');
  uploadSessions.set(sessionUrl,{userId:user.id,kind,beatId,name,size:Number(size),mimeType,ext,fingerprint,createdAt:Date.now()});
  return sendJson(req, res, 200, { sessionUrl });
}

async function uploadChunk(req, res) {
  const user=await verifyUser(req);
  const sessionUrl = String(req.headers['x-upload-session'] || '');
  if (!sessionUrl.startsWith('https://www.googleapis.com/upload/drive/')) return sendJson(req, res, 400, { error: 'Session Drive invalide.' });
  if (!req.headers['content-range']) return sendJson(req, res, 400, { error: 'Content-Range manquant.' });

  const info=uploadSessions.get(sessionUrl);
  if(info&&String(info.userId)!==String(user.id))return sendJson(req,res,403,{error:'Cette session d’upload appartient à un autre utilisateur.'});
  const chunk = await readBody(req, 9 * 1024 * 1024);
  const range=String(req.headers['content-range']||'');
  const startOffset=Number((range.match(/bytes\s+(\d+)-/)||[])[1]||0);
  if(info&&startOffset===0&&!magicValid(info.ext,chunk))return sendJson(req,res,415,{error:`Le contenu de « ${safeFileName(info.name)} » est invalide ou corrompu.`});

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
  const kind = info?.kind||String(req.headers['x-upload-kind'] || 'other');
  uploadSessions.delete(sessionUrl);
  return sendJson(req,res,200,{...mediaUrls(req,file,kind),fingerprint:info?.fingerprint||'',duplicate:false});
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


async function resetUserPassword(req, res) {
  const admin = await verifyUser(req);
  if (!(await isAdmin(admin))) return sendJson(req, res, 403, { error: 'Administrateur requis.' });
  const { email, userId, password, requestId } = await readJson(req);
  if (!password || String(password).length < 8) return sendJson(req, res, 400, { error: 'Le mot de passe temporaire doit contenir au moins 8 caractères.' });
  let targetId = userId || '';
  if (!targetId && email) {
    const response = await fetch(`${configured('SUPABASE_URL')}/auth/v1/admin/users?per_page=1000&page=1`, { headers: { apikey: configured('SUPABASE_SERVICE_ROLE_KEY'), Authorization: `Bearer ${configured('SUPABASE_SERVICE_ROLE_KEY')}` } });
    const data = await response.json().catch(() => ({}));
    targetId = (data.users || []).find(u => String(u.email || '').toLowerCase() === String(email).toLowerCase())?.id || '';
  }
  if (!targetId) return sendJson(req, res, 404, { error: 'Utilisateur introuvable.' });
  const response = await fetch(`${configured('SUPABASE_URL')}/auth/v1/admin/users/${encodeURIComponent(targetId)}`, { method: 'PUT', headers: { apikey: configured('SUPABASE_SERVICE_ROLE_KEY'), Authorization: `Bearer ${configured('SUPABASE_SERVICE_ROLE_KEY')}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return sendJson(req, res, response.status, { error: data.msg || data.message || 'Réinitialisation impossible.' });
  await fetch(`${configured('SUPABASE_URL')}/rest/v1/profiles?user_id=eq.${encodeURIComponent(targetId)}`, { method: 'PATCH', headers: { apikey: configured('SUPABASE_SERVICE_ROLE_KEY'), Authorization: `Bearer ${configured('SUPABASE_SERVICE_ROLE_KEY')}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ password_change_required: true, updated_at: new Date().toISOString() }) });
  if (requestId) await fetch(`${configured('SUPABASE_URL')}/rest/v1/account_recovery_requests?id=eq.${encodeURIComponent(requestId)}`, { method: 'PATCH', headers: { apikey: configured('SUPABASE_SERVICE_ROLE_KEY'), Authorization: `Bearer ${configured('SUPABASE_SERVICE_ROLE_KEY')}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'completed', handled_by: admin.id, handled_at: new Date().toISOString() }) });
  let emailSent = false;
  if (email) {
    try {
      const result = await sendTransactionalEmail({
        to: email,
        subject: 'Ton mot de passe temporaire DanaTrap RSX',
        text: `Dzl 971 a généré un mot de passe temporaire pour ton compte DanaTrap RSX : ${password}. Connecte-toi puis change-le immédiatement dans Paramètres > Sécurité.`,
        html: `<div style="font-family:Arial,sans-serif;background:#090a0c;color:#f5f5f2;padding:30px;border-radius:20px"><h2 style="color:#f6c90e">DanaTrap RSX</h2><p>Dzl 971 a généré un mot de passe temporaire pour ton compte.</p><div style="font-size:22px;font-weight:800;background:#17191f;padding:16px;border-radius:12px;letter-spacing:1px">${htmlEscape(password)}</div><p>Connecte-toi puis change-le immédiatement dans <strong>Paramètres &gt; Sécurité</strong>.</p><a href="${publicSiteUrl()}/#/connexion" style="display:inline-block;background:#f6c90e;color:#090a0c;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:800">Ouvrir DanaTrap RSX</a></div>`
      });
      emailSent = result.sent === true;
    } catch (error) {
      console.warn('[DanaTrap email temporaire]', error.message);
    }
  }
  return sendJson(req, res, 200, { ok: true, userId: targetId, emailSent });
}

async function sendRecoveryLink(req, res) {
  const admin = await requireAdmin(req);
  const { email, requestId } = await readJson(req);
  if (!email) return sendJson(req, res, 400, { error: 'Adresse e-mail manquante.' });
  const response = await fetch(`${configured('SUPABASE_URL')}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      apikey: configured('SUPABASE_SERVICE_ROLE_KEY'),
      Authorization: `Bearer ${configured('SUPABASE_SERVICE_ROLE_KEY')}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ type: 'recovery', email, options: { redirectTo: `${publicSiteUrl()}/#/connexion` } })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return sendJson(req, res, response.status, { error: data.msg || data.message || 'Lien de récupération impossible.' });
  const actionLink = data.action_link || data.properties?.action_link || '';
  let emailSent = false;
  if (actionLink) {
    try {
      const result = await sendTransactionalEmail({
        to: email,
        subject: 'Récupération de ton compte DanaTrap RSX',
        text: `Dzl 971 a préparé un lien sécurisé pour réinitialiser ton mot de passe : ${actionLink}`,
        html: `<div style="font-family:Arial,sans-serif;background:#090a0c;color:#f5f5f2;padding:30px;border-radius:20px"><h2 style="color:#f6c90e">Récupération DanaTrap RSX</h2><p>Dzl 971 a validé ta demande de récupération.</p><a href="${htmlEscape(actionLink)}" style="display:inline-block;background:#f6c90e;color:#090a0c;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:800">Créer un nouveau mot de passe</a><p style="color:#9ca0aa">Ce lien est personnel. Ne le partage pas.</p></div>`
      });
      emailSent = result.sent === true;
    } catch (error) {
      console.warn('[DanaTrap recovery email]', error.message);
    }
  }
  if (requestId) await rest(`account_recovery_requests?id=eq.${encodeURIComponent(requestId)}`, { method:'PATCH', headers:{Prefer:'return=minimal'}, body:JSON.stringify({ status: emailSent ? 'completed' : 'processing', handled_by: admin.id, handled_at:new Date().toISOString() }) });
  return sendJson(req, res, 200, { ok:true, emailSent, actionLink: emailSent ? '' : actionLink });
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


const serviceHeaders = () => ({ apikey: configured('SUPABASE_SERVICE_ROLE_KEY'), Authorization: `Bearer ${configured('SUPABASE_SERVICE_ROLE_KEY')}`, 'Content-Type': 'application/json' });
async function rest(path, options={}) { const response=await fetch(`${configured('SUPABASE_URL')}/rest/v1/${path}`,{...options,headers:{...serviceHeaders(),...(options.headers||{})}}); const text=await response.text(); let data=null; try{data=text?JSON.parse(text):null;}catch{data=text;} if(!response.ok){const e=new Error(typeof data==='object'?(data.message||data.error||JSON.stringify(data)):String(data||'Erreur Supabase'));e.status=response.status;throw e;} return data; }


function notificationPreferenceKey(type = '') {
  if (type === 'message') return 'messages';
  if (['reservation_reminder','waitlist'].includes(type)) return 'reservation_reminders';
  if (String(type).startsWith('reservation')) return 'reservations';
  return 'email';
}

async function markNotificationEmail(notification, status, details = {}) {
  const payload = { ...(notification.payload || {}), email_delivery: { status, at: new Date().toISOString(), ...details } };
  await rest(`notifications?id=eq.${encodeURIComponent(notification.id)}`, { method:'PATCH', headers:{Prefer:'return=minimal'}, body:JSON.stringify({ payload }) });
}

async function processNotificationEmails(limit = 60) {
  if (!emailConfigured()) return { configured:false, sent:0, skipped:0, failed:0 };
  const since = new Date(Date.now() - 72 * 3600_000).toISOString();
  const rows = await rest(`notifications?select=*&created_at=gte.${encodeURIComponent(since)}&order=created_at.asc&limit=200`);
  const pending = (rows || []).filter(row => !row.payload?.email_delivery?.status).slice(0, limit);
  let sent = 0, skipped = 0, failed = 0;
  for (const notification of pending) {
    try {
      const profiles = await rest(`profiles?user_id=eq.${encodeURIComponent(notification.user_id)}&select=name,notification_preferences`);
      const profile = profiles?.[0] || {};
      const preferences = profile.notification_preferences || {};
      const key = notificationPreferenceKey(notification.type);
      if (preferences.email === false || preferences[key] === false) {
        await markNotificationEmail(notification, 'skipped', { reason:'USER_PREFERENCE' });
        skipped += 1;
        continue;
      }
      const user = await authUserById(notification.user_id);
      if (!user?.email) {
        await markNotificationEmail(notification, 'skipped', { reason:'EMAIL_MISSING' });
        skipped += 1;
        continue;
      }
      const actionUrl = `${publicSiteUrl()}/${String(notification.link || '#/app/notifications').replace(/^\//,'')}`;
      const result = await sendTransactionalEmail({
        to: user.email,
        subject: notification.title || 'Nouvelle activité DanaTrap RSX',
        text: `${notification.body || ''}

Ouvrir : ${actionUrl}`,
        html: `<div style="font-family:Arial,sans-serif;background:#090a0c;color:#f5f5f2;padding:30px;border-radius:20px"><h2 style="color:#f6c90e">${htmlEscape(notification.title || 'DanaTrap RSX')}</h2><p>${htmlEscape(notification.body || '')}</p><a href="${htmlEscape(actionUrl)}" style="display:inline-block;background:#f6c90e;color:#090a0c;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:800">Ouvrir DanaTrap RSX</a></div>`
      });
      await markNotificationEmail(notification, 'sent', { provider_id:result.id || '' });
      sent += 1;
    } catch (error) {
      failed += 1;
      try { await markNotificationEmail(notification, 'failed', { error:String(error.message || error).slice(0,500) }); } catch {}
    }
  }
  return { configured:true, sent, skipped, failed, pending:pending.length };
}

function extractDriveFileIds(value) {
  const ids = new Set();
  const visit = item => {
    if (!item) return;
    if (Array.isArray(item)) return item.forEach(visit);
    if (typeof item === 'object') {
      if (item.drive_id) ids.add(String(item.drive_id));
      if (item.id && (item.kind || item.name || item.mimeType)) ids.add(String(item.id));
      for (const nested of Object.values(item)) visit(nested);
      return;
    }
    if (typeof item === 'string') {
      const match = item.match(/\/(?:public-media|media)\/([^?/#]+)/);
      if (match) ids.add(decodeURIComponent(match[1]));
    }
  };
  visit(value);
  return [...ids].filter(Boolean);
}

async function setDriveTrash(fileId, trashed) {
  const token = await googleAccessToken();
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,trashed`, {
    method:'PATCH',
    headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
    body:JSON.stringify({ trashed:Boolean(trashed) })
  });
  if (!response.ok && response.status !== 404) throw new Error(`Drive trash ${response.status}`);
  return response.ok;
}

async function permanentlyDeleteDriveFile(fileId) {
  const token = await googleAccessToken();
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, { method:'DELETE', headers:{ Authorization:`Bearer ${token}` } });
  if (!response.ok && response.status !== 404) throw new Error(`Drive delete ${response.status}`);
  return response.ok;
}

async function performBackup(startedBy = null, scope = 'automatic') {
  const run = await rest('backup_runs', { method:'POST', headers:{Prefer:'return=representation'}, body:JSON.stringify({ started_by:startedBy, status:'running', scope, started_at:new Date().toISOString() }) });
  const id = run?.[0]?.id;
  try {
    const data = await exportData();
    const file = await uploadBackupToDrive(data);
    if (id) await rest(`backup_runs?id=eq.${encodeURIComponent(id)}`, { method:'PATCH', headers:{Prefer:'return=minimal'}, body:JSON.stringify({ status:'completed', manifest:{ drive_file:file, counts:Object.fromEntries(Object.entries(data.tables).map(([key,value])=>[key,Array.isArray(value)?value.length:0])) }, completed_at:new Date().toISOString() }) });
    return { ok:true, file, backupId:id };
  } catch (error) {
    if (id) await rest(`backup_runs?id=eq.${encodeURIComponent(id)}`, { method:'PATCH', headers:{Prefer:'return=minimal'}, body:JSON.stringify({ status:'failed', error_message:String(error.message || error).slice(0,1000), completed_at:new Date().toISOString() }) });
    throw error;
  }
}

async function runAutomaticBackup() {
  const rows = await rest('backup_runs?select=completed_at,status&status=eq.completed&order=completed_at.desc&limit=1');
  const last = rows?.[0]?.completed_at ? new Date(rows[0].completed_at).getTime() : 0;
  if (last && Date.now() - last < 24 * 3600_000) return { skipped:true, reason:'RECENT_BACKUP' };
  return performBackup(null, 'automatic');
}

async function purgeExpiredTrash() {
  const due = new Date().toISOString();
  const rows = await rest(`trash_items?select=*&restored_at=is.null&permanently_deleted_at=is.null&restore_until=lte.${encodeURIComponent(due)}&limit=50`);
  let purged = 0, failed = 0;
  for (const item of rows || []) {
    try {
      for (const fileId of extractDriveFileIds([item.drive_files, item.snapshot])) {
        try { await permanentlyDeleteDriveFile(fileId); } catch (error) { console.warn('[DanaTrap purge Drive]', fileId, error.message); }
      }
      if (item.entity_type === 'beat') {
        try { await rest(`beats?id=eq.${encodeURIComponent(item.entity_id)}`, { method:'DELETE', headers:{Prefer:'return=minimal'} }); } catch (error) { console.warn('[DanaTrap purge beat]', error.message); }
      }
      await rest(`trash_items?id=eq.${encodeURIComponent(item.id)}`, { method:'PATCH', headers:{Prefer:'return=minimal'}, body:JSON.stringify({ permanently_deleted_at:new Date().toISOString() }) });
      purged += 1;
    } catch (error) {
      failed += 1;
    }
  }
  return { purged, failed };
}

async function runReservationMaintenance() {
  let expired = null, reminders = null;
  try { expired = await rest('rpc/expire_reservations_v5', { method:'POST', body:'{}' }); } catch (error) { console.warn('[DanaTrap expiration]', error.message); }
  try { reminders = await rest('rpc/send_reservation_reminders_v5', { method:'POST', body:'{}' }); } catch (error) { console.warn('[DanaTrap rappels]', error.message); }
  return { expired, reminders };
}

async function runBackgroundJobs(source = 'server') {
  if (backgroundState.running) return { ok:true, skipped:true, reason:'ALREADY_RUNNING', ...backgroundState };
  backgroundState.running = true;
  const startedAt = new Date().toISOString();
  try {
    const reservation = await runReservationMaintenance();
    const emails = await processNotificationEmails();
    const backup = await runAutomaticBackup().catch(error => ({ ok:false, error:error.message }));
    const trash = await purgeExpiredTrash().catch(error => ({ purged:0, failed:1, error:error.message }));
    backgroundState.lastRunAt = new Date().toISOString();
    backgroundState.lastError = '';
    backgroundState.lastResult = { source, startedAt, reservation, emails, backup, trash };
    return { ok:true, ...backgroundState.lastResult };
  } catch (error) {
    backgroundState.lastRunAt = new Date().toISOString();
    backgroundState.lastError = String(error.message || error);
    return { ok:false, source, startedAt, error:backgroundState.lastError };
  } finally {
    backgroundState.running = false;
  }
}

const LEGAL_DEFAULTS=[
 {document_type:'terms',version:'1.0',title:'Conditions d’utilisation',content:'DanaTrap RSX est une plateforme de mise en relation musicale. Chaque membre reste responsable des contenus, fichiers, droits, licences et accords qu’il publie.',active:true},
 {document_type:'privacy',version:'1.0',title:'Politique de confidentialité',content:'Les données sont utilisées pour fournir les comptes, réservations, conversations, recommandations et fichiers. Elles ne sont pas vendues à des annonceurs.',active:true},
 {document_type:'community',version:'1.0',title:'Règles de la communauté',content:'Le respect des membres, des droits d’auteur et de la loi est obligatoire. Le spam, le harcèlement, les contenus frauduleux et les fichiers illégaux sont interdits.',active:true},
 {document_type:'storage',version:'1.0',title:'Stockage des fichiers',content:'Les fichiers importés sont stockés sur Google Drive. Ils peuvent être archivés, restaurés ou supprimés selon les règles de la plateforme.',active:true},
 {document_type:'license',version:'1.0',title:'Licences et accords',content:'Une réservation ouvre une discussion. Les conditions définitives sont celles acceptées entre les participants et consignées dans leur conversation.',active:true}
];
async function ensureLegalDocuments(){
 try{const existing=await rest('legal_documents?select=document_type,version&active=eq.true');const known=new Set((existing||[]).map(x=>`${x.document_type}:${x.version}`));const missing=LEGAL_DEFAULTS.filter(x=>!known.has(`${x.document_type}:${x.version}`));if(missing.length)await rest('legal_documents',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(missing)});}catch(error){console.warn('[DanaTrap legal seed]',error.message);}
}
async function accountExport(req,res){
 const user=await verifyUser(req),uid=encodeURIComponent(user.id);const tables={};
 const queries={profile:`profiles?user_id=eq.${uid}&select=*`,beats:`beats?producer_id=eq.${uid}&select=*`,reservations:`reservations?or=(artist_id.eq.${uid},beatmaker_id.eq.${uid})&select=*`,conversations:`conversation_members?user_id=eq.${uid}&select=conversation_id,joined_at`,messages:`messages?sender_id=eq.${uid}&select=*`,notifications:`notifications?user_id=eq.${uid}&select=*`,follows:`follows?or=(follower_id.eq.${uid},followed_id.eq.${uid})&select=*`,consents:`user_consents?user_id=eq.${uid}&select=*`};
 for(const [key,path] of Object.entries(queries)){try{tables[key]=await rest(path);}catch(error){tables[key]={error:error.message};}}
 return sendJson(req,res,200,{filename:`danatrap-rsx-mes-donnees-${Date.now()}.json`,mimeType:'application/json',content:JSON.stringify({exported_at:new Date().toISOString(),version:VERSION,user:{id:user.id,email:user.email},tables},null,2)});
}
async function requestAccountDeletion(req,res){
 const user=await verifyUser(req),{reason=''}=await readJson(req);const profiles=await rest(`profiles?user_id=eq.${encodeURIComponent(user.id)}&select=name`),name=profiles?.[0]?.name||user.email||user.id;
 await rest('admin_tasks',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({type:'account_deletion',title:`Demande de fermeture — ${name}`,description:String(reason||'Aucun motif fourni').slice(0,2000),priority:'high',status:'open',related_type:'profile',related_id:user.id})});
 await rest('notifications',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({user_id:user.id,type:'account',title:'Demande de fermeture reçue',body:'Dzl 971 examinera ta demande avant tout archivage ou suppression.',link:'#/app/parametres/donnees',payload:{requested_at:new Date().toISOString()}})});
 return sendJson(req,res,200,{ok:true});
}
async function requireAdmin(req){const user=await verifyUser(req);if(!(await isAdmin(user))){const e=new Error('Administrateur requis.');e.status=403;throw e;}return user;}
async function getBeatSnapshot(beatId){const rows=await rest(`beats?id=eq.${encodeURIComponent(beatId)}&select=*,licenses(*)`);return rows?.[0]||null;}
async function trashBeat(req,res){const user=await verifyUser(req);const {beatId}=await readJson(req);if(!beatId)return sendJson(req,res,400,{error:'Production manquante.'});const beat=await getBeatSnapshot(beatId);if(!beat)return sendJson(req,res,404,{error:'Production introuvable.'});if(String(beat.producer_id)!==String(user.id)&&!(await isAdmin(user)))return sendJson(req,res,403,{error:'Action non autorisée.'});const design={...(beat.design||{}),_trashed:true};const driveIds=extractDriveFileIds(beat);const driveWarnings=[];for(const fileId of driveIds){try{await setDriveTrash(fileId,true);}catch(error){driveWarnings.push({fileId,error:error.message});}}const trash=await rest('trash_items',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({entity_type:'beat',entity_id:beat.id,owner_id:beat.producer_id,deleted_by:user.id,snapshot:beat,drive_files:beat.files||[],restore_until:new Date(Date.now()+30*86400000).toISOString()})});await rest(`beats?id=eq.${encodeURIComponent(beat.id)}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({visibility:'Brouillon',design})});return sendJson(req,res,200,{ok:true,trash:trash?.[0]||null,driveTrashed:driveIds.length-driveWarnings.length,driveWarnings});}
async function restoreTrash(req,res){await requireAdmin(req);const {trashId}=await readJson(req);const rows=await rest(`trash_items?id=eq.${encodeURIComponent(trashId)}&select=*`);const item=rows?.[0];if(!item)return sendJson(req,res,404,{error:'Élément de corbeille introuvable.'});if(item.permanently_deleted_at)return sendJson(req,res,410,{error:'Le délai de restauration de 30 jours est dépassé.'});for(const fileId of extractDriveFileIds([item.drive_files,item.snapshot])){try{await setDriveTrash(fileId,false);}catch(error){console.warn('[DanaTrap restore Drive]',fileId,error.message);}}if(item.entity_type==='beat'){const snap={...(item.snapshot||{})};const licenses=snap.licenses||[];delete snap.licenses;delete snap.created_at;delete snap.updated_at;snap.design={...(snap.design||{})};delete snap.design._trashed;await rest(`beats?id=eq.${encodeURIComponent(item.entity_id)}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify(snap)});await rest(`licenses?beat_id=eq.${encodeURIComponent(item.entity_id)}`,{method:'DELETE'});if(licenses.length)await rest('licenses',{method:'POST',body:JSON.stringify(licenses.map(({id,...l})=>({...l,beat_id:item.entity_id})))});}await rest(`trash_items?id=eq.${encodeURIComponent(trashId)}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({restored_at:new Date().toISOString()})});return sendJson(req,res,200,{ok:true});}
async function driveAbout(){const token=await googleAccessToken();const response=await fetch('https://www.googleapis.com/drive/v3/about?fields=user,storageQuota',{headers:{Authorization:`Bearer ${token}`}});if(!response.ok)throw new Error(`Drive health ${response.status}`);return response.json();}
async function systemHealth(req,res){await requireAdmin(req);const started=Date.now();let supabase={ok:false},drive={ok:false},lastBackup=null;try{await rest('profiles?select=user_id&limit=1');supabase={ok:true};}catch(e){supabase={ok:false,error:e.message};}try{const about=await driveAbout();drive={ok:true,...about};}catch(e){drive={ok:false,error:e.message};}try{lastBackup=(await rest('backup_runs?select=status,completed_at,manifest&order=started_at.desc&limit=1'))?.[0]||null;}catch{}const email={configured:emailConfigured(),provider:emailConfigured()?'Resend':'Non configuré',from:process.env.EMAIL_FROM||''};const automation={last_run_at:backgroundState.lastRunAt,last_error:backgroundState.lastError,last_result:backgroundState.lastResult,last_backup:lastBackup};const result={ok:supabase.ok&&drive.ok,version:VERSION,supabase,drive,email,automation,response_time_ms:Date.now()-started,checked_at:new Date().toISOString()};try{await rest('system_health_checks',{method:'POST',body:JSON.stringify([{service:'Supabase',status:supabase.ok?'healthy':'error',response_time_ms:result.response_time_ms,details:supabase},{service:'Google Drive',status:drive.ok?'healthy':'error',response_time_ms:result.response_time_ms,details:drive},{service:'E-mail',status:email.configured?'healthy':'warning',response_time_ms:0,details:email},{service:'Automatisation',status:backgroundState.lastError?'error':'healthy',response_time_ms:0,details:automation}])});}catch{}return sendJson(req,res,200,result);}
async function exportData(){const tables=['profiles','beats','licenses','reservations','reservation_events','conversations','conversation_members','messages','notifications','announcements','collaboration_projects','reports','moderation_queue','admin_tasks','badges','profile_badges','site_settings','feature_flags'];const out={exported_at:new Date().toISOString(),version:VERSION,tables:{}};for(const table of tables){try{out.tables[table]=await rest(`${table}?select=*&limit=10000`);}catch(e){out.tables[table]={error:e.message};}}return out;}
function csvEscape(v){const value=typeof v==='object'?JSON.stringify(v):String(v??'');return `"${value.replaceAll('"','""')}"`;}
async function adminExport(req,res,url){await requireAdmin(req);const format=url.searchParams.get('format')==='csv'?'csv':'json';const data=await exportData();if(format==='json')return sendJson(req,res,200,{filename:`danatrap-rsx-export-${Date.now()}.json`,mimeType:'application/json',content:JSON.stringify(data,null,2)});const lines=['table,id,name,status,created_at'];for(const [table,rows] of Object.entries(data.tables)){if(!Array.isArray(rows))continue;for(const row of rows)lines.push([table,row.id||row.user_id||row.key||'',row.name||row.title||row.email||'',row.status||row.visibility||'',row.created_at||row.updated_at||''].map(csvEscape).join(','));}return sendJson(req,res,200,{filename:`danatrap-rsx-export-${Date.now()}.csv`,mimeType:'text/csv',content:lines.join('\n')});}
async function uploadBackupToDrive(payload){const token=await googleAccessToken();const boundary=`drsx_${crypto.randomBytes(10).toString('hex')}`;const name=`DanaTrap-RSX-backup-${new Date().toISOString().replaceAll(':','-')}.json`;const meta={name,parents:[folderFor('private')],mimeType:'application/json',appProperties:{danatrap:'true',kind:'backup',version:VERSION}};const body=Buffer.concat([Buffer.from(`--${boundary}
Content-Type: application/json; charset=UTF-8

${JSON.stringify(meta)}
--${boundary}
Content-Type: application/json

`),Buffer.from(JSON.stringify(payload,null,2)),Buffer.from(`
--${boundary}--`)]);const response=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,createdTime',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':`multipart/related; boundary=${boundary}`},body});if(!response.ok)throw new Error(`Sauvegarde Drive refusée (${response.status})`);return response.json();}
async function adminBackup(req,res){const admin=await requireAdmin(req);return sendJson(req,res,200,await performBackup(admin.id,'manual'));}

async function requestVerification(req,res){const user=await verifyUser(req);const {message=''}=await readJson(req);const rows=await rest('moderation_queue',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({source_type:'verification_request',source_id:user.id,reason:'Demande de certification',severity:'low',status:'pending',payload:{message,profile_id:user.id}})});return sendJson(req,res,200,{ok:true,request:rows?.[0]||null});}
async function verifyProfileAdmin(req,res){const admin=await requireAdmin(req);const {userId,moderationId}=await readJson(req);if(!userId)return sendJson(req,res,400,{error:'Profil manquant.'});await rest(`profiles?user_id=eq.${encodeURIComponent(userId)}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({verified:true})});const badges=await rest('badges?slug=eq.verified&select=id');if(badges?.[0])await rest('profile_badges',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({user_id:userId,badge_id:badges[0].id,assigned_by:admin.id})});if(moderationId)await rest(`moderation_queue?id=eq.${encodeURIComponent(moderationId)}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({status:'approved',reviewed_by:admin.id,reviewed_at:new Date().toISOString()})});return sendJson(req,res,200,{ok:true});}
async function setUserRoles(req,res){await requireAdmin(req);const {userId,roles,isAdmin:adminFlag}=await readJson(req);const allowed=['Beatmaker','Artiste','Producteur','Ingénieur du son','Manager'];const clean=[...new Set((Array.isArray(roles)?roles:[]).filter(x=>allowed.includes(x)))];if(!userId||!clean.length)return sendJson(req,res,400,{error:'Utilisateur et rôle requis.'});await rest(`profiles?user_id=eq.${encodeURIComponent(userId)}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({roles:clean,is_admin:Boolean(adminFlag),role:adminFlag?'Admin':clean[0]})});return sendJson(req,res,200,{ok:true});}
async function resolveErrorAdmin(req,res){const admin=await requireAdmin(req);const {errorId}=await readJson(req);if(!errorId)return sendJson(req,res,400,{error:'Erreur manquante.'});await rest(`error_logs?id=eq.${encodeURIComponent(errorId)}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({resolved:true,resolved_at:new Date().toISOString(),resolved_by:admin.id})});return sendJson(req,res,200,{ok:true});}


async function requireBeatAccess(req,beatId){
  const user=await verifyUser(req),beat=await getBeatSnapshot(beatId);
  if(!beat){const e=new Error('Production introuvable.');e.status=404;throw e;}
  if(String(beat.producer_id)!==String(user.id)&&!(await isAdmin(user))){const e=new Error('Action non autorisée.');e.status=403;throw e;}
  return {user,beat};
}
async function createBeatVersion(req,res){
  const {beatId,label='Sauvegarde automatique'}=await readJson(req);if(!beatId)return sendJson(req,res,400,{error:'Production manquante.'});
  const {user,beat}=await requireBeatAccess(req,beatId);
  const rows=await rest('trash_items',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({entity_type:'beat_version',entity_id:beat.id,owner_id:beat.producer_id,deleted_by:user.id,snapshot:{beat,licenses:beat.licenses||[],label:String(label).slice(0,200)},drive_files:beat.files||[],restore_until:new Date(Date.now()+365*86400000).toISOString()})});
  try{await rest('audit_logs',{method:'POST',body:JSON.stringify({actor_id:user.id,action:'beat.version.create',entity_type:'beat',entity_id:beat.id,after_data:{version_id:rows?.[0]?.id,label}})});}catch{}
  return sendJson(req,res,200,{ok:true,version:rows?.[0]||null});
}
async function listBeatVersions(req,res,url){
  const beatId=url.searchParams.get('beatId');if(!beatId)return sendJson(req,res,400,{error:'Production manquante.'});
  await requireBeatAccess(req,beatId);
  const rows=await rest(`trash_items?entity_type=eq.beat_version&entity_id=eq.${encodeURIComponent(beatId)}&select=*&order=created_at.desc&limit=50`);
  return sendJson(req,res,200,{versions:rows||[]});
}
async function restoreBeatVersion(req,res){
  const {versionId}=await readJson(req);if(!versionId)return sendJson(req,res,400,{error:'Version manquante.'});
  const rows=await rest(`trash_items?id=eq.${encodeURIComponent(versionId)}&entity_type=eq.beat_version&select=*`),item=rows?.[0];
  if(!item)return sendJson(req,res,404,{error:'Version introuvable.'});
  const snap=item.snapshot?.beat||item.snapshot||{},beatId=snap.id||item.entity_id;
  const {user,beat:current}=await requireBeatAccess(req,beatId);
  await rest('trash_items',{method:'POST',body:JSON.stringify({entity_type:'beat_version',entity_id:current.id,owner_id:current.producer_id,deleted_by:user.id,snapshot:{beat:current,licenses:current.licenses||[],label:'Avant restauration'},drive_files:current.files||[],restore_until:new Date(Date.now()+365*86400000).toISOString()})});
  const licenses=item.snapshot?.licenses||snap.licenses||[];const payload={...snap};delete payload.id;delete payload.licenses;delete payload.created_at;delete payload.updated_at;
  await rest(`beats?id=eq.${encodeURIComponent(beatId)}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify(payload)});
  await rest(`licenses?beat_id=eq.${encodeURIComponent(beatId)}`,{method:'DELETE'});
  if(licenses.length)await rest('licenses',{method:'POST',body:JSON.stringify(licenses.map(({id,created_at,...license},index)=>({...license,beat_id:beatId,sort_order:license.sort_order??index})))});
  try{await rest('audit_logs',{method:'POST',body:JSON.stringify({actor_id:user.id,action:'beat.version.restore',entity_type:'beat',entity_id:beatId,before_data:current,after_data:snap,metadata:{version_id:versionId}})});}catch{}
  return sendJson(req,res,200,{ok:true,beat:await getBeatSnapshot(beatId)});
}
function pdfEscape(value=''){return String(value).replaceAll('\\','\\\\').replaceAll('(','\\(').replaceAll(')','\\)').replace(/[^\x20-\xFF]/g,'?');}
function wrapPdfLine(text,max=88){const words=String(text||'').split(/\s+/),lines=[];let line='';for(const word of words){if((line+' '+word).trim().length>max){if(line)lines.push(line);line=word;}else line=(line+' '+word).trim();}if(line)lines.push(line);return lines;}
function buildSimplePdf(lines){
  const content=[];let y=800;
  for(const entry of lines){const size=entry.size||11,bold=entry.bold?'F2':'F1';for(const line of wrapPdfLine(entry.text||'',entry.max||88)){content.push(`BT /${bold} ${size} Tf 50 ${y} Td (${pdfEscape(line)}) Tj ET`);y-=entry.gap||Math.round(size*1.55);if(y<60)y=800;}if(entry.after)y-=entry.after;}
  const stream=Buffer.from(content.join('\n'),'latin1');
  const objects=[
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>','latin1'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>','latin1'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>','latin1'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>','latin1'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>','latin1'),
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`,'latin1'),stream,Buffer.from('\nendstream','latin1')])
  ];
  const parts=[Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n','latin1')],offsets=[0];
  for(let i=0;i<objects.length;i++){offsets.push(Buffer.concat(parts).length);parts.push(Buffer.from(`${i+1} 0 obj\n`,'latin1'),objects[i],Buffer.from('\nendobj\n','latin1'));}
  const xref=Buffer.concat(parts).length;let table=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;for(let i=1;i<offsets.length;i++)table+=`${String(offsets[i]).padStart(10,'0')} 00000 n \n`;
  parts.push(Buffer.from(table+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`,'latin1'));
  return Buffer.concat(parts);
}
async function reservationAgreement(req,res,url){
  const user=await verifyUser(req),id=url.searchParams.get('reservationId');if(!id)return sendJson(req,res,400,{error:'Réservation manquante.'});
  const reservations=await rest(`reservations?id=eq.${encodeURIComponent(id)}&select=*`),reservation=reservations?.[0];if(!reservation)return sendJson(req,res,404,{error:'Réservation introuvable.'});
  if(![reservation.artist_id,reservation.beatmaker_id].map(String).includes(String(user.id))&&!(await isAdmin(user)))return sendJson(req,res,403,{error:'Document inaccessible.'});
  const [beatRows,artistRows,makerRows,events]=await Promise.all([
    rest(`beats?id=eq.${encodeURIComponent(reservation.beat_id)}&select=*,licenses(*)`),
    rest(`profiles?user_id=eq.${encodeURIComponent(reservation.artist_id)}&select=name,username`),
    rest(`profiles?user_id=eq.${encodeURIComponent(reservation.beatmaker_id)}&select=name,username`),
    rest(`reservation_events?reservation_id=eq.${encodeURIComponent(id)}&select=*&order=created_at.asc`)
  ]);
  const beat=beatRows?.[0]||{},artist=artistRows?.[0]||{},maker=makerRows?.[0]||{},rights=beat.design?.rights||{};
  const lines=[
    {text:'DanaTrap RSX',size:22,bold:true,gap:30},{text:'Récapitulatif de réservation et accord',size:16,bold:true,after:12},
    {text:`Document généré le ${new Date().toLocaleString('fr-FR')}`,size:9,after:12},
    {text:`Production : ${beat.title||'Production'}`,size:13,bold:true},{text:`Beatmaker : ${maker.name||beat.producer_name||reservation.beatmaker_id}`},{text:`Artiste : ${artist.name||reservation.artist_id}`},{text:`Licence : ${reservation.license_name}`},{text:`Statut : ${reservation.status}`},{text:`Réservation créée le : ${new Date(reservation.created_at).toLocaleString('fr-FR')}`,after:14},
    {text:'Crédits et droits',size:13,bold:true},{text:`Crédit public : ${rights.creditLine||`Prod. ${beat.producer_name||maker.name||''}`}`},{text:`Compositeur : ${rights.composer||maker.name||''}`},{text:`Auteurs : ${rights.authors||artist.name||''}`},{text:`Éditeur : ${rights.publisher||'Non renseigné'}`},{text:`IPI : ${rights.ipi||'Non renseigné'}`},{text:`Répartition beatmaker : ${rights.splitProducer??'Non renseignée'} %`},{text:`Répartition artiste : ${rights.splitArtist??'Non renseignée'} %`},{text:`Notes : ${rights.notes||'Aucune'}`,after:14},
    {text:'Historique de la réservation',size:13,bold:true},
    ...(events||[]).map(event=>({text:`${new Date(event.created_at).toLocaleString('fr-FR')} — ${event.event_type||event.status||'Mise à jour'} ${event.payload?.reason?`: ${event.payload.reason}`:''}`,size:9})),
    {text:'Ce document récapitule les informations enregistrées sur DanaTrap RSX. Les conditions définitives restent celles acceptées par les participants dans leur conversation.',size:8,after:8}
  ];
  const pdf=buildSimplePdf(lines),filename=`DanaTrap-RSX-${String(beat.slug||beat.title||'accord').replace(/[^a-z0-9-]+/gi,'-')}-${id.slice(0,8)}.pdf`;
  applyHeaders(req,res);res.statusCode=200;res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Length',String(pdf.length));res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);res.setHeader('Cache-Control','private, no-store');return res.end(pdf);
}


function invoiceTotalsServer(invoice={}){const subtotal=(invoice.items||[]).reduce((sum,item)=>sum+(Number(item.quantity)||0)*(Number(item.unit_price)||0),0),discount=Math.max(0,Number(invoice.discount)||0),total=Math.max(0,subtotal-discount);return{subtotal,discount,total};}
function driveQueryEscape(value=''){return String(value).replaceAll('\\','\\\\').replaceAll("'","\\'");}
function invoiceFileProperties(invoice,userId){const totals=invoiceTotalsServer(invoice);return{danatrap:'true',kind:'invoice',owner_id:String(userId),invoice_id:String(invoice.id),invoice_number:String(invoice.invoice_number||'Facture').slice(0,120),status:String(invoice.status||'Brouillon').slice(0,60),client_name:String(invoice.client?.name||'').slice(0,120),total:String(totals.total),issue_date:String(invoice.issue_date||'').slice(0,20)};}
function normalizeInvoicePayload(payload={},user){const existingCreated=payload.created_at||new Date().toISOString(),id=String(payload.id||crypto.randomUUID()),cleanImage=value=>{const text=String(value||'').trim();if(/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(text)&&text.length<420000)return text;if(/^https?:\/\//i.test(text)&&text.length<2200)return text;return'';};const items=Array.isArray(payload.items)?payload.items.slice(0,40).map(item=>({designation:String(item.designation||'').slice(0,240),license:String(item.license||'').slice(0,160),quantity:Math.max(1,Math.min(999,Number(item.quantity)||1)),unit_price:Math.max(0,Math.min(10000000,Number(item.unit_price)||0))})).filter(item=>item.designation||item.unit_price):[];return{id,drive_file_id:String(payload.drive_file_id||''),owner_id:String(user.id),invoice_number:String(payload.invoice_number||`DRSX-${Date.now()}`).slice(0,120),issue_date:String(payload.issue_date||new Date().toISOString().slice(0,10)).slice(0,20),status:['Brouillon','Envoyée','Payée','Annulée'].includes(payload.status)?payload.status:'Brouillon',seller:{name:String(payload.seller?.name||user.email||'Vendeur').slice(0,180),email:String(payload.seller?.email||'').slice(0,240),social:String(payload.seller?.social||'').slice(0,180),address:String(payload.seller?.address||'').slice(0,500)},client:{name:String(payload.client?.name||'').slice(0,180),email:String(payload.client?.email||'').slice(0,240),address:String(payload.client?.address||'').slice(0,500)},items,discount:Math.max(0,Math.min(10000000,Number(payload.discount)||0)),payment:{paid_amount:Math.max(0,Math.min(10000000,Number(payload.payment?.paid_amount)||0)),paid_date:String(payload.payment?.paid_date||'').slice(0,20),next_amount:Math.max(0,Math.min(10000000,Number(payload.payment?.next_amount)||0)),next_due:String(payload.payment?.next_due||'').slice(0,180)},attestation:String(payload.attestation||'').slice(0,7000),legal_note:String(payload.legal_note||'').slice(0,2000),manager:{enabled:Boolean(payload.manager?.enabled),name:String(payload.manager?.name||'').slice(0,180)},photo:cleanImage(payload.photo),seller_signature:cleanImage(payload.seller_signature),manager_signature:cleanImage(payload.manager_signature),show_dantrap_logo:payload.show_dantrap_logo!==false,footer_text:String(payload.footer_text||'Document faisant foi de facture et d’attestation de livraison des instrumentales.').slice(0,500),created_at:existingCreated,updated_at:new Date().toISOString()};}
async function driveInvoiceMetadata(token,fileId){const response=await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,createdTime,modifiedTime,appProperties,trashed`,{headers:{Authorization:`Bearer ${token}`}});if(!response.ok){const error=new Error(response.status===404?'Facture introuvable.':`Drive facture ${response.status}`);error.status=response.status===404?404:502;throw error;}return response.json();}
async function ensureInvoiceAccess(user,metadata){const owner=metadata?.appProperties?.owner_id;if(String(owner)!==String(user.id)&&!(await isAdmin(user))){const error=new Error('Facture inaccessible.');error.status=403;throw error;}return true;}
async function readInvoiceDriveFile(user,fileId){const token=await googleAccessToken(),metadata=await driveInvoiceMetadata(token,fileId);await ensureInvoiceAccess(user,metadata);const response=await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,{headers:{Authorization:`Bearer ${token}`}});if(!response.ok){const error=new Error('Lecture de la facture impossible.');error.status=502;throw error;}const invoice=await response.json();return{...invoice,drive_file_id:fileId,created_at:invoice.created_at||metadata.createdTime,updated_at:invoice.updated_at||metadata.modifiedTime};}
async function listInvoicesApi(req,res){const user=await verifyUser(req),token=await googleAccessToken(),admin=await isAdmin(user),folder=folderFor('private');const clauses=[`'${driveQueryEscape(folder)}' in parents`,`trashed = false`,`appProperties has { key='danatrap' and value='true' }`,`appProperties has { key='kind' and value='invoice' }`];if(!admin)clauses.push(`appProperties has { key='owner_id' and value='${driveQueryEscape(user.id)}' }`);const params=new URLSearchParams({q:clauses.join(' and '),fields:'files(id,name,createdTime,modifiedTime,appProperties)',orderBy:'modifiedTime desc',pageSize:'500'}),response=await fetch(`https://www.googleapis.com/drive/v3/files?${params}`,{headers:{Authorization:`Bearer ${token}`}});if(!response.ok){const error=new Error(`Liste des factures refusée (${response.status}).`);error.status=502;throw error;}const files=(await response.json()).files||[],invoices=files.map(file=>({drive_file_id:file.id,id:file.appProperties?.invoice_id||file.id,invoice_number:file.appProperties?.invoice_number||file.name,status:file.appProperties?.status||'Brouillon',client_name:file.appProperties?.client_name||'',total:Number(file.appProperties?.total)||0,issue_date:file.appProperties?.issue_date||file.createdTime,created_at:file.createdTime,updated_at:file.modifiedTime,owner_id:file.appProperties?.owner_id||''}));return sendJson(req,res,200,{invoices});}
async function getInvoiceApi(req,res,fileId){const user=await verifyUser(req),invoice=await readInvoiceDriveFile(user,fileId);return sendJson(req,res,200,{invoice});}
async function saveInvoiceApi(req,res){const user=await verifyUser(req),payload=await readJson(req),invoice=normalizeInvoicePayload(payload,user),token=await googleAccessToken(),fileId=String(payload.drive_file_id||'').trim();if(fileId){const metadata=await driveInvoiceMetadata(token,fileId);await ensureInvoiceAccess(user,metadata);invoice.created_at=payload.created_at||metadata.createdTime||invoice.created_at;}const totals=invoiceTotalsServer(invoice),properties=invoiceFileProperties(invoice,user.id),safeNumber=String(invoice.invoice_number||invoice.id).replace(/[^a-z0-9._-]+/gi,'-').slice(0,100),meta={name:`DanaTrap-RSX-Facture-${safeNumber}.json`,mimeType:'application/json',appProperties:properties,...(fileId?{}:{parents:[folderFor('private')]})},boundary=`drsx_invoice_${crypto.randomBytes(8).toString('hex')}`,content=Buffer.from(JSON.stringify({...invoice,totals},null,2),'utf8'),body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`),content,Buffer.from(`\r\n--${boundary}--`)]),endpoint=fileId?`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=id,name,createdTime,modifiedTime,appProperties`:'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,createdTime,modifiedTime,appProperties',response=await fetch(endpoint,{method:fileId?'PATCH':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':`multipart/related; boundary=${boundary}`},body});if(!response.ok){const details=await response.text();const error=new Error(`Enregistrement Drive refusé (${response.status}) : ${details.slice(0,180)}`);error.status=502;throw error;}const saved=await response.json();try{await rest('audit_logs',{method:'POST',body:JSON.stringify({actor_id:user.id,action:fileId?'invoice.update':'invoice.create',entity_type:'invoice',entity_id:invoice.id,after_data:{invoice_number:invoice.invoice_number,status:invoice.status,total:totals.total,drive_file_id:saved.id}})});}catch{}return sendJson(req,res,fileId?200:201,{invoice:{...invoice,totals,drive_file_id:saved.id,created_at:invoice.created_at||saved.createdTime,updated_at:saved.modifiedTime}});}
async function deleteInvoiceApi(req,res,fileId){const user=await verifyUser(req),token=await googleAccessToken(),metadata=await driveInvoiceMetadata(token,fileId);await ensureInvoiceAccess(user,metadata);const response=await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,{method:'PATCH',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({trashed:true})});if(!response.ok){const error=new Error('Suppression de la facture impossible.');error.status=502;throw error;}try{await rest('audit_logs',{method:'POST',body:JSON.stringify({actor_id:user.id,action:'invoice.delete',entity_type:'invoice',entity_id:metadata.appProperties?.invoice_id||fileId,before_data:{invoice_number:metadata.appProperties?.invoice_number,drive_file_id:fileId}})});}catch{}return sendJson(req,res,200,{ok:true});}

const server = http.createServer(async (req, res) => {
  applyHeaders(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (!rateAllowed(req, 'global')) return sendJson(req, res, 429, { error: 'Trop de requêtes. Réessaie dans une minute.' });

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && ['/health','/api/v1/health'].includes(url.pathname)) {
      return sendJson(req, res, 200, { ok: true, service: 'DanaTrap RSX Render API', version: VERSION, configured: missingEnv.length === 0, missing: missingEnv });
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/invoices') return await listInvoicesApi(req,res);
    if (req.method === 'POST' && url.pathname === '/api/v1/invoices') return await saveInvoiceApi(req,res);
    if (url.pathname.startsWith('/api/v1/invoices/')) { const invoiceFileId=decodeURIComponent(url.pathname.slice('/api/v1/invoices/'.length)); if(req.method==='GET')return await getInvoiceApi(req,res,invoiceFileId); if(req.method==='DELETE')return await deleteInvoiceApi(req,res,invoiceFileId); }
    if (req.method === 'GET' && url.pathname === '/api/v1/account/export') return await accountExport(req,res);
    if (req.method === 'POST' && url.pathname === '/api/v1/account/delete-request') return await requestAccountDeletion(req,res);
    if (['GET','POST'].includes(req.method) && url.pathname === '/api/v1/jobs/tick') {
      if (!rateAllowed(req, 'background-jobs', 12, 60 * 60_000)) return sendJson(req,res,429,{error:'Automatisation déjà sollicitée récemment.'});
      return sendJson(req,res,200,await runBackgroundJobs('http'));
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
    if (req.method === 'POST' && url.pathname === '/admin/reset-password') {
      if (!rateAllowed(req, 'admin', 30)) return sendJson(req, res, 429, { error: 'Trop de requêtes administrateur.' });
      return await resetUserPassword(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/admin/send-recovery-link') {
      if (!rateAllowed(req, 'admin', 30)) return sendJson(req, res, 429, { error: 'Trop de requêtes administrateur.' });
      return await sendRecoveryLink(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/admin/delete-user') {
      if (!rateAllowed(req, 'admin', 30)) return sendJson(req, res, 429, { error: 'Trop de requêtes administrateur.' });
      return await deleteUser(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/beats/version') return await createBeatVersion(req,res);
    if (req.method === 'GET' && url.pathname === '/beats/versions') return await listBeatVersions(req,res,url);
    if (req.method === 'POST' && url.pathname === '/beats/version/restore') return await restoreBeatVersion(req,res);
    if (req.method === 'GET' && url.pathname === '/reservations/agreement') return await reservationAgreement(req,res,url);
    if (req.method === 'POST' && url.pathname === '/beats/trash') {
      if (!rateAllowed(req, 'trash', 30)) return sendJson(req,res,429,{error:'Trop de suppressions.'});
      return await trashBeat(req,res);
    }
    if (req.method === 'POST' && url.pathname === '/admin/trash/restore') return await restoreTrash(req,res);
    if (req.method === 'GET' && url.pathname === '/admin/system-health') return await systemHealth(req,res);
    if (req.method === 'GET' && url.pathname === '/admin/export') return await adminExport(req,res,url);
    if (req.method === 'POST' && url.pathname === '/admin/backup') return await adminBackup(req,res);
    if (req.method === 'POST' && url.pathname === '/verification-request') return await requestVerification(req,res);
    if (req.method === 'POST' && url.pathname === '/admin/verify-profile') return await verifyProfileAdmin(req,res);
    if (req.method === 'POST' && url.pathname === '/admin/set-roles') return await setUserRoles(req,res);
    if (req.method === 'POST' && url.pathname === '/admin/error/resolve') return await resolveErrorAdmin(req,res);
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
server.listen(PORT, '0.0.0.0', () => {console.log(`[DanaTrap RSX] API démarrée sur le port ${PORT}`);setTimeout(()=>ensureLegalDocuments(),1500);setTimeout(()=>runBackgroundJobs('startup').catch(()=>{}),20_000);});
setInterval(()=>runBackgroundJobs('interval').catch(error=>console.warn('[DanaTrap jobs]',error.message)),15*60_000).unref();
