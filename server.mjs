import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const scrypt = promisify(scryptCallback);
const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname);
const publicDir = join(root, 'public');
const dataDir = resolve(process.env.PAPERLEAF_DATA_DIR || join(root, '..', 'data'));
// Keep article files outside a versioned application directory so upgrades do not move user content.
const archiveDir = resolve(process.env.PAPERLEAF_ARCHIVE_DIR || join(root, '..', 'Library'));
const port = Number(process.env.PORT || 3080);
const host = process.env.HOST || '127.0.0.1';
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, 'paperleaf.sqlite'));
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

const tokenKeyPath = join(dataDir, 'token-encryption.key');
const tokenEncryptionKey = createHash('sha256').update(process.env.PAPERLEAF_TOKEN_ENCRYPTION_KEY || (existsSync(tokenKeyPath) ? readFileSync(tokenKeyPath, 'utf8').trim() : (() => { const key = randomBytes(32).toString('base64url'); writeFileSync(tokenKeyPath, key, { mode: 0o600 }); return key; })())).digest();

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${randomBytes(12).toString('hex')}`;
const tokenHash = (value) => createHash('sha256').update(value).digest('hex');
const encryptToken = (value) => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', tokenEncryptionKey, iv); const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`; };
const decryptToken = (value) => { if (!value) return null; try { const [ivValue, tagValue, encryptedValue] = value.split('.'); const decipher = createDecipheriv('aes-256-gcm', tokenEncryptionKey, Buffer.from(ivValue, 'base64url')); decipher.setAuthTag(Buffer.from(tagValue, 'base64url')); return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8'); } catch { return null; } };
const json = (value) => JSON.stringify(value ?? null);
const parse = (value, fallback = []) => { try { return JSON.parse(value ?? ''); } catch { return fallback; } };
const html = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, url TEXT NOT NULL, normalized_url TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', html_snapshot TEXT NOT NULL DEFAULT '', fetch_status TEXT NOT NULL, fetch_error TEXT, is_read INTEGER NOT NULL DEFAULT 0, is_archived INTEGER NOT NULL DEFAULT 0, is_favorite INTEGER NOT NULL DEFAULT 0, reading_progress REAL NOT NULL DEFAULT 0, last_opened_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(user_id, normalized_url));
    CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(user_id, name));
    CREATE TABLE IF NOT EXISTS item_tags (item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(item_id, tag_id));
    CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE(user_id, name));
    CREATE TABLE IF NOT EXISTS item_folders (item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE, PRIMARY KEY(item_id, folder_id));
    CREATE TABLE IF NOT EXISTS highlights (id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, text TEXT NOT NULL, note_title TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT 'yellow', start_offset INTEGER, end_offset INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS api_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT);
    CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, target_id TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS user_preferences (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, homepage_view TEXT NOT NULL DEFAULT 'list', reader_display TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS timeline_events (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, item_id TEXT NOT NULL, highlight_id TEXT, event_type TEXT NOT NULL, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  const itemColumns = db.prepare('PRAGMA table_info(items)').all().map((column) => column.name);
  if (!itemColumns.includes('reading_progress')) db.exec('ALTER TABLE items ADD COLUMN reading_progress REAL NOT NULL DEFAULT 0');
  if (!itemColumns.includes('last_opened_at')) db.exec('ALTER TABLE items ADD COLUMN last_opened_at TEXT');
  if (!itemColumns.includes('archive_folder')) db.exec("ALTER TABLE items ADD COLUMN archive_folder TEXT NOT NULL DEFAULT ''");
  const highlightColumns = db.prepare('PRAGMA table_info(highlights)').all().map((column) => column.name);
  if (!highlightColumns.includes('start_offset')) db.exec('ALTER TABLE highlights ADD COLUMN start_offset INTEGER');
  if (!highlightColumns.includes('end_offset')) db.exec('ALTER TABLE highlights ADD COLUMN end_offset INTEGER');
  if (!highlightColumns.includes('updated_at')) {
    db.exec('ALTER TABLE highlights ADD COLUMN updated_at TEXT');
    db.exec('UPDATE highlights SET updated_at=created_at WHERE updated_at IS NULL');
  }
  if (!highlightColumns.includes('note_title')) {
    db.exec("ALTER TABLE highlights ADD COLUMN note_title TEXT NOT NULL DEFAULT ''");
    // Existing written notes remain searchable after upgrade; plain highlights remain outside the notes workspace.
    db.exec("UPDATE highlights SET note_title=substr(trim(note),1,120) WHERE trim(note) <> '' AND trim(note_title) = ''");
  }
  const tokenColumns = db.prepare('PRAGMA table_info(api_tokens)').all().map((column) => column.name);
  if (!tokenColumns.includes('token_ciphertext')) db.exec('ALTER TABLE api_tokens ADD COLUMN token_ciphertext TEXT');
  db.prepare('DELETE FROM api_tokens WHERE revoked_at IS NOT NULL').run();
  db.exec('CREATE INDEX IF NOT EXISTS idx_highlights_item_updated_at ON highlights(item_id, updated_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_timeline_events_user_occurred_at ON timeline_events(user_id, occurred_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_timeline_events_item_occurred_at ON timeline_events(item_id, occurred_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_timeline_events_highlight_occurred_at ON timeline_events(highlight_id, occurred_at DESC)');
  // Deletion is destructive to an article's reading trail: do not retain orphan entries.
  db.exec(`DELETE FROM timeline_events
    WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.id=timeline_events.item_id AND i.user_id=timeline_events.user_id)
       OR (highlight_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM highlights h WHERE h.id=timeline_events.highlight_id))`);
  // Backfill only timestamps that already exist on the underlying records.
  db.prepare(`INSERT INTO timeline_events (id,user_id,item_id,event_type,occurred_at,created_at)
    SELECT 'evt_backfill_item_' || i.id, i.user_id, i.id, 'item_created', i.created_at, i.created_at
    FROM items i WHERE NOT EXISTS (SELECT 1 FROM timeline_events e WHERE e.item_id=i.id AND e.event_type='item_created' AND e.occurred_at=i.created_at)`).run();
  db.prepare(`INSERT INTO timeline_events (id,user_id,item_id,highlight_id,event_type,occurred_at,created_at)
    SELECT 'evt_backfill_highlight_' || h.id, i.user_id, h.item_id, h.id, 'highlight_created', h.created_at, h.created_at
    FROM highlights h JOIN items i ON i.id=h.item_id
    WHERE NOT EXISTS (SELECT 1 FROM timeline_events e WHERE e.highlight_id=h.id AND e.event_type='highlight_created' AND e.occurred_at=h.created_at)`).run();
}

async function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${Buffer.from(derived).toString('hex')}`;
}
async function passwordMatches(password, stored) {
  const [, salt, expected] = stored.split('$');
  if (!salt || !expected) return false;
  const actual = Buffer.from(await scrypt(password, salt, 64)).toString('hex');
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

async function seed() {
  const existing = db.prepare('SELECT id FROM users LIMIT 1').get();
  if (existing) return;
  const password = process.env.PAPERLEAF_ADMIN_PASSWORD || 'admin123';
  const time = now();
  db.prepare('INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id('usr'), process.env.PAPERLEAF_ADMIN_USER || 'admin', await passwordHash(password), 'admin', time, time);
  console.log(`PaperLeaf initialized. Sign in as ${process.env.PAPERLEAF_ADMIN_USER || 'admin'} and change the initial password.`);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
function ok(res, data, status = 200, headers) { send(res, status, { data }, headers); }
function fail(res, status, code, message) { send(res, status, { error: { code, message } }); }
function cookies(req) { return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((part) => { const index = part.indexOf('='); return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]; })); }
function setCookie(res, value) { res.setHeader('Set-Cookie', `pl_session=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`); }
function clearCookie(res) { res.setHeader('Set-Cookie', 'pl_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); }
function readBody(req) { return new Promise((resolveBody, reject) => { let body = ''; req.on('data', (chunk) => { body += chunk; if (body.length > 2_000_000) req.destroy(); }); req.on('end', () => { try { resolveBody(body ? JSON.parse(body) : {}); } catch { reject(new Error('请求体必须是 JSON。')); } }); req.on('error', reject); }); }
function unwrapWechatArticleUrl(input) {
  const parsed = new URL(input);
  if (parsed.hostname.toLowerCase() !== 'mp.weixin.qq.com' || parsed.pathname !== '/mp/wappoc_appmsgcaptcha') return parsed.toString();
  const target = parsed.searchParams.get('target_url');
  if (!target) return parsed.toString();
  const article = new URL(target);
  return article.hostname.toLowerCase() === 'mp.weixin.qq.com' && article.pathname.startsWith('/s/') ? article.toString() : parsed.toString();
}
function normalizedUrl(input) { const parsed = new URL(unwrapWechatArticleUrl(input)); parsed.hash = ''; parsed.hostname = parsed.hostname.toLowerCase(); if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('仅支持 http 或 https 链接。'); return parsed.toString(); }
function publicUrl(input) {
  const parsed = new URL(input);
  const blocked = /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|::1$|fc|fd)/i;
  if (blocked.test(parsed.hostname)) throw new Error('不允许抓取本机或私有网络地址。');
  return parsed;
}
const pageHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache'
};
function isVerificationPage(source, pageUrl) {
  const host = new URL(pageUrl).hostname.toLowerCase();
  if (host !== 'mp.weixin.qq.com') return false;
  return /wappoc_appmsgcaptcha|环境异常|完成验证后即可继续访问|去验证/i.test(source);
}
async function fetchPage(input) {
  let url = publicUrl(unwrapWechatArticleUrl(input)).toString();
  for (let redirects = 0; redirects < 4; redirects += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    let response;
    try { response = await fetch(url, { redirect: 'manual', signal: controller.signal, headers: pageHeaders }); }
    catch (error) {
      if (error?.cause?.code === 'EACCES') throw new Error('当前运行环境禁止访问外网（EACCES），无法抓取网页内容；请检查网络权限、代理或在可出网的 NAS 上运行。');
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw new Error('网页抓取超时，请稍后重试或打开原文链接。');
      throw error;
    }
    finally { clearTimeout(timeout); }
    if ([301, 302, 303, 307, 308].includes(response.status)) { url = publicUrl(new URL(response.headers.get('location'), url).toString()).toString(); continue; }
    if (!response.ok) throw new Error(`网页返回 HTTP ${response.status}。`);
    if (!response.headers.get('content-type')?.includes('text/html')) throw new Error('目标不是可保存的 HTML 网页。');
    const source = await response.text();
    if (isVerificationPage(source, url)) throw new Error('目标站要求浏览器验证，未保存验证页。请使用原始文章链接重试；微信公众号内容仅支持公开页面和已授权来源。');
    const page = sanitizeDocument(source, url);
    if (!page.textLength && !page.imageCount) throw new Error('网页未提供可提取的正文或图片，可能需要 JavaScript 渲染或登录。');
    return { url, ...page };
  }
  throw new Error('重定向次数过多。');
}
function textOnly(value = '') { return String(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
function safeImageUrl(value, baseUrl) {
  try {
    let decoded = String(value || '');
    // Some publishers HTML-encode lazy-image URLs more than once.
    for (let pass = 0; pass < 3 && /&(amp|quot|#0*39|#x0*27|lt|gt);/i.test(decoded); pass += 1) {
      decoded = decoded.replace(/&(amp|quot|#0*39|#x0*27|lt|gt);/gi, (_match, entity) => ({ amp: '&', quot: '"', lt: '<', gt: '>', '#39': "'", '#x27': "'" }[entity.toLowerCase()] || _match));
    }
    const url = new URL(decoded, baseUrl);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch { return ''; }
}
function attributeValue(attributes, name) {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match?.slice(1).find(Boolean) || '';
}
function imageSource(attributes) {
  for (const name of ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-actualsrc', 'data-url']) {
    const value = attributeValue(attributes, name);
    if (value && !value.startsWith('data:')) return value;
  }
  for (const name of ['srcset', 'data-srcset']) {
    const candidate = attributeValue(attributes, name).split(',').at(-1)?.trim().split(/\s+/)[0] || '';
    if (candidate && !candidate.startsWith('data:')) return candidate;
  }
  return '';
}
function elementById(source, id) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const opening = new RegExp(`<([a-z][\\w:-]*)\\b[^>]*\\bid\\s*=\\s*(?:"${escapedId}"|'${escapedId}'|${escapedId})[^>]*>`, 'i').exec(source);
  if (!opening || opening.index === undefined) return '';
  const tag = opening[1]; const start = opening.index;
  const tags = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'); tags.lastIndex = start;
  let depth = 0; let match;
  while ((match = tags.exec(source))) {
    if (/^<\//.test(match[0])) { depth -= 1; if (!depth) return source.slice(start, tags.lastIndex); }
    else if (!/\/>$/.test(match[0])) depth += 1;
  }
  return '';
}
function elementEnd(source, start, tag) {
  const tags = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'); tags.lastIndex = start;
  let depth = 0; let match;
  while ((match = tags.exec(source))) {
    if (/^<\//.test(match[0])) { depth -= 1; if (!depth) return tags.lastIndex; }
    else if (!/\/>$/.test(match[0])) depth += 1;
  }
  return start;
}
function removeNoisyElements(source) {
  const removableTags = new Set(['aside', 'footer', 'header', 'nav', 'dialog']);
  const removableTokens = new Set([
    'ad', 'ads', 'ad-area', 'ad_area', 'advert', 'advertisement', 'sponsor', 'sponsored',
    'recommendation', 'recommendations', 'recommend-list', 'recommend_list', 'related-posts',
    'comment', 'comments', 'comment-list', 'comment_list', 'share', 'share-toolbar',
    'js-share-appmsg', 'js_share_appmsg', 'follow', 'subscribe', 'newsletter', 'cookie',
    'consent', 'toolbar', 'sidebar', 'breadcrumb', 'qrcode', 'qr-code', 'qr_code',
    'js-profile-qrcode', 'js_profile_qrcode', 'profile-inner', 'profile_inner',
    'author-info', 'author_info', 'author-profile', 'author_profile', 'reward', 'reward-area', 'reward_area', 'donate', 'vote',
    'preview', 'rich-media-tool', 'rich_media_tool', 'rich-media-extra', 'rich_media_extra',
    'rich-media-area-extra', 'rich_media_area_extra', 'js-content-end', 'js_content_end'
  ]);
  const attributeTokens = (attributes) => {
    const values = [...attributes.matchAll(/\b(?:class|id)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)]
      .map((match) => match.slice(1).find(Boolean) || '');
    return values.flatMap((value) => value.toLowerCase().split(/\s+/).filter(Boolean));
  };
  const tags = /<([a-z][\w:-]*)\b([^>]*)>/gi;
  let result = ''; let cursor = 0; let match;
  while ((match = tags.exec(source))) {
    const tag = match[1].toLowerCase(); const attributes = match[2];
    const hidden = /(?:^|\s)hidden(?:\s|=|$)|\baria-hidden\s*=\s*(?:"true"|'true'|true)/i.test(attributes);
    const marked = attributeTokens(attributes).some((token) => removableTokens.has(token));
    if (!removableTags.has(tag) && !hidden && !marked) continue;
    const end = elementEnd(source, match.index, tag);
    if (end <= match.index) continue;
    result += source.slice(cursor, match.index); cursor = end; tags.lastIndex = end;
  }
  return result + source.slice(cursor);
}
function compactSnapshot(markup) {
  let compacted = markup;
  let previous;
  do {
    previous = compacted;
    compacted = compacted
      .replace(/<(p|div|section|blockquote|figure)([^>]*)>(?:\s|&nbsp;|&#160;|&#x0*160;|&#x0*200b;|&zero-width-space;|<br\s*\/?\s*>|<span[^>]*>(?:\s|&nbsp;|&#160;|&#x0*160;|&#x0*200b;|&zero-width-space;|<br\s*\/?\s*>)*<\/span>)*<\/\1>/gi, '');
  } while (compacted !== previous);
  return compacted
    .replace(/(?:<br\s*\/?\s*>\s*){2,}/gi, '<br>')
    .replace(/(<\/(?:p|h[1-6]|li|blockquote|figure|pre|table)>)\s*<br\s*\/?\s*>/gi, '$1')
    .trim();
}
const windowsReservedNames = new Set(['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9']);
function archiveSegment(value, fallback) {
  let segment = String(value || '').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-').replace(/\s+/g, ' ').replace(/[. ]+$/g, '').trim();
  if (!segment) segment = fallback;
  if (windowsReservedNames.has(segment.toUpperCase())) segment = `${segment}-`;
  return segment.slice(0, 120);
}
function archiveUser(userId) { return db.prepare('SELECT id,username FROM users WHERE id=?').get(userId); }
function archiveFolderFor(item, title = item.title) {
  const current = archiveSegment(item.archive_folder, '');
  if (current) return current;
  const base = archiveSegment(title, '未命名文章');
  const owner = db.prepare('SELECT id FROM items WHERE user_id=? AND archive_folder=? AND id<>?').get(item.user_id, base, item.id);
  return owner ? `${base.slice(0, 104)}--${item.id.slice(-12)}` : base;
}
function archiveInfo(item, user = archiveUser(item.user_id), folder = archiveFolderFor(item)) {
  if (!user) throw new Error('归档用户不存在。');
  const userFolder = archiveSegment(user.username, user.id);
  const archiveFolder = archiveSegment(folder, '未命名文章');
  return {
    userFolder,
    folder: archiveFolder,
    directory: join(archiveDir, userFolder, archiveFolder),
    documentFile: `${archiveFolder}.html`,
    pdfFile: `${archiveFolder}.pdf`
  };
}
function legacyItemArchiveDir(userId, itemId) { return join(archiveDir, userId, itemId); }
function itemArchiveDir(userId, itemId, archive = null) {
  if (archive?.directory) return archive.directory;
  const item = db.prepare('SELECT * FROM items WHERE id=? AND user_id=?').get(itemId, userId);
  return item ? archiveInfo(item).directory : legacyItemArchiveDir(userId, itemId);
}
function moveArchiveDirectory(item, user, folder) {
  const current = archiveInfo(item, user);
  const target = archiveInfo(item, user, folder);
  if (current.directory === target.directory || !existsSync(current.directory)) return target;
  if (existsSync(target.directory)) throw new Error('目标文章归档目录已存在。');
  mkdirSync(join(archiveDir, target.userFolder), { recursive: true });
  renameSync(current.directory, target.directory);
  const oldDocument = join(target.directory, current.documentFile);
  const newDocument = join(target.directory, target.documentFile);
  if (oldDocument !== newDocument && existsSync(oldDocument)) renameSync(oldDocument, newDocument);
  const oldPdf = join(target.directory, current.pdfFile);
  const newPdf = join(target.directory, target.pdfFile);
  if (oldPdf !== newPdf && existsSync(oldPdf)) renameSync(oldPdf, newPdf);
  return target;
}
function migrateArchivePaths() {
  const rows = db.prepare('SELECT i.*,u.username FROM items i JOIN users u ON u.id=i.user_id ORDER BY i.created_at,i.id').all();
  for (const item of rows) {
    const folder = archiveFolderFor(item);
    const current = archiveInfo({ ...item, archive_folder: folder }, item, folder);
    const legacy = legacyItemArchiveDir(item.user_id, item.id);
    if (existsSync(legacy) && !existsSync(current.directory)) {
      mkdirSync(join(archiveDir, current.userFolder), { recursive: true });
      renameSync(legacy, current.directory);
    }
    const oldDocument = join(current.directory, 'article.html');
    const newDocument = join(current.directory, current.documentFile);
    if (existsSync(oldDocument) && !existsSync(newDocument)) renameSync(oldDocument, newDocument);
    const oldPdf = join(current.directory, 'article.pdf');
    const newPdf = join(current.directory, current.pdfFile);
    if (existsSync(oldPdf) && !existsSync(newPdf)) renameSync(oldPdf, newPdf);
    if (item.archive_folder !== folder) db.prepare('UPDATE items SET archive_folder=? WHERE id=?').run(folder, item.id);
  }
}
async function createMissingArchivePdfs() {
  const rows = db.prepare("SELECT * FROM items WHERE fetch_status='ready' AND trim(html_snapshot)<>'' ORDER BY created_at,id").all();
  for (const item of rows) {
    const archive = archiveInfo(item);
    if (!existsSync(join(archive.directory, archive.documentFile)) || existsSync(join(archive.directory, archive.pdfFile))) continue;
    try { await createArchivePdf(archive.directory, archive, item.html_snapshot, { title: item.title, url: item.url }); }
    catch (error) { console.warn(`PDF archive skipped for ${item.id}: ${error.message}`); }
  }
}
function archiveAssetUrl(itemId, filename) { return `/archive/${encodeURIComponent(itemId)}/${encodeURIComponent(filename)}`; }
function archiveImageExtension(contentType, sourceUrl) {
  const type = String(contentType || '').toLowerCase().split(';')[0];
  const types = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif', 'image/svg+xml': '.svg' };
  if (types[type]) return types[type];
  const extension = extname(new URL(sourceUrl).pathname).toLowerCase();
  return /^\.(?:jpe?g|png|gif|webp|avif|svg)$/.test(extension) ? extension : '.img';
}
function pdfBrowserExecutable() {
  if (process.env.PAPERLEAF_PDF_BROWSER) return process.env.PAPERLEAF_PDF_BROWSER;
  const windowsCandidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  ];
  return windowsCandidates.find(existsSync) || (process.platform === 'win32' ? null : 'chromium');
}
function pdfChromium() {
  try { return require('playwright-core').chromium; }
  catch { return require('../dependencies/node_modules/playwright-core').chromium; }
}
function pdfDocument(snapshot, metadata, staging) {
  const localSnapshot = snapshot.replace(/\bsrc=(['"])\/archive\/[^/]+\/([^'"]+)\1/gi, 'src="$2"');
  const source = metadata.url ? `<p class="meta">原文：${html(metadata.url)}</p>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="${html(pathToFileURL(`${staging}${sep}`).href)}"><title>${html(metadata.title || '未命名文章')}</title><style>@page{size:A4;margin:18mm 16mm}body{color:#28231b;font:16px/1.8 "Songti SC",Georgia,"Times New Roman",serif}h1{font:700 26px/1.35 system-ui,"Microsoft YaHei",sans-serif;margin:0 0 10px}.meta{color:#6d624e;font:13px/1.6 system-ui,"Microsoft YaHei",sans-serif;border-bottom:1px solid #d7c9aa;padding-bottom:12px;margin:0 0 28px;word-break:break-all}img{display:block;max-width:100%;height:auto;margin:16px auto}pre{white-space:pre-wrap;word-break:break-word}table{max-width:100%;border-collapse:collapse}th,td{border:1px solid #cfc4ab;padding:6px;vertical-align:top}</style></head><body><h1>${html(metadata.title || '未命名文章')}</h1>${source}<article>${localSnapshot}</article></body></html>`;
}
async function createArchivePdf(staging, archive, snapshot, metadata = {}) {
  const executable = pdfBrowserExecutable();
  if (!executable) throw new Error('未找到可用的 Chromium 浏览器，无法生成 PDF。');
  const pdfFile = join(staging, archive.pdfFile);
  const browser = await pdfChromium().launch({ headless: true, executablePath: executable, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    await page.setContent(pdfDocument(snapshot, metadata, staging), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.pdf({ path: pdfFile, format: 'A4', printBackground: true, margin: { top: '18mm', right: '16mm', bottom: '18mm', left: '16mm' } });
    if (!existsSync(pdfFile) || readFileSync(pdfFile).subarray(0, 4).toString() !== '%PDF') throw new Error('浏览器未生成有效 PDF 文件。');
  } finally {
    await browser.close();
  }
}
async function archiveSnapshot(userId, itemId, snapshot, archive = null, metadata = null) {
  const fallback = { id: itemId, user_id: userId, title: itemId, archive_folder: itemId };
  const info = archive || archiveInfo(fallback, { id: userId, username: userId });
  const directory = itemArchiveDir(userId, itemId, info);
  const parent = join(archiveDir, info.userFolder);
  const staging = join(parent, `.pending-${itemId}-${randomBytes(6).toString('hex')}`);
  mkdirSync(parent, { recursive: true });
  mkdirSync(staging);
  try {
    const archived = await Promise.all([...snapshot.matchAll(/<img\b([^>]*)>/gi)].map(async (match, imageIndex) => {
    const attributes = match[1]; const source = attributeValue(attributes, 'src');
    if (!source || source.startsWith('/archive/')) return match[0];
    try {
      const imageUrl = publicUrl(source).toString(); const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 12_000);
      let response;
      try { response = await fetch(imageUrl, { signal: controller.signal, headers: { 'User-Agent': pageHeaders['User-Agent'], Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' } }); }
      finally { clearTimeout(timeout); }
      const contentType = response.headers.get('content-type') || '';
      if (!response.ok || !contentType.toLowerCase().startsWith('image/')) return match[0];
      const filename = `image-${String(imageIndex + 1).padStart(3, '0')}${archiveImageExtension(contentType, imageUrl)}`;
      writeFileSync(join(staging, filename), Buffer.from(await response.arrayBuffer()));
      return `<img${attributes.replace(/\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, `src="${archiveAssetUrl(itemId, filename)}"`)}>`;
    } catch { return match[0]; }
    }));
    const localSnapshot = snapshot.replace(/<img\b[^>]*>/gi, () => archived.shift() || '');
    writeFileSync(join(staging, info.documentFile), localSnapshot, 'utf8');
    let preservePreviousPdf = false;
    if (metadata) {
      try { await createArchivePdf(staging, info, localSnapshot, metadata); }
      catch (error) { preservePreviousPdf = true; console.warn(`PDF archive skipped for ${itemId}: ${error.message}`); }
    }
    mkdirSync(directory, { recursive: true });
    const nextFiles = new Set(readdirSync(staging));
    for (const entry of nextFiles) {
      if (entry !== info.documentFile) copyFileSync(join(staging, entry), join(directory, entry));
    }
    // The document is replaced last, so a failed asset copy leaves the prior readable snapshot in place.
    copyFileSync(join(staging, info.documentFile), join(directory, info.documentFile));
    for (const entry of readdirSync(directory)) {
      const staleAsset = entry !== info.documentFile && entry !== info.pdfFile && !nextFiles.has(entry);
      const stalePdf = entry === info.pdfFile && !nextFiles.has(entry) && !preservePreviousPdf;
      if (staleAsset || stalePdf) {
        try { unlinkSync(join(directory, entry)); } catch { /* Old assets are harmless if the filesystem cannot remove them now. */ }
      }
    }
    rmSync(staging, { recursive: true, force: true });
    return localSnapshot;
  } catch (error) {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
function clearItemArchive(userId, itemId, archive = null) {
  const directory = itemArchiveDir(userId, itemId, archive);
  if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  const legacy = legacyItemArchiveDir(userId, itemId);
  if (legacy !== directory && existsSync(legacy)) rmSync(legacy, { recursive: true, force: true });
  for (const parent of new Set([dirname(directory), dirname(legacy)])) {
    if (parent !== archiveDir && existsSync(parent) && readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true });
  }
}
function sanitizeDocument(source, baseUrl) {
  const title = textOnly(elementById(source, 'activity-name')) || (source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '未命名网页');
  const description = (source.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i)?.[1] || '');
  const body = elementById(source, 'js_content') || source.match(/<article\b[^>]*>[\s\S]*?<\/article>/i)?.[0] || source.match(/<main\b[^>]*>[\s\S]*?<\/main>/i)?.[0] || source.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] || source;
  const safe = compactSnapshot(removeNoisyElements(body)
    .replace(/<\/?picture\b[^>]*>/gi, '')
    .replace(/<img\b([^>]*)>/gi, (_tag, attributes) => {
      const alt = attributeValue(attributes, 'alt');
      const imageUrl = safeImageUrl(imageSource(attributes), baseUrl);
      return imageUrl ? `<img src="${html(imageUrl)}" alt="${html(textOnly(alt))}">` : '';
    })
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed|form|input|button|select|textarea|label|option|svg|canvas|video|audio|source)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|style|iframe|object|embed|form|input|button|select|textarea|label|option|svg|canvas|video|audio|source)[^>]*\/?\s*>/gi, '')
    .replace(/<(?!img\b)([^>]+)>/gi, (_tag, attributes) => `<${attributes.replace(/\s(?:on\w+|style|src|srcset|class|id|data-[\w-]+|aria-[\w-]+|role)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')}>`)
    .replace(/\s(href)\s*=\s*(?:"\s*(?:javascript:|data:)[^"]*"|'\s*(?:javascript:|data:)[^']*'|(?:javascript:|data:)[^\s>]*)/gi, '')
    .replace(/<\/?(?:html|head|body)[^>]*>/gi, ''));
  const text = textOnly(safe);
  const imageCount = (safe.match(/<img\b/gi) || []).length;
  const summary = textOnly(description).trim() || text.slice(0, 100);
  return { title: textOnly(title).slice(0, 300), summary: summary.slice(0, 420), snapshot: safe.trim() || '<p>未提取到可阅读的正文。</p>', textLength: text.length, imageCount };
}
function repairVerificationSnapshots() {
  const rows = db.prepare("SELECT id,url,normalized_url,html_snapshot FROM items WHERE fetch_status='ready'").all();
  for (const item of rows) {
    if (!isVerificationPage(item.html_snapshot, item.url) && !/wappoc_appmsgcaptcha/i.test(item.url)) continue;
    const articleUrl = unwrapWechatArticleUrl(item.url);
    db.prepare('UPDATE items SET url=?,normalized_url=?,fetch_status=?,fetch_error=?,updated_at=? WHERE id=?')
      .run(articleUrl, normalizedUrl(articleUrl), 'failed', '此前保存的是微信验证页，不是文章正文。请重新抓取原始文章链接。', now(), item.id);
  }
}
function audit(userId, action, targetId = null) { db.prepare('INSERT INTO audit_logs (id,user_id,action,target_id,created_at) VALUES (?,?,?,?,?)').run(id('log'), userId, action, targetId, now()); }
function timelineEvent(userId, itemId, eventType, highlightId = null, occurredAt = now()) {
  db.prepare('INSERT INTO timeline_events (id,user_id,item_id,highlight_id,event_type,occurred_at,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id('evt'), userId, itemId, highlightId, eventType, occurredAt, now());
}
function normalizedName(value, { tag = false, maxLength }) {
  let name = String(value || '').normalize('NFC').trim();
  if (tag) name = name.replace(/^#/, '').trim();
  if (!name || name.length > maxLength || /[\u0000-\u001f\u007f]/.test(name) || (tag && /\s/.test(name))) return '';
  return name;
}
function currentUser(req) {
  const session = cookies(req).pl_session;
  if (!session) return null;
  return db.prepare('SELECT u.id,u.username,u.role,u.disabled FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at>?').get(session, now()) || null;
}
function tokenUser(req, scopes) {
  const header = req.headers.authorization || '';
  const value = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!value) return null;
  const row = db.prepare('SELECT t.id,t.user_id,t.scopes,u.username,u.role,u.disabled FROM api_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.revoked_at IS NULL').get(tokenHash(value));
  const grantedScopes = row ? parse(row.scopes) : [];
  if (!row || row.disabled || !scopes.every((scope) => grantedScopes.includes(scope))) return null;
  db.prepare('UPDATE api_tokens SET last_used_at=? WHERE id=?').run(now(), row.id);
  return { id: row.user_id, username: row.username, role: row.role, tokenId: row.id };
}
function itemData(item) {
  const tags = db.prepare('SELECT t.id,t.name FROM tags t JOIN item_tags it ON it.tag_id=t.id WHERE it.item_id=? ORDER BY t.name').all(item.id);
  const folders = db.prepare('SELECT f.id,f.name FROM folders f JOIN item_folders ifo ON ifo.folder_id=f.id WHERE ifo.item_id=? ORDER BY f.sort_order,f.name').all(item.id);
  const highlights = db.prepare('SELECT id,text,note_title,note,color,start_offset,end_offset,created_at,updated_at FROM highlights WHERE item_id=? ORDER BY updated_at DESC, id DESC').all(item.id);
  const archive = archiveInfo(item);
  const archivePath = join(archive.directory, archive.documentFile);
  const pdfPath = join(archive.directory, archive.pdfFile);
  return { ...item, archive_path: existsSync(archivePath) ? archivePath : null, pdf_path: existsSync(pdfPath) ? pdfPath : null, is_read: Boolean(item.is_read), is_archived: Boolean(item.is_archived), is_favorite: Boolean(item.is_favorite), tags, folders, highlights };
}
function listItems(userId, params) {
  const clauses = ['i.user_id=?']; const values = [userId];
  if (params.get('status') === 'unread') clauses.push('i.is_read=0');
  if (params.get('status') === 'archived') clauses.push('i.is_archived=1');
  if (params.get('status') === 'favorite') clauses.push('i.is_favorite=1');
  if (params.get('tag')) { clauses.push('EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON t.id=it.tag_id WHERE it.item_id=i.id AND t.name=?)'); values.push(params.get('tag')); }
  if (params.get('folderId')) { clauses.push('EXISTS (SELECT 1 FROM item_folders ifo WHERE ifo.item_id=i.id AND ifo.folder_id=?)'); values.push(params.get('folderId')); }
  if (params.get('q')) { const keyword = `%${params.get('q').trim()}%`; clauses.push('(i.title LIKE ? OR i.summary LIKE ?)'); values.push(keyword, keyword); }
  const page = Math.max(Number(params.get('page') || 1), 1); const pageSize = Math.min(Math.max(Number(params.get('pageSize') || 100), 1), 100);
  const where = clauses.join(' AND ');
  const total = db.prepare(`SELECT count(*) AS total FROM items i WHERE ${where}`).get(...values).total;
  const items = db.prepare(`SELECT i.* FROM items i WHERE ${where} ORDER BY i.created_at DESC, i.id DESC LIMIT ? OFFSET ?`).all(...values, pageSize, (page - 1) * pageSize).map(itemData);
  return { items, page, pageSize, total };
}
function noteData(row) {
  const tags = db.prepare('SELECT t.id,t.name FROM tags t JOIN item_tags it ON it.tag_id=t.id WHERE it.item_id=? ORDER BY t.name').all(row.item_id);
  return {
    id: row.id,
    item_id: row.item_id,
    title: row.note_title,
    note: row.note,
    text: row.text,
    color: row.color,
    start_offset: row.start_offset,
    end_offset: row.end_offset,
    created_at: row.created_at,
    updated_at: row.updated_at,
    article: {
      id: row.item_id,
      title: row.article_title,
      url: row.article_url,
      is_archived: Boolean(row.article_archived),
      tags
    }
  };
}
function noteForUser(userId, noteId) {
  return db.prepare(`SELECT h.*,i.title AS article_title,i.url AS article_url,i.is_archived AS article_archived
    FROM highlights h JOIN items i ON i.id=h.item_id WHERE h.id=? AND i.user_id=?`).get(noteId, userId);
}
function listNotes(userId, params) {
  const clauses = ["i.user_id=?", "trim(h.note_title) <> ''", "trim(h.note) <> ''"];
  const values = [userId];
  const articleStatus = params.get('articleStatus') || 'all';
  if (articleStatus === 'active') clauses.push('i.is_archived=0');
  if (articleStatus === 'archived') clauses.push('i.is_archived=1');
  const articleQuery = String(params.get('articleQ') || '').trim();
  const noteQuery = String(params.get('noteQ') || '').trim();
  const noteField = params.get('noteField') === 'highlight' ? 'highlight' : 'note';
  if (articleQuery) { clauses.push('i.title LIKE ?'); values.push(`%${articleQuery}%`); }
  if (noteQuery) { clauses.push(noteField === 'highlight' ? 'h.text LIKE ?' : '(h.note_title LIKE ? OR h.note LIKE ?)'); values.push(`%${noteQuery}%`, ...(noteField === 'highlight' ? [] : [`%${noteQuery}%`])); }
  const page = Math.max(Number(params.get('page') || 1), 1);
  const pageSize = Math.min(Math.max(Number(params.get('pageSize') || 100), 1), 100);
  const where = clauses.join(' AND ');
  const total = db.prepare(`SELECT count(*) AS total FROM highlights h JOIN items i ON i.id=h.item_id WHERE ${where}`).get(...values).total;
  const rows = db.prepare(`SELECT h.*,i.title AS article_title,i.url AS article_url,i.is_archived AS article_archived
    FROM highlights h JOIN items i ON i.id=h.item_id WHERE ${where} ORDER BY h.created_at DESC,h.id DESC LIMIT ? OFFSET ?`).all(...values, pageSize, (page - 1) * pageSize);
  return { notes: rows.map(noteData), page, pageSize, total };
}
function folderSummary(userId, params) {
  const query = String(params.get('q') || '').trim(); const values = [userId]; let where = 'f.user_id=?';
  if (query) { where += " AND (f.name LIKE ? OR EXISTS (SELECT 1 FROM item_folders sf JOIN items si ON si.id=sf.item_id WHERE sf.folder_id=f.id AND si.title LIKE ?))"; values.push(`%${query}%`, `%${query}%`); }
  const page = Math.max(Number(params.get('page') || 1), 1); const pageSize = Math.min(Math.max(Number(params.get('pageSize') || 100), 1), 100);
  const total = db.prepare(`SELECT count(*) AS total FROM folders f WHERE ${where}`).get(...values).total;
  const folders = db.prepare(`SELECT f.id,f.name,f.sort_order,f.created_at,count(ifo.item_id) AS count,max(i.created_at) AS latest_item_at
    FROM folders f LEFT JOIN item_folders ifo ON ifo.folder_id=f.id LEFT JOIN items i ON i.id=ifo.item_id
    WHERE ${where} GROUP BY f.id ORDER BY f.sort_order ASC,f.name ASC LIMIT ? OFFSET ?`).all(...values, pageSize, (page - 1) * pageSize);
  return { folders, total, page, pageSize };
}
function tagSummary(userId, params) {
  const query = String(params.get('q') || '').trim(); const values = [userId]; let where = 't.user_id=?';
  if (query) { where += " AND (t.name LIKE ? OR EXISTS (SELECT 1 FROM item_tags st JOIN items si ON si.id=st.item_id WHERE st.tag_id=t.id AND si.title LIKE ?))"; values.push(`%${query}%`, `%${query}%`); }
  const page = Math.max(Number(params.get('page') || 1), 1); const pageSize = Math.min(Math.max(Number(params.get('pageSize') || 100), 1), 100);
  const total = db.prepare(`SELECT count(*) AS total FROM tags t WHERE ${where}`).get(...values).total;
  const tags = db.prepare(`SELECT t.id,t.name,t.created_at,count(it.item_id) AS count FROM tags t LEFT JOIN item_tags it ON it.tag_id=t.id WHERE ${where} GROUP BY t.id ORDER BY t.name ASC LIMIT ? OFFSET ?`).all(...values, pageSize, (page - 1) * pageSize);
  return { tags, total, page, pageSize };
}
function folderDetail(userId, folderId, params) {
  const folder = db.prepare('SELECT id,name,sort_order,created_at FROM folders WHERE id=? AND user_id=?').get(folderId, userId); if (!folder) return null;
  const page = Math.max(Number(params.get('page') || 1), 1); const pageSize = Math.min(Math.max(Number(params.get('pageSize') || 100), 1), 100);
  const total = db.prepare('SELECT count(*) AS total FROM item_folders WHERE folder_id=?').get(folder.id).total;
  const rows = db.prepare('SELECT i.* FROM items i JOIN item_folders ifo ON ifo.item_id=i.id WHERE ifo.folder_id=? AND i.user_id=? ORDER BY i.created_at DESC,i.id DESC LIMIT ? OFFSET ?').all(folder.id, userId, pageSize, (page - 1) * pageSize).map(itemData);
  return { ...folder, items: rows, total, page, pageSize };
}
function tagDetail(userId, tagId, params) {
  const tag = db.prepare('SELECT id,name,created_at FROM tags WHERE id=? AND user_id=?').get(tagId, userId); if (!tag) return null;
  const page = Math.max(Number(params.get('page') || 1), 1); const pageSize = Math.min(Math.max(Number(params.get('pageSize') || 100), 1), 100);
  const total = db.prepare('SELECT count(*) AS total FROM item_tags WHERE tag_id=?').get(tag.id).total;
  const rows = db.prepare('SELECT i.* FROM items i JOIN item_tags it ON it.item_id=i.id WHERE it.tag_id=? AND i.user_id=? ORDER BY i.created_at DESC,i.id DESC LIMIT ? OFFSET ?').all(tag.id, userId, pageSize, (page - 1) * pageSize).map(itemData);
  return { ...tag, items: rows, total, page, pageSize };
}
function listTimeline(userId, params) {
  const categories = String(params.get('types') || '').split(',').filter(Boolean);
  const categoryTypes = { article: ['item_created', 'item_archived', 'item_unarchived', 'item_favorited', 'item_unfavorited'], note: ['highlight_created', 'note_updated'], created: ['item_created'], favorite: ['item_favorited', 'item_unfavorited'], archive: ['item_archived', 'item_unarchived'], highlight: ['highlight_created'], noteUpdated: ['note_updated'], archived: ['item_archived', 'item_unarchived'] };
  const allowedTypes = [...new Set(Object.values(categoryTypes).flat())]; const allowed = new Set(allowedTypes); const types = [...new Set(categories.flatMap((entry) => categoryTypes[entry] || [entry]).filter((entry) => allowed.has(entry)))];
  const clauses = ['e.user_id=?', `e.event_type IN (${allowedTypes.map(() => '?').join(',')})`]; const values = [userId, ...allowedTypes];
  if (types.length) { clauses.push(`e.event_type IN (${types.map(() => '?').join(',')})`); values.push(...types); }
  const articleStatus = params.get('articleStatus') || 'all'; if (articleStatus === 'active') clauses.push('i.is_archived=0'); if (articleStatus === 'archived') clauses.push('i.is_archived=1');
  const query = String(params.get('q') || '').trim(); if (query) { const keyword = `%${query}%`; clauses.push('(i.title LIKE ? OR i.url LIKE ? OR h.note_title LIKE ? OR h.note LIKE ? OR h.text LIKE ? OR e.event_type LIKE ?)'); values.push(keyword, keyword, keyword, keyword, keyword, keyword); }
  const page = Math.max(Number(params.get('page') || 1), 1); const pageSize = Math.min(Math.max(Number(params.get('pageSize') || 12), 1), 12); const where = clauses.join(' AND ');
  const total = db.prepare(`SELECT count(*) AS total FROM timeline_events e LEFT JOIN items i ON i.id=e.item_id AND i.user_id=e.user_id LEFT JOIN highlights h ON h.id=e.highlight_id WHERE ${where}`).get(...values).total;
  const stats = db.prepare(`SELECT count(*) AS events,count(DISTINCT e.item_id) AS articles,count(DISTINCT CASE WHEN e.highlight_id IS NOT NULL THEN e.highlight_id END) AS notes,count(DISTINCT CASE WHEN i.is_archived=1 THEN e.item_id END) AS archived_articles
    FROM timeline_events e LEFT JOIN items i ON i.id=e.item_id AND i.user_id=e.user_id LEFT JOIN highlights h ON h.id=e.highlight_id
    WHERE ${where}`).get(...values);
  const dayTotal = db.prepare(`SELECT count(*) AS total FROM (SELECT date(e.occurred_at, 'localtime') AS day FROM timeline_events e LEFT JOIN items i ON i.id=e.item_id AND i.user_id=e.user_id LEFT JOIN highlights h ON h.id=e.highlight_id WHERE ${where} GROUP BY day)`).get(...values).total;
  const days = db.prepare(`SELECT date(e.occurred_at, 'localtime') AS day,max(e.occurred_at) AS latest FROM timeline_events e LEFT JOIN items i ON i.id=e.item_id AND i.user_id=e.user_id LEFT JOIN highlights h ON h.id=e.highlight_id WHERE ${where} GROUP BY day ORDER BY latest DESC,day DESC LIMIT ? OFFSET ?`).all(...values, pageSize, (page - 1) * pageSize).map((row) => row.day);
  const rows = days.length ? db.prepare(`SELECT e.*,i.id AS current_item_id,i.title AS item_title,i.url AS item_url,i.is_archived AS item_archived,h.text AS highlight_text,h.note_title,h.note,h.start_offset,h.end_offset
    FROM timeline_events e LEFT JOIN items i ON i.id=e.item_id AND i.user_id=e.user_id LEFT JOIN highlights h ON h.id=e.highlight_id
    WHERE ${where} AND date(e.occurred_at, 'localtime') IN (${days.map(() => '?').join(',')}) ORDER BY e.occurred_at DESC,e.id DESC`).all(...values, ...days) : [];
  return { items: rows.map((row) => ({ ...row, article: row.current_item_id ? { id: row.item_id, title: row.item_title || '未命名文章', url: row.item_url, is_archived: Boolean(row.item_archived) } : null, highlight: row.highlight_text ? { id: row.highlight_id, text: row.highlight_text, title: row.note_title, note: row.note, start_offset: row.start_offset, end_offset: row.end_offset } : null })), total, page, pageSize, dayTotal, hasMore: page * pageSize < dayTotal, stats: { events: Number(stats.events), articles: Number(stats.articles), notes: Number(stats.notes), archivedArticles: Number(stats.archived_articles) } };
}
function addTags(userId, itemId, names) {
  for (const rawName of names || []) { const name = String(rawName).trim().replace(/^#/, '').slice(0, 40); if (!name) continue; let tag = db.prepare('SELECT id FROM tags WHERE user_id=? AND name=?').get(userId, name); if (!tag) { tag = { id: id('tag') }; db.prepare('INSERT INTO tags (id,user_id,name,created_at) VALUES (?,?,?,?)').run(tag.id, userId, name, now()); } db.prepare('INSERT OR IGNORE INTO item_tags (item_id,tag_id) VALUES (?,?)').run(itemId, tag.id); }
}
function clearOrphanTags(userId) {
  db.prepare('DELETE FROM tags WHERE user_id=? AND NOT EXISTS (SELECT 1 FROM item_tags it WHERE it.tag_id=tags.id)').run(userId);
}
function preferencesForUser(userId) {
  const row = db.prepare('SELECT homepage_view,reader_display FROM user_preferences WHERE user_id=?').get(userId);
  return {
    homepageView: row?.homepage_view === 'cards' ? 'cards' : 'list',
    readerDisplay: parse(row?.reader_display, {})
  };
}
function addFolders(userId, itemId, folderIds) { for (const folderId of folderIds || []) if (db.prepare('SELECT id FROM folders WHERE id=? AND user_id=?').get(folderId, userId)) db.prepare('INSERT OR IGNORE INTO item_folders (item_id,folder_id) VALUES (?,?)').run(itemId, folderId); }
async function createItem(userId, payload) {
  const normalized = normalizedUrl(payload.url); const existing = db.prepare('SELECT * FROM items WHERE user_id=? AND normalized_url=?').get(userId, normalized);
  if (existing) return { duplicate: true, item: itemData(existing) };
  const itemId = id('itm'); const time = now(); let page;
  try { page = await fetchPage(normalized); }
  catch (error) { page = { url: normalized, title: payload.title || new URL(normalized).hostname, summary: '', snapshot: '', error: error.message }; }
  const draft = { id: itemId, user_id: userId, title: page.title, archive_folder: '' };
  const archiveFolder = archiveFolderFor(draft);
  const archive = archiveInfo(draft, archiveUser(userId), archiveFolder);
  if (!page.error && page.snapshot) page.snapshot = await archiveSnapshot(userId, itemId, page.snapshot, archive, { title: page.title, url: page.url });
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO items (id,user_id,url,normalized_url,title,summary,html_snapshot,fetch_status,fetch_error,archive_folder,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(itemId, userId, page.url, normalized, page.title, page.summary, page.snapshot, page.error ? 'failed' : 'ready', page.error || null, archiveFolder, time, time);
    addTags(userId, itemId, payload.tags); addFolders(userId, itemId, payload.folderId ? [payload.folderId] : payload.folderIds);
    timelineEvent(userId, itemId, 'item_created', null, time);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  audit(userId, 'item.create', itemId);
  return { duplicate: false, item: itemData(db.prepare('SELECT * FROM items WHERE id=?').get(itemId)) };
}
async function refetchItem(item) {
  const time = now(); let page;
  try { page = await fetchPage(item.normalized_url); }
  catch (error) { page = { url: item.url, title: item.title, summary: item.summary, snapshot: item.html_snapshot, error: error.message }; }
  const user = archiveUser(item.user_id);
  const archiveFolder = !page.error ? archiveFolderFor({ ...item, archive_folder: '', title: page.title }, page.title) : item.archive_folder;
  const archive = !page.error ? moveArchiveDirectory(item, user, archiveFolder) : archiveInfo(item, user);
  if (!page.error && page.snapshot) page.snapshot = await archiveSnapshot(item.user_id, item.id, page.snapshot, archive, { title: page.title, url: page.url });
  db.prepare('UPDATE items SET url=?,title=?,summary=?,html_snapshot=?,fetch_status=?,fetch_error=?,archive_folder=?,updated_at=? WHERE id=?')
    .run(page.url, page.title, page.summary, page.snapshot, page.error ? 'failed' : 'ready', page.error || null, archive.folder, time, item.id);
  return itemData(itemForUser(item.user_id, item.id));
}
function itemForUser(userId, itemId) { return db.prepare('SELECT * FROM items WHERE id=? AND user_id=?').get(itemId, userId); }
function requireUser(req, res) { const user = currentUser(req); if (!user || user.disabled) { fail(res, 401, 'UNAUTHENTICATED', '请先登录。'); return null; } return user; }
function cors(req, res) { if (req.headers.origin?.startsWith('chrome-extension://')) res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS'); }

async function api(req, res, url) {
  cors(req, res); if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const path = url.pathname;
  if (path === '/api/health') return ok(res, { status: 'ok', version: '0.0.2' });
  if (path === '/api/auth/login' && req.method === 'POST') { const body = await readBody(req); const user = db.prepare('SELECT * FROM users WHERE username=?').get(String(body.username || '').trim()); if (!user || user.disabled || !(await passwordMatches(String(body.password || ''), user.password_hash))) return fail(res, 401, 'INVALID_CREDENTIALS', '用户名或密码错误。'); const sessionId = id('ses'); db.prepare('INSERT INTO sessions (id,user_id,expires_at,created_at) VALUES (?,?,?,?)').run(sessionId, user.id, new Date(Date.now() + 7 * 864e5).toISOString(), now()); setCookie(res, sessionId); audit(user.id, 'auth.login'); return ok(res, { id: user.id, username: user.username, role: user.role }); }
  if (path === '/api/auth/logout' && req.method === 'POST') { const session = cookies(req).pl_session; if (session) db.prepare('DELETE FROM sessions WHERE id=?').run(session); clearCookie(res); return ok(res, { loggedOut: true }); }
  if (path === '/api/auth/me' && req.method === 'GET') { const user = requireUser(req, res); if (user) ok(res, user); return; }
  if (path === '/api/preferences') { const user = requireUser(req, res); if (!user) return; if (req.method === 'GET') return ok(res, preferencesForUser(user.id)); if (req.method === 'PATCH') { const body = await readBody(req); const current = preferencesForUser(user.id); const homepageView = body.homepageView === 'cards' || body.homepageView === 'list' ? body.homepageView : current.homepageView; const readerDisplay = body.readerDisplay && typeof body.readerDisplay === 'object' && !Array.isArray(body.readerDisplay) ? body.readerDisplay : current.readerDisplay; db.prepare('INSERT INTO user_preferences (user_id,homepage_view,reader_display,updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET homepage_view=excluded.homepage_view,reader_display=excluded.reader_display,updated_at=excluded.updated_at').run(user.id, homepageView, json(readerDisplay), now()); audit(user.id, 'preferences.update'); return ok(res, { homepageView, readerDisplay }); } return fail(res, 405, 'METHOD_NOT_ALLOWED', '不支持的偏好设置操作。'); }
  if (path === '/api/auth/password' && req.method === 'POST') { const user = requireUser(req, res); if (!user) return; const body = await readBody(req); const newPassword = String(body.newPassword || ''); const stored = db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id); if (!(await passwordMatches(String(body.currentPassword || ''), stored.password_hash))) return fail(res, 400, 'INVALID_PASSWORD', '当前密码不正确。'); if (!newPassword) return fail(res, 400, 'INVALID_PASSWORD', '新密码不能为空。'); db.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').run(await passwordHash(newPassword), now(), user.id); audit(user.id, 'auth.password.change'); return ok(res, { changed: true }); }
  if (path === '/api/dashboard' && req.method === 'GET') { const user = requireUser(req, res); if (!user) return; const tags = db.prepare('SELECT t.id,t.name,count(it.item_id) AS count FROM tags t LEFT JOIN item_tags it ON it.tag_id=t.id WHERE t.user_id=? GROUP BY t.id ORDER BY count DESC,t.name LIMIT 12').all(user.id); const folders = db.prepare('SELECT f.id,f.name,f.sort_order,f.created_at,count(ifo.item_id) AS count FROM folders f LEFT JOIN item_folders ifo ON ifo.folder_id=f.id WHERE f.user_id=? GROUP BY f.id ORDER BY f.sort_order,f.name').all(user.id); const highlights = db.prepare('SELECT h.*,i.title FROM highlights h JOIN items i ON i.id=h.item_id WHERE i.user_id=? ORDER BY h.created_at DESC LIMIT 3').all(user.id); const recentItem = db.prepare('SELECT * FROM items WHERE user_id=? AND last_opened_at IS NOT NULL ORDER BY last_opened_at DESC LIMIT 1').get(user.id); return ok(res, { tags, folders, highlights, recentItem: recentItem ? itemData(recentItem) : null, counts: { all: db.prepare('SELECT count(*) AS n FROM items WHERE user_id=?').get(user.id).n, unread: db.prepare('SELECT count(*) AS n FROM items WHERE user_id=? AND is_read=0').get(user.id).n, archived: db.prepare('SELECT count(*) AS n FROM items WHERE user_id=? AND is_archived=1').get(user.id).n, favorite: db.prepare('SELECT count(*) AS n FROM items WHERE user_id=? AND is_favorite=1').get(user.id).n } }); }
  if (path === '/api/notes' && req.method === 'GET') { const user = requireUser(req, res); if (user) ok(res, listNotes(user.id, url.searchParams)); return; }
  const noteMatch = path.match(/^\/api\/notes\/([^/]+)$/);
  if (noteMatch) {
    const user = requireUser(req, res); if (!user) return;
    const note = noteForUser(user.id, noteMatch[1]);
    if (!note) return fail(res, 404, 'NOT_FOUND', '未找到该笔记。');
    if (req.method === 'GET') return ok(res, noteData(note));
    if (req.method === 'PATCH') {
      const body = await readBody(req); const noteTitle = typeof body.title === 'string' ? body.title.trim() : ''; const noteText = typeof body.note === 'string' ? body.note.trim() : '';
      if (!noteTitle || noteTitle.length > 120) return fail(res, 400, 'INVALID_NOTE_TITLE', '笔记标题为 1-120 字符。');
      if (!noteText || noteText.length > 1000) return fail(res, 400, 'INVALID_NOTE', '笔记正文为 1-1000 字符。');
      if (typeof body.updatedAt !== 'string' || !body.updatedAt) return fail(res, 400, 'INVALID_NOTE_VERSION', '缺少笔记更新时间。');
      const timestamp = now();
      db.exec('BEGIN');
      let result;
      try { result = db.prepare('UPDATE highlights SET note_title=?,note=?,updated_at=? WHERE id=? AND updated_at=?').run(noteTitle, noteText, timestamp, note.id, body.updatedAt); if (result.changes !== 1) { db.exec('ROLLBACK'); return fail(res, 409, 'NOTE_CONFLICT', '笔记已在其他位置更新。'); } timelineEvent(user.id, note.item_id, 'note_updated', note.id, timestamp); db.exec('COMMIT'); }
      catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
      audit(user.id, 'note.update', note.id);
      return ok(res, noteData(noteForUser(user.id, note.id)));
    }
    if (req.method === 'DELETE') {
      db.exec('BEGIN');
      try { db.prepare('DELETE FROM timeline_events WHERE user_id=? AND highlight_id=?').run(user.id, note.id); db.prepare('DELETE FROM highlights WHERE id=?').run(note.id); db.exec('COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
      audit(user.id, 'note.delete', note.id);
      return ok(res, { deleted: true });
    }
    return fail(res, 405, 'METHOD_NOT_ALLOWED', '不支持的笔记操作。');
  }
  if (path === '/api/timeline' && req.method === 'GET') { const user = requireUser(req, res); if (user) ok(res, listTimeline(user.id, url.searchParams)); return; }
  if (path === '/api/items' && req.method === 'GET') { const user = requireUser(req, res); if (user) ok(res, listItems(user.id, url.searchParams)); return; }
  if (path === '/api/items' && req.method === 'POST') { const user = requireUser(req, res); if (!user) return; const result = await createItem(user.id, await readBody(req)); return ok(res, result, result.duplicate ? 200 : 201); }
  const itemMatch = path.match(/^\/api\/items\/([^/]+)$/);
  const refetchMatch = path.match(/^\/api\/items\/([^/]+)\/refetch$/);
  if (refetchMatch && req.method === 'POST') { const user = requireUser(req, res); if (!user) return; const item = itemForUser(user.id, refetchMatch[1]); if (!item) return fail(res, 404, 'NOT_FOUND', '未找到该条目。'); return ok(res, await refetchItem(item)); }
  if (itemMatch) {
    const user = requireUser(req, res); if (!user) return;
    const item = itemForUser(user.id, itemMatch[1]);
    if (!item) return fail(res, 404, 'NOT_FOUND', '未找到该条目。');
    if (req.method === 'GET') return ok(res, itemData(item));
    if (req.method === 'PATCH') {
      const body = await readBody(req); const fields = []; const values = []; const timestamp = now();
      for (const key of ['is_read', 'is_archived', 'is_favorite']) if (typeof body[key] === 'boolean') { fields.push(`${key}=?`); values.push(Number(body[key])); }
      if (body.last_opened === true) { fields.push('last_opened_at=?'); values.push(timestamp); }
      if (Number.isFinite(body.reading_progress)) { fields.push('reading_progress=?'); values.push(Math.min(1, Math.max(0, Number(body.reading_progress)))); }
      const title = typeof body.title === 'string' ? body.title.trim().slice(0, 300) : null;
      if (title !== null) fields.push('title=?'), values.push(title);
      if (typeof body.summary === 'string') { fields.push('summary=?'); values.push(body.summary.trim().slice(0, 2000)); }
      if (title !== null && title !== item.title) {
        const folder = archiveFolderFor({ ...item, archive_folder: '', title }, title);
        moveArchiveDirectory(item, user, folder);
        fields.push('archive_folder=?'); values.push(folder);
      }
      db.exec('BEGIN');
      try {
        if (fields.length) { fields.push('updated_at=?'); values.push(timestamp, item.id); db.prepare(`UPDATE items SET ${fields.join(',')} WHERE id=?`).run(...values); }
        if (typeof body.is_archived === 'boolean' && body.is_archived !== Boolean(item.is_archived)) timelineEvent(user.id, item.id, body.is_archived ? 'item_archived' : 'item_unarchived', null, timestamp);
        if (typeof body.is_favorite === 'boolean' && body.is_favorite !== Boolean(item.is_favorite)) timelineEvent(user.id, item.id, body.is_favorite ? 'item_favorited' : 'item_unfavorited', null, timestamp);
        if (Array.isArray(body.tags)) { db.prepare('DELETE FROM item_tags WHERE item_id=?').run(item.id); addTags(user.id, item.id, body.tags); clearOrphanTags(user.id); }
        if (Array.isArray(body.folderIds)) { db.prepare('DELETE FROM item_folders WHERE item_id=?').run(item.id); addFolders(user.id, item.id, body.folderIds); }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      audit(user.id, 'item.update', item.id);
      return ok(res, itemData(itemForUser(user.id, item.id)));
    }
    if (req.method === 'DELETE') {
      const archive = archiveInfo(item, user);
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM timeline_events WHERE user_id=? AND item_id=?').run(user.id, item.id);
        db.prepare('DELETE FROM highlights WHERE item_id=?').run(item.id);
        db.prepare('DELETE FROM items WHERE id=?').run(item.id);
        clearItemArchive(user.id, item.id, archive); clearOrphanTags(user.id); db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      audit(user.id, 'item.delete', item.id); return ok(res, { deleted: true });
    }
  }
  const highlightMatch = path.match(/^\/api\/items\/([^/]+)\/highlights(?:\/([^/]+))?$/);
  if (highlightMatch) { const user = requireUser(req, res); if (!user) return; const item = itemForUser(user.id, highlightMatch[1]); if (!item) return fail(res, 404, 'NOT_FOUND', '未找到该条目。'); if (req.method === 'POST') { const body = await readBody(req); const text = String(body.text || '').trim(); const noteTitle = String(body.title || '').trim(); const noteText = String(body.note || '').trim(); const startOffset = Number.isInteger(body.start_offset) ? body.start_offset : null; const endOffset = Number.isInteger(body.end_offset) ? body.end_offset : null; if (!text) return fail(res, 400, 'INVALID_HIGHLIGHT', '高亮内容不能为空。'); if (!noteTitle || noteTitle.length > 120) return fail(res, 400, 'INVALID_NOTE_TITLE', '笔记标题为 1-120 字符。'); if (!noteText || noteText.length > 1000) return fail(res, 400, 'INVALID_NOTE', '笔记正文为 1-1000 字符。'); if ((startOffset === null) !== (endOffset === null) || (startOffset !== null && (startOffset < 0 || endOffset <= startOffset))) return fail(res, 400, 'INVALID_HIGHLIGHT', '高亮定位信息无效。'); const highlightId = id('hlt'); const timestamp = now(); db.exec('BEGIN'); try { db.prepare('INSERT INTO highlights (id,item_id,text,note_title,note,color,start_offset,end_offset,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(highlightId, item.id, text.slice(0, 4000), noteTitle, noteText, 'yellow', startOffset, endOffset, timestamp, timestamp); timelineEvent(user.id, item.id, 'highlight_created', highlightId, timestamp); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } audit(user.id, 'note.create', highlightId); return ok(res, db.prepare('SELECT * FROM highlights WHERE id=?').get(highlightId), 201); } if (req.method === 'DELETE' && highlightMatch[2]) { const highlight = db.prepare('SELECT id FROM highlights WHERE id=? AND item_id=?').get(highlightMatch[2], item.id); if (!highlight) return fail(res, 404, 'NOT_FOUND', '未找到该高亮。'); db.exec('BEGIN'); try { db.prepare('DELETE FROM timeline_events WHERE user_id=? AND highlight_id=?').run(user.id, highlight.id); db.prepare('DELETE FROM highlights WHERE id=?').run(highlight.id); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } audit(user.id, 'note.delete', highlight.id); return ok(res, { deleted: true }); } }
  if (path === '/api/tags') { const user = requireUser(req, res); if (!user) return; if (req.method === 'GET') return ok(res, tagSummary(user.id, url.searchParams)); return fail(res, 405, 'METHOD_NOT_ALLOWED', '不支持的标签操作。'); }
  const tagMatch = path.match(/^\/api\/tags\/([^/]+)$/);
  if (tagMatch) { const user = requireUser(req, res); if (!user) return; const tag = db.prepare('SELECT * FROM tags WHERE id=? AND user_id=?').get(tagMatch[1], user.id); if (!tag) return fail(res, 404, 'NOT_FOUND', '未找到标签。'); if (req.method === 'GET') return ok(res, tagDetail(user.id, tag.id, url.searchParams)); if (req.method === 'PATCH') { const body = await readBody(req); const name = normalizedName(body.name, { tag: true, maxLength: 40 }); if (!name) return fail(res, 400, 'INVALID_TAG', '标签名称为 1-40 个非空白字符，且不能包含空格或控制字符。'); try { db.prepare('UPDATE tags SET name=? WHERE id=? AND user_id=?').run(name, tag.id, user.id); } catch { return fail(res, 409, 'DUPLICATE_TAG', '已存在同名标签。'); } audit(user.id, 'tag.rename', tag.id); return ok(res, db.prepare('SELECT id,name,created_at FROM tags WHERE id=?').get(tag.id)); } return fail(res, 405, 'METHOD_NOT_ALLOWED', '不支持的标签操作。'); }
  if (path === '/api/folders') { const user = requireUser(req, res); if (!user) return; if (req.method === 'GET') return ok(res, folderSummary(user.id, url.searchParams)); if (req.method === 'POST') { const body = await readBody(req); const name = normalizedName(body.name, { maxLength: 9 }); if (!name) return fail(res, 400, 'INVALID_FOLDER', '收藏夹名称为 1-9 个字符，且不能包含控制字符。'); const folderId = id('fld'); try { db.prepare('INSERT INTO folders (id,user_id,name,sort_order,created_at) VALUES (?,?,?,?,?)').run(folderId, user.id, name, Number(body.sortOrder || 0), now()); } catch { return fail(res, 409, 'DUPLICATE_FOLDER', '已存在同名收藏夹。'); } audit(user.id, 'folder.create', folderId); return ok(res, db.prepare('SELECT * FROM folders WHERE id=?').get(folderId), 201); } return fail(res, 405, 'METHOD_NOT_ALLOWED', '不支持的收藏夹操作。'); }
  const folderMatch = path.match(/^\/api\/folders\/([^/]+)$/);
  const folderItemMatch = path.match(/^\/api\/folders\/([^/]+)\/items\/([^/]+)$/);
  if (folderItemMatch && req.method === 'DELETE') { const user = requireUser(req, res); if (!user) return; const folder = db.prepare('SELECT id FROM folders WHERE id=? AND user_id=?').get(folderItemMatch[1], user.id); const item = itemForUser(user.id, folderItemMatch[2]); if (!folder || !item) return fail(res, 404, 'NOT_FOUND', '未找到收藏夹或文章。'); const result = db.prepare('DELETE FROM item_folders WHERE folder_id=? AND item_id=?').run(folder.id, item.id); if (!result.changes) return fail(res, 404, 'NOT_FOUND', '文章不在该收藏夹中。'); audit(user.id, 'folder.item.remove', folder.id); return ok(res, { removed: true }); }
  if (folderMatch) { const user = requireUser(req, res); if (!user) return; const folder = db.prepare('SELECT * FROM folders WHERE id=? AND user_id=?').get(folderMatch[1], user.id); if (!folder) return fail(res, 404, 'NOT_FOUND', '未找到收藏夹。'); if (req.method === 'GET') return ok(res, folderDetail(user.id, folder.id, url.searchParams)); if (req.method === 'PATCH') { const body = await readBody(req); const name = normalizedName(body.name, { maxLength: 9 }); if (!name) return fail(res, 400, 'INVALID_FOLDER', '收藏夹名称为 1-9 个字符，且不能包含控制字符。'); try { db.prepare('UPDATE folders SET name=? WHERE id=?').run(name, folder.id); } catch { return fail(res, 409, 'DUPLICATE_FOLDER', '已存在同名收藏夹。'); } audit(user.id, 'folder.rename', folder.id); return ok(res, db.prepare('SELECT * FROM folders WHERE id=?').get(folder.id)); } if (req.method === 'DELETE') { const removed = db.prepare('SELECT count(*) AS total FROM item_folders WHERE folder_id=?').get(folder.id).total; db.prepare('DELETE FROM folders WHERE id=?').run(folder.id); audit(user.id, 'folder.delete', folder.id); return ok(res, { deleted: true, removed }); } return fail(res, 405, 'METHOD_NOT_ALLOWED', '不支持的收藏夹操作。'); }
  if (path === '/api/tokens') { const user = requireUser(req, res); if (!user) return; if (req.method === 'GET') return ok(res, db.prepare('SELECT id,name,token_ciphertext,scopes,created_at,last_used_at FROM api_tokens WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC').all(user.id).map((row) => ({ ...row, token: decryptToken(row.token_ciphertext), scopes: parse(row.scopes) }))); if (req.method === 'POST') { const body = await readBody(req); const token = `pl_${randomBytes(24).toString('base64url')}`; const tokenId = id('tok'); const scopes = ['items:read', 'items:write']; db.prepare('INSERT INTO api_tokens (id,user_id,name,token_hash,token_ciphertext,scopes,created_at) VALUES (?,?,?,?,?,?,?)').run(tokenId, user.id, String(body.name || '未命名 Token').slice(0, 80), tokenHash(token), encryptToken(token), json(scopes), now()); audit(user.id, 'token.create', tokenId); return ok(res, { id: tokenId, token, scopes }, 201); } }
  const tokenMatch = path.match(/^\/api\/tokens\/([^/]+)$/);
  if (tokenMatch && req.method === 'DELETE') { const user = requireUser(req, res); if (!user) return; const result = db.prepare('DELETE FROM api_tokens WHERE id=? AND user_id=?').run(tokenMatch[1], user.id); if (!result.changes) return fail(res, 404, 'NOT_FOUND', '未找到 Token。'); audit(user.id, 'token.delete', tokenMatch[1]); return ok(res, { deleted: true }); }
  if (path === '/api/export' && req.method === 'GET') { const user = requireUser(req, res); if (!user) return; const data = listItems(user.id, new URLSearchParams()).items.map(({ html_snapshot, highlights, ...item }) => item); if (url.searchParams.get('format') === 'csv') { const columns = ['title', 'url', 'fetch_status', 'is_read', 'is_archived', 'is_favorite', 'tags', 'folders', 'created_at']; const csv = [columns.join(','), ...data.map((item) => columns.map((column) => { const value = ['tags', 'folders'].includes(column) ? item[column].map((entry) => entry.name).join('|') : item[column]; return `"${String(value ?? '').replaceAll('"', '""')}"`; }).join(','))].join('\n'); res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="paperleaf-export.csv"' }); return res.end(`\ufeff${csv}`); } res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="paperleaf-export.json"' }); return res.end(JSON.stringify({ version: '0.0.2', exportedAt: now(), items: data }, null, 2)); }
  if (path === '/api/import' && req.method === 'POST') { const user = requireUser(req, res); if (!user) return; const body = await readBody(req); const urls = Array.isArray(body.urls) ? body.urls.slice(0, 50) : []; const results = []; for (const value of urls) { try { const result = await createItem(user.id, { url: value, tags: body.tags || [], folderId: body.folderId }); results.push({ url: value, success: true, duplicate: result.duplicate, id: result.item.id }); } catch (error) { results.push({ url: value, success: false, error: error.message }); } } return ok(res, { total: urls.length, successful: results.filter((result) => result.success).length, results }); }
  if (path === '/api/users') { const user = requireUser(req, res); if (!user || user.role !== 'admin') return fail(res, 403, 'FORBIDDEN', '需要管理员权限。'); if (req.method === 'GET') return ok(res, db.prepare('SELECT id,username,role,disabled,created_at,updated_at FROM users ORDER BY created_at').all().map((row) => ({ ...row, disabled: Boolean(row.disabled) }))); if (req.method === 'POST') { const body = await readBody(req); const username = String(body.username || '').trim(); if (!/^[a-zA-Z0-9_-]{3,40}$/.test(username) || String(body.password || '').length < 12) return fail(res, 400, 'INVALID_USER', '用户名为 3-40 位字母、数字、下划线或连字符，密码至少 12 位。'); const userId = id('usr'); try { db.prepare('INSERT INTO users (id,username,password_hash,role,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(userId, username, await passwordHash(body.password), body.role === 'admin' ? 'admin' : 'user', now(), now()); } catch { return fail(res, 409, 'DUPLICATE_USER', '用户名已存在。'); } audit(user.id, 'user.create', userId); return ok(res, db.prepare('SELECT id,username,role,disabled,created_at FROM users WHERE id=?').get(userId), 201); } }
  const userMatch = path.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && req.method === 'PATCH') { const user = requireUser(req, res); if (!user || user.role !== 'admin') return fail(res, 403, 'FORBIDDEN', '需要管理员权限。'); const body = await readBody(req); if (typeof body.disabled !== 'boolean') return fail(res, 400, 'INVALID_USER', '缺少 disabled 状态。'); if (user.id === userMatch[1] && body.disabled) return fail(res, 400, 'INVALID_USER', '不能禁用当前登录管理员。'); db.prepare('UPDATE users SET disabled=?,updated_at=? WHERE id=?').run(Number(body.disabled), now(), userMatch[1]); audit(user.id, 'user.disable', userMatch[1]); return ok(res, { updated: true }); }
  if (path === '/api/v1/items') { const user = tokenUser(req, req.method === 'POST' ? ['items:write'] : ['items:read']); if (!user) return fail(res, 401, 'INVALID_TOKEN', 'Token 无效、已撤销或没有所需权限。'); if (req.method === 'GET') return ok(res, listItems(user.id, url.searchParams)); if (req.method === 'POST') { const result = await createItem(user.id, await readBody(req)); return ok(res, result, result.duplicate ? 200 : 201); } }
  const v1Match = path.match(/^\/api\/v1\/items\/([^/]+)$/);
  if (v1Match && req.method === 'GET') { const user = tokenUser(req, ['items:read']); if (!user) return fail(res, 401, 'INVALID_TOKEN', 'Token 无效、已撤销或没有所需权限。'); const item = itemForUser(user.id, v1Match[1]); return item ? ok(res, itemData(item)) : fail(res, 404, 'NOT_FOUND', '未找到该条目。'); }
  return fail(res, 404, 'NOT_FOUND', '接口不存在。');
}

function printable(req, res, url) {
  const user = currentUser(req); const item = user && itemForUser(user.id, url.searchParams.get('id'));
  if (!item) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('未找到内容。'); }
  const savedAt = new Date(item.created_at); const pad = (value) => String(value).padStart(2, '0'); const savedLabel = `${savedAt.getFullYear()}年${pad(savedAt.getMonth() + 1)}月${pad(savedAt.getDate())}日 ${pad(savedAt.getHours())}:${pad(savedAt.getMinutes())}`;
  const document = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${html(item.title)}</title><style>body{max-width:760px;margin:48px auto;color:#28231b;font:17px/1.8 "Songti SC",Georgia,"Times New Roman",serif;padding:0 24px}h1{font-size:30px;line-height:1.3}.meta{color:#6d624e;font-size:13px;border-bottom:1px solid #cdbb95;padding-bottom:18px;margin-bottom:32px;word-break:break-all}a{color:#7e3917}@media print{body{margin:0;max-width:none}.no-print{display:none}}</style><body><button class="no-print" onclick="print()">打印 / 另存为 PDF</button><h1>${html(item.title)}</h1><p class="meta">原文：<a href="${html(item.url)}">${html(item.url)}</a><br>保存时间：${html(savedLabel)}</p><article>${item.html_snapshot || `<p>${html(item.fetch_error || '此网页未能生成快照。')}</p>`}</article></body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:;" }); res.end(document);
}
function serveArchive(req, res, url) {
  const user = currentUser(req); const match = url.pathname.match(/^\/archive\/([^/]+)\/([^/]+)$/);
  if (!user || !match) { res.writeHead(404); return res.end('Not found'); }
  const item = itemForUser(user.id, decodeURIComponent(match[1]));
  const filename = decodeURIComponent(match[2]);
  const archive = item && archiveInfo(item, user);
  if (!item || (filename !== archive.documentFile && filename !== archive.pdfFile && !/^image-\d{3}\.(?:jpe?g|png|gif|webp|avif|svg|img)$/i.test(filename))) { res.writeHead(404); return res.end('Not found'); }
  const file = resolve(archive.directory, filename);
  if (!file.startsWith(resolve(archive.directory)) || !existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.html': 'text/html; charset=utf-8', '.pdf': 'application/pdf' };
  res.writeHead(200, { 'Content-Type': types[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'private, max-age=31536000, immutable' }); createReadStream(file).pipe(res);
}
function serveStatic(req, res, url) {
  if (url.pathname === '/print') return printable(req, res, url);
  if (url.pathname.startsWith('/archive/')) return serveArchive(req, res, url);
  const requested = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
  const staticRoot = requested.startsWith('extension/') ? join(root, 'extension') : publicDir;
  const relativePath = requested.startsWith('extension/') ? requested.slice('extension/'.length) : requested;
  const file = normalize(join(staticRoot, relativePath));
  const fileRelative = relative(staticRoot, file);
  if (fileRelative.startsWith('..') || isAbsolute(fileRelative) || !existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
  res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); createReadStream(file).pipe(res);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  migrate(); await seed(); migrateArchivePaths(); await createMissingArchivePdfs();
  createServer(async (req, res) => { try { const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); if (url.pathname.startsWith('/api/')) await api(req, res, url); else serveStatic(req, res, url); } catch (error) { console.error(error); fail(res, 500, 'INTERNAL_ERROR', '请求未完成，请稍后重试。'); } }).listen(port, host, () => console.log(`PaperLeaf listening on http://${host}:${port}`));
}

export { archiveSegment, archiveSnapshot, clearItemArchive, createArchivePdf, fetchPage, itemData, sanitizeDocument };
