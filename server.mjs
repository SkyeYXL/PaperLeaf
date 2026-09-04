import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import QRCode from 'qrcode';
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
const configuredTokenSecret = process.env.PAPERLEAF_TOKEN_ENCRYPTION_KEY || '';
let tokenEncryptionSecret = configuredTokenSecret || (existsSync(tokenKeyPath) ? readFileSync(tokenKeyPath, 'utf8').trim() : (() => { const key = randomBytes(32).toString('base64url'); writeFileSync(tokenKeyPath, key, { mode: 0o600 }); return key; })());
let tokenEncryptionKey = createHash('sha256').update(tokenEncryptionSecret).digest();

const now = () => new Date().toISOString();
// 微信读书公众号接口仅返回最新一篇文章；默认每小时检查一次，用户可调整同步频率。
const mpSyncMinutes = 60;
const mpSyncMinuteOptions = new Set([60, 240, 360, 480, 720, 1440]);
const mpArticlePageSizeOptions = new Set([10, 20, 50, 100]);
// Both administrator backup entry points must preserve the same user-owned data.
// Authentication cookies, deduplication records and sync logs are intentionally excluded.
const serviceBackupTables = Object.freeze(['users', 'items', 'tags', 'item_tags', 'folders', 'item_folders', 'highlights', 'api_tokens', 'audit_logs', 'user_preferences', 'timeline_events', 'mp_sync_settings', 'mp_subscriptions']);
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
    CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, url TEXT NOT NULL, normalized_url TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', html_snapshot TEXT NOT NULL DEFAULT '', fetch_status TEXT NOT NULL, fetch_error TEXT, fetch_warning TEXT, source_type TEXT NOT NULL DEFAULT 'web', source_label TEXT NOT NULL DEFAULT '', mp_image_url TEXT NOT NULL DEFAULT '', is_read INTEGER NOT NULL DEFAULT 0, is_archived INTEGER NOT NULL DEFAULT 0, is_favorite INTEGER NOT NULL DEFAULT 0, reading_progress REAL NOT NULL DEFAULT 0, last_opened_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(user_id, name));
    CREATE TABLE IF NOT EXISTS item_tags (item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(item_id, tag_id));
    CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE(user_id, name));
    CREATE TABLE IF NOT EXISTS item_folders (item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE, PRIMARY KEY(item_id, folder_id));
    CREATE TABLE IF NOT EXISTS highlights (id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, text TEXT NOT NULL, note_title TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT 'yellow', start_offset INTEGER, end_offset INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS api_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT);
    CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, target_id TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS user_preferences (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, homepage_view TEXT NOT NULL DEFAULT 'list', reader_display TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS timeline_events (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, item_id TEXT NOT NULL, highlight_id TEXT, event_type TEXT NOT NULL, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS weread_auth (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, encrypted_cookie TEXT NOT NULL, vid TEXT NOT NULL, account_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', verified_at TEXT NOT NULL, keepalive_at TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mp_sync_settings (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, refresh_minutes INTEGER NOT NULL DEFAULT 60, last_run_at TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mp_subscriptions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, book_id TEXT NOT NULL, name TEXT NOT NULL, cover_url TEXT NOT NULL DEFAULT '', rss_token TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, latest_title TEXT NOT NULL DEFAULT '', last_sync_at TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(user_id, book_id));
    CREATE TABLE IF NOT EXISTS mp_review_records (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, subscription_id TEXT NOT NULL REFERENCES mp_subscriptions(id) ON DELETE CASCADE, review_id TEXT NOT NULL, item_id TEXT REFERENCES items(id) ON DELETE SET NULL, content_status TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(subscription_id, review_id));
    CREATE TABLE IF NOT EXISTS mp_sync_runs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, discovered_count INTEGER NOT NULL DEFAULT 0, imported_count INTEGER NOT NULL DEFAULT 0, error_message TEXT);
  `);
  const itemColumns = db.prepare('PRAGMA table_info(items)').all().map((column) => column.name);
  if (!itemColumns.includes('reading_progress')) db.exec('ALTER TABLE items ADD COLUMN reading_progress REAL NOT NULL DEFAULT 0');
  if (!itemColumns.includes('last_opened_at')) db.exec('ALTER TABLE items ADD COLUMN last_opened_at TEXT');
  if (!itemColumns.includes('archive_folder')) db.exec("ALTER TABLE items ADD COLUMN archive_folder TEXT NOT NULL DEFAULT ''");
  if (!itemColumns.includes('fetch_warning')) db.exec('ALTER TABLE items ADD COLUMN fetch_warning TEXT');
  if (!itemColumns.includes('source_type')) db.exec("ALTER TABLE items ADD COLUMN source_type TEXT NOT NULL DEFAULT 'web'");
  if (!itemColumns.includes('source_label')) db.exec("ALTER TABLE items ADD COLUMN source_label TEXT NOT NULL DEFAULT ''");
  if (!itemColumns.includes('mp_image_url')) db.exec("ALTER TABLE items ADD COLUMN mp_image_url TEXT NOT NULL DEFAULT ''");
  const wereadAuthColumns = db.prepare('PRAGMA table_info(weread_auth)').all().map((column) => column.name);
  if (!wereadAuthColumns.includes('keepalive_at')) db.exec('ALTER TABLE weread_auth ADD COLUMN keepalive_at TEXT');
  const mpSubscriptionColumns = db.prepare('PRAGMA table_info(mp_subscriptions)').all().map((column) => column.name);
  if (!mpSubscriptionColumns.includes('rss_token')) db.exec("ALTER TABLE mp_subscriptions ADD COLUMN rss_token TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  // v0.0.4 早期版本曾强制每天同步一次；仅首次升级时将该旧默认值迁移为每小时，
  // 之后保留用户在“同步频率”中保存的选择。
  if (!db.prepare('SELECT name FROM app_migrations WHERE name=?').get('mp-sync-frequency-v2')) {
    db.prepare('UPDATE mp_sync_settings SET refresh_minutes=?,updated_at=? WHERE refresh_minutes=?').run(mpSyncMinutes, now(), 1440);
    db.prepare('INSERT INTO app_migrations (name,applied_at) VALUES (?,?)').run('mp-sync-frequency-v2', now());
  }
  db.prepare(`UPDATE mp_sync_settings SET refresh_minutes=?,updated_at=? WHERE refresh_minutes NOT IN (${[...mpSyncMinuteOptions].join(',')})`).run(mpSyncMinutes, now());
  db.prepare("SELECT id FROM mp_subscriptions WHERE rss_token='' OR rss_token IS NULL").all().forEach((subscription) => {
    db.prepare('UPDATE mp_subscriptions SET rss_token=? WHERE id=?').run(id('rss'), subscription.id);
  });
  db.exec(`UPDATE items SET source_type='mp',source_label=COALESCE((SELECT s.name FROM mp_review_records r LEFT JOIN mp_subscriptions s ON s.id=r.subscription_id WHERE r.item_id=items.id LIMIT 1),'') WHERE source_type <> 'mp' AND EXISTS (SELECT 1 FROM mp_review_records r WHERE r.item_id=items.id)`);
  const itemSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='items'").get()?.sql || '';
  if (/UNIQUE\s*\(\s*user_id\s*,\s*normalized_url\s*\)/i.test(itemSchema)) {
    db.exec('PRAGMA foreign_keys=OFF');
    try {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE items_repeated_capture (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, url TEXT NOT NULL, normalized_url TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', html_snapshot TEXT NOT NULL DEFAULT '', fetch_status TEXT NOT NULL, fetch_error TEXT, fetch_warning TEXT, source_type TEXT NOT NULL DEFAULT 'web', source_label TEXT NOT NULL DEFAULT '', mp_image_url TEXT NOT NULL DEFAULT '', is_read INTEGER NOT NULL DEFAULT 0, is_archived INTEGER NOT NULL DEFAULT 0, is_favorite INTEGER NOT NULL DEFAULT 0, reading_progress REAL NOT NULL DEFAULT 0, last_opened_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archive_folder TEXT NOT NULL DEFAULT '');
        INSERT INTO items_repeated_capture (id,user_id,url,normalized_url,title,summary,html_snapshot,fetch_status,fetch_error,fetch_warning,source_type,source_label,mp_image_url,is_read,is_archived,is_favorite,reading_progress,last_opened_at,created_at,updated_at,archive_folder)
          SELECT id,user_id,url,normalized_url,title,summary,html_snapshot,fetch_status,fetch_error,fetch_warning,source_type,source_label,mp_image_url,is_read,is_archived,is_favorite,reading_progress,last_opened_at,created_at,updated_at,archive_folder FROM items;
        DROP TABLE items;
        ALTER TABLE items_repeated_capture RENAME TO items;
      COMMIT;`);
    } catch (error) { try { db.exec('ROLLBACK'); } catch { /* The transaction may already have rolled back. */ } throw error; }
    finally { db.exec('PRAGMA foreign_keys=ON'); }
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('重复抓取迁移后的数据库外键校验失败。');
  }
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
  db.exec('CREATE INDEX IF NOT EXISTS idx_items_user_normalized_url ON items(user_id, normalized_url)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_timeline_events_user_occurred_at ON timeline_events(user_id, occurred_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_timeline_events_item_occurred_at ON timeline_events(item_id, occurred_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_timeline_events_highlight_occurred_at ON timeline_events(highlight_id, occurred_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_mp_subscriptions_user_updated_at ON mp_subscriptions(user_id, updated_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_mp_sync_runs_user_started_at ON mp_sync_runs(user_id, started_at DESC)');
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
function readBody(req) { return new Promise((resolveBody, reject) => { let body = ''; let tooLarge = false; req.on('data', (chunk) => { if (tooLarge) return; body += chunk; if (body.length > 50_000_000) { tooLarge = true; reject(new Error('导入文件不能超过 50MB。')); } }); req.on('end', () => { if (tooLarge) return; try { resolveBody(body ? JSON.parse(body) : {}); } catch { reject(new Error('请求体必须是 JSON。')); } }); req.on('error', reject); }); }
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
async function fetchPageHttp(input) {
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
async function fetchPageInBrowser(input) {
  const url = publicUrl(unwrapWechatArticleUrl(input)).toString();
  const executable = process.env.PAPERLEAF_CAPTURE_BROWSER || pdfBrowserExecutable();
  if (!executable) throw new Error('未找到可用的 Chromium 浏览器。');
  const browser = await pdfChromium().launch({ headless: true, executablePath: executable, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage({ locale: 'zh-CN', userAgent: pageHeaders['User-Agent'] });
    await page.route('**/*', (route) => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        try { publicUrl(request.url()); } catch { return route.abort(); }
      }
      return route.continue();
    });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
    const finalUrl = publicUrl(page.url()).toString();
    if (!response?.ok()) throw new Error(`浏览器访问网页返回 HTTP ${response?.status() ?? '未知'}。`);
    const source = await page.content();
    if (isVerificationPage(source, finalUrl)) throw new Error('目标站要求浏览器验证，未保存验证页。');
    // Some public document services (such as KDocs knowledge bases) keep the
    // rendered document in one or more same-origin iframes.  Capturing only
    // page.content() would preserve the application shell instead of the
    // readable document.  Do not follow cross-origin frames: they are not part
    // of the requested document and may be unrelated embeds or advertisements.
    const pageOrigin = new URL(finalUrl).origin;
    const candidates = await Promise.all(page.frames().map(async (frame) => {
      let frameUrl;
      try { frameUrl = publicUrl(frame.url()).toString(); }
      catch { return null; }
      if (frame !== page.mainFrame() && new URL(frameUrl).origin !== pageOrigin) return null;
      try {
        const frameSource = frame === page.mainFrame() ? source : await frame.content();
        return { url: frameUrl, page: sanitizeDocument(frameSource, frameUrl) };
      } catch { return null; }
    }));
    const selected = candidates.filter(Boolean).reduce((best, candidate) => {
      const bestScore = best ? (best.page.textLength * 10_000) + best.page.imageCount : -1;
      const candidateScore = (candidate.page.textLength * 10_000) + candidate.page.imageCount;
      return candidateScore > bestScore ? candidate : best;
    }, null);
    const captured = selected?.page || sanitizeDocument(source, finalUrl);
    if (!captured.textLength && !captured.imageCount) throw new Error('浏览器已打开网页，但未获得可提取的正文。');
    return { url: selected?.url || finalUrl, ...captured };
  } finally {
    await browser.close();
  }
}
async function fetchPage(input) {
  try {
    return await fetchPageHttp(input);
  } catch (httpError) {
    try {
      return await fetchPageInBrowser(input);
    } catch (browserError) {
      throw new Error(`${httpError.message}；浏览器渲染备用抓取失败：${browserError.message}`);
    }
  }
}
function clientSnapshotPage(payload, sourceUrl) {
  const source = String(payload?.htmlSnapshot || '').trim();
  if (!source) return null;
  const page = sanitizeDocument(source, sourceUrl);
  return page.textLength || page.imageCount ? { url: sourceUrl, ...page } : null;
}
function textOnly(value = '') { return String(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
function decodeHtmlEntities(value) {
  let decoded = String(value || '');
  for (let pass = 0; pass < 4; pass += 1) {
    const next = decoded.replace(/&(?:(#x[0-9a-f]+)|(#\d+)|(amp|quot|lt|gt));/gi, (_match, hex, decimal, named) => {
      if (named) return ({ amp: '&', quot: '"', lt: '<', gt: '>' }[named.toLowerCase()] || _match);
      const codePoint = Number.parseInt(hex ? hex.slice(2) : decimal.slice(1), hex ? 16 : 10);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : _match;
    });
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}
function safeImageUrl(value, baseUrl) {
  try {
    // Publishers can nest named and numeric entities in signed image URLs,
    // e.g. &amp;#x26; must become a literal query-string ampersand.
    const decoded = decodeHtmlEntities(value);
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
async function createMissingArchivePdfs({ force = false } = {}) {
  const rows = db.prepare("SELECT * FROM items WHERE fetch_status='ready' AND trim(html_snapshot)<>'' ORDER BY created_at,id").all();
  for (const item of rows) {
    const archive = archiveInfo(item);
    const documentPath = join(archive.directory, archive.documentFile);
    const pdfPath = join(archive.directory, archive.pdfFile);
    if (!existsSync(documentPath) || (!force && existsSync(pdfPath))) continue;
    // The archived document rewrites downloaded images to local files.  The database snapshot
    // deliberately keeps its original URLs, so using it here can create a PDF without images.
    const localSnapshot = readFileSync(documentPath, 'utf8');
    try { await createArchivePdf(archive.directory, archive, localSnapshot, { title: item.title, url: item.url }); }
    catch (error) { console.warn(`PDF archive skipped for ${item.id}: ${error.message}`); }
  }
}
async function createItemPdf(item) {
  if (!item || item.fetch_status !== 'ready' || !String(item.html_snapshot || '').trim()) throw new Error('文章尚未生成可用的 HTML 档案。');
  const archive = archiveInfo(item, archiveUser(item.user_id));
  const documentPath = join(archive.directory, archive.documentFile);
  if (!existsSync(documentPath)) throw new Error('文章 HTML 档案不存在，请先重新抓取文章。');
  await createArchivePdf(archive.directory, archive, readFileSync(documentPath, 'utf8'), { title: item.title, url: item.url });
  return itemData(itemForUser(item.user_id, item.id));
}
let monitoredLibraryFingerprint = null;
function libraryFingerprint() {
  if (!existsSync(archiveDir)) return `missing:${archiveDir}`;
  try {
    const root = statSync(archiveDir);
    const children = readdirSync(archiveDir).sort().map((entry) => {
      try { const stat = statSync(join(archiveDir, entry)); return `${entry}:${stat.mtimeMs}:${stat.size}`; }
      catch { return `${entry}:missing`; }
    });
    return `${archiveDir}:${root.mtimeMs}|${children.join('|')}`;
  } catch { return `unreadable:${archiveDir}`; }
}
function noteLibraryMutation() {
  if (monitoredLibraryFingerprint !== null) monitoredLibraryFingerprint = libraryFingerprint();
}
function startLibraryMonitor() {
  monitoredLibraryFingerprint = libraryFingerprint(); let running = false;
  const scan = async () => {
    if (running) return;
    const current = libraryFingerprint();
    if (current === monitoredLibraryFingerprint) return;
    running = true;
    try {
      const items = db.prepare("SELECT * FROM items WHERE fetch_status='ready' ORDER BY created_at,id").all();
      for (const item of items) { try { await refetchItem(item); } catch (error) { console.warn(`Library scan skipped ${item.id}: ${error.message}`); } }
    } finally { monitoredLibraryFingerprint = libraryFingerprint(); running = false; }
  };
  const timer = setInterval(() => { void scan(); }, 60 * 60 * 1000);
  timer.unref?.();
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
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="${html(pathToFileURL(`${staging}${sep}`).href)}"><title>${html(metadata.title || '未命名文章')}</title><style>@page{size:A4;margin:18mm 16mm}body{color:#28231b;font:16px/1.8 "Noto Serif CJK SC","Noto Serif CJK","Songti SC",Georgia,"Times New Roman",serif}h1{font:700 26px/1.35 "Noto Sans CJK SC","Noto Sans CJK",system-ui,"Microsoft YaHei",sans-serif;margin:0 0 10px}.meta{color:#6d624e;font:13px/1.6 "Noto Sans CJK SC","Noto Sans CJK",system-ui,"Microsoft YaHei",sans-serif;border-bottom:1px solid #d7c9aa;padding-bottom:12px;margin:0 0 28px;word-break:break-all}img{display:block;max-width:100%;height:auto;margin:16px auto}pre{white-space:pre-wrap;word-break:break-word}table{max-width:100%;border-collapse:collapse}th,td{border:1px solid #cfc4ab;padding:6px;vertical-align:top}</style></head><body><h1>${html(metadata.title || '未命名文章')}</h1>${source}<article>${localSnapshot}</article></body></html>`;
}
async function createArchivePdf(staging, archive, snapshot, metadata = {}) {
  const executable = pdfBrowserExecutable();
  if (!executable) throw new Error('未找到可用的 Chromium 浏览器，无法生成 PDF。');
  const pdfFile = join(staging, archive.pdfFile);
  const pdfSourceFile = join(staging, '.paperleaf-pdf-source.html');
  // PDF input uses a file: base URL so archived image assets can be embedded without relying on the original site.
  const browser = await pdfChromium().launch({ headless: true, executablePath: executable, args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
  try {
    const page = await browser.newPage();
    // Navigating to a local file (instead of injecting into about:blank) gives its sibling archive assets
    // a file origin that Chromium is allowed to read during PDF rendering.
    writeFileSync(pdfSourceFile, pdfDocument(snapshot, metadata, staging), 'utf8');
    await page.goto(pathToFileURL(pdfSourceFile).href, { waitUntil: 'load', timeout: 30_000 });
    const imageState = await page.evaluate(async () => {
      const images = Array.from(document.images).filter((image) => image.getAttribute('src'));
      await Promise.all(images.map((image) => image.decode?.().catch(() => undefined)));
      return images.map((image) => ({ src: image.currentSrc || image.src, complete: image.complete, width: image.naturalWidth }));
    });
    const missingImages = imageState.filter((image) => !image.complete || image.width === 0);
    if (missingImages.length) throw new Error(`${missingImages.length} 张文章图片未能载入，已取消生成不完整 PDF。`);
    await page.pdf({ path: pdfFile, format: 'A4', printBackground: true, margin: { top: '18mm', right: '16mm', bottom: '18mm', left: '16mm' } });
    if (!existsSync(pdfFile) || readFileSync(pdfFile).subarray(0, 4).toString() !== '%PDF') throw new Error('浏览器未生成有效 PDF 文件。');
  } finally {
    await browser.close();
    try { if (existsSync(pdfSourceFile)) unlinkSync(pdfSourceFile); } catch { /* A later rebuild can safely replace this ephemeral source. */ }
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
    noteLibraryMutation();
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
const WEREAD_BASE = 'https://weread.qq.com';
const wereadQrSessions = new Map();
const wereadKeepAliveInFlight = new Map();
const wereadBrowserProfileInFlight = new Map();
const mpSyncInFlight = new Map();
const wereadKeepAliveIntervalMs = 6 * 60 * 60 * 1000;
const wereadHeaders = {
  'User-Agent': pageHeaders['User-Agent'],
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Origin: WEREAD_BASE,
  Referer: `${WEREAD_BASE}/`
};
class WereadError extends Error { constructor(code, message) { super(message); this.code = code; } }
function setCookieMap(target, headers) {
  const values = typeof headers?.getSetCookie === 'function' ? headers.getSetCookie() : (headers?.get('set-cookie') ? [headers.get('set-cookie')] : []);
  for (const value of values) {
    const pair = String(value).split(';', 1)[0]; const index = pair.indexOf('=');
    if (index > 0) target.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}
function cookieHeader(cookieMap) { return [...cookieMap.entries()].map(([key, value]) => `${key}=${value}`).join('; '); }
function cookieMapFromHeader(value) {
  const jar = new Map();
  for (const part of String(value || '').split(';')) {
    const item = part.trim(); const index = item.indexOf('=');
    if (index > 0) jar.set(item.slice(0, index).trim(), item.slice(index + 1).trim());
  }
  return jar;
}
function wereadProfileDirectory(userId) {
  // 不使用原始用户 ID 作为目录名，避免泄露标识，也防止路径拼接风险。
  return join(dataDir, 'weread-browser-profiles', createHash('sha256').update(String(userId)).digest('hex'));
}
function clearWereadProfileSingletonLocks(profile) {
  // Chromium 在容器被强制停止时可能遗留单实例锁；只移除 Profile 根目录内的锁本身，绝不递归清理登录数据。
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const target = join(profile, name);
    try { rmSync(target, { force: true }); } catch { /* 下次启动或 renewal 回退会继续处理。 */ }
  }
}
function isWereadProfileLockError(error) { return /singleton(lock|cookie|socket)|process singleton|user data directory is already in use/i.test(String(error?.message || '')); }
function removeWereadBrowserProfile(userId) {
  const profileRoot = join(dataDir, 'weread-browser-profiles'); const profile = wereadProfileDirectory(userId);
  const child = relative(profileRoot, profile);
  if (child && !child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child) && existsSync(profile)) rmSync(profile, { recursive: true, force: true });
}
function wereadBrowserExecutable() { return process.env.PAPERLEAF_WEREAD_BROWSER || pdfBrowserExecutable(); }
function wereadReaderUrl(userId) {
  const row = db.prepare('SELECT book_id FROM mp_subscriptions WHERE user_id=? AND enabled=1 ORDER BY created_at ASC LIMIT 1').get(userId);
  return row?.book_id ? `${WEREAD_BASE}/web/mp/reader/${encodeURIComponent(row.book_id)}` : `${WEREAD_BASE}/`;
}
async function openWereadBrowserProfile(userId, cookie, { navigate = false } = {}) {
  const earlier = wereadBrowserProfileInFlight.get(userId) || Promise.resolve();
  const task = earlier.catch(() => undefined).then(async () => {
    const executable = wereadBrowserExecutable();
    if (!executable) throw new WereadError('WEREAD_BROWSER_UNAVAILABLE', '未找到可用于微信读书自动保活的本机浏览器。');
    const launch = { headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] };
    if (executable !== 'chromium') launch.executablePath = executable;
    const profile = wereadProfileDirectory(userId);
    let context;
    try {
      try { context = await pdfChromium().launchPersistentContext(profile, launch); }
      catch (error) {
        if (!isWereadProfileLockError(error)) throw error;
        clearWereadProfileSingletonLocks(profile);
        context = await pdfChromium().launchPersistentContext(profile, launch);
      }
      const jar = cookieMapFromHeader(cookie);
      const browserCookies = [...jar.entries()].filter(([, value]) => value).map(([name, value]) => ({ name, value, url: WEREAD_BASE }));
      if (browserCookies.length) await context.addCookies(browserCookies);
      if (navigate) {
        const page = await context.newPage();
        try { await page.goto(wereadReaderUrl(userId), { waitUntil: 'domcontentloaded', timeout: 30_000 }); }
        catch { /* 即使 reader 页重定向或超时，Cookie jar 仍可能已被刷新。 */ }
        await page.waitForTimeout(1_200);
      }
      const refreshed = new Map((await context.cookies(WEREAD_BASE)).map((entry) => [entry.name, entry.value]));
      return cookieHeader(refreshed) || cookie;
    } finally {
      await context?.close().catch(() => undefined);
    }
  });
  wereadBrowserProfileInFlight.set(userId, task);
  try { return await task; }
  finally { if (wereadBrowserProfileInFlight.get(userId) === task) wereadBrowserProfileInFlight.delete(userId); }
}
async function seedWereadBrowserProfile(userId, cookie) {
  // 首次扫码后仅写入独立 Profile；不影响扫码结果，也不把浏览器启动失败暴露给用户。
  try { await openWereadBrowserProfile(userId, cookie); } catch { /* 下次保活仍会尝试 renewal。 */ }
}
function saveWereadAuth(userId, previous, cookie, { keepaliveAt = null } = {}) {
  const jar = cookieMapFromHeader(cookie); const vid = jar.get('wr_vid') || previous?.vid || '';
  if (!vid) throw new WereadError('WEREAD_COOKIE_INVALID', '微信读书授权信息不完整，请重新扫码。');
  const time = now();
  db.prepare(`INSERT INTO weread_auth (user_id,encrypted_cookie,vid,account_name,status,verified_at,keepalive_at,updated_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET encrypted_cookie=excluded.encrypted_cookie,vid=excluded.vid,account_name=excluded.account_name,status='active',verified_at=excluded.verified_at,keepalive_at=excluded.keepalive_at,updated_at=excluded.updated_at`)
    .run(userId, encryptToken(cookie), vid, previous?.account_name || '', 'active', time, keepaliveAt, time);
  return userWereadAuth(userId);
}
function userWereadAuth(userId) {
  const row = db.prepare('SELECT * FROM weread_auth WHERE user_id=?').get(userId);
  if (!row) return null;
  const cookie = decryptToken(row.encrypted_cookie);
  return cookie ? { ...row, cookie } : null;
}
function publicWereadAuth(userId) {
  const row = db.prepare('SELECT account_name,status,verified_at,keepalive_at,updated_at FROM weread_auth WHERE user_id=?').get(userId);
  return row ? { configured: true, accountName: row.account_name || '微信读书账户', status: row.status, verifiedAt: row.verified_at, keepAliveAt: row.keepalive_at, updatedAt: row.updated_at } : { configured: false, status: 'missing' };
}
function mpSettings(userId) {
  let row = db.prepare('SELECT * FROM mp_sync_settings WHERE user_id=?').get(userId);
  if (!row) {
    db.prepare('INSERT INTO mp_sync_settings (user_id,refresh_minutes,updated_at) VALUES (?,?,?)').run(userId, mpSyncMinutes, now());
    row = db.prepare('SELECT * FROM mp_sync_settings WHERE user_id=?').get(userId);
  }
  if (!mpSyncMinuteOptions.has(Number(row.refresh_minutes))) {
    db.prepare('UPDATE mp_sync_settings SET refresh_minutes=?,updated_at=? WHERE user_id=?').run(mpSyncMinutes, now(), userId);
    row = db.prepare('SELECT * FROM mp_sync_settings WHERE user_id=?').get(userId);
  }
  return { syncMinutes: Number(row.refresh_minutes), lastRunAt: row.last_run_at, updatedAt: row.updated_at };
}
async function wereadRequest(path, { cookie = '', method = 'GET', body = null } = {}) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const headers = { ...wereadHeaders }; if (cookie) headers.Cookie = cookie;
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${WEREAD_BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
    return response;
  } catch (error) {
    if (error?.name === 'AbortError') throw new WereadError('WEREAD_TIMEOUT', '微信读书请求超时，请稍后重试。');
    throw new WereadError('WEREAD_NETWORK', '无法连接微信读书，请检查服务网络后重试。');
  } finally { clearTimeout(timeout); }
}
async function wereadJson(path, options = {}) {
  const response = await wereadRequest(path, options);
  let payload = null; try { payload = await response.json(); } catch {}
  if (!response.ok) {
    if ([401, 403].includes(response.status)) throw new WereadError(`WEREAD_HTTP_${response.status}`, '微信读书授权已失效，请重新扫码授权。');
    throw new WereadError('WEREAD_HTTP', `微信读书返回 HTTP ${response.status}。`);
  }
  const code = Number(payload?.errCode ?? payload?.errcode ?? 0);
  if (code && code !== 0) {
    const message = [-2012, -2010, -2041].includes(code) ? '微信读书授权已失效或被限制，请重新扫码授权。' : '微信读书未接受本次请求，请稍后重试。';
    throw new WereadError(`WEREAD_${code}`, message);
  }
  return { payload: payload || {}, headers: response.headers };
}
function isWereadAuthFailure(error) { return error instanceof WereadError && (/^WEREAD_-(2012|2010|2041)$/.test(error.code) || /^WEREAD_HTTP_(401|403)$/.test(error.code)); }
async function verifyWereadCookie(cookie) {
  return wereadJson('/web/shelf/sync?userVid=&synckey=0', { cookie });
}
async function verifyAndSaveWereadAuth(userId, auth, cookie, { keepaliveAt = null } = {}) {
  const verified = await verifyWereadCookie(cookie);
  const jar = cookieMapFromHeader(cookie); setCookieMap(jar, verified.headers);
  return saveWereadAuth(userId, auth, cookieHeader(jar), { keepaliveAt });
}
async function renewWereadCookie(cookie) {
  const renewed = await wereadJson('/web/login/renewal', { cookie, method: 'POST', body: { rq: '%2Fweb%2Fbook%2Fread', ql: true } });
  const jar = cookieMapFromHeader(cookie); setCookieMap(jar, renewed.headers);
  return cookieHeader(jar);
}
function markWereadAuthExpired(userId) { db.prepare("UPDATE weread_auth SET status='expired',updated_at=? WHERE user_id=?").run(now(), userId); }
async function ensureWereadAuth(userId) {
  if (wereadKeepAliveInFlight.has(userId)) return wereadKeepAliveInFlight.get(userId);
  const task = (async () => {
    const stored = userWereadAuth(userId);
    if (!stored) throw new WereadError('WEREAD_AUTH_REQUIRED', '请先完成微信读书扫码授权。');
    try {
      // 每次同步前先用真实书架接口验证。有效时接收服务端下发的新 Cookie，避免只依赖旧 token。
      let auth = await verifyAndSaveWereadAuth(userId, stored, stored.cookie, { keepaliveAt: stored.keepalive_at || null });
      const keepaliveDue = !auth.keepalive_at || Date.now() - Date.parse(auth.keepalive_at) >= wereadKeepAliveIntervalMs;
      if (!keepaliveDue) return auth;

      const attemptedAt = now();
      // 对齐 werss：复用独立的宿主机浏览器 Profile 打开微信读书页面，重新采集 Cookie。
      try {
        const browserCookie = await openWereadBrowserProfile(userId, auth.cookie, { navigate: true });
        auth = await verifyAndSaveWereadAuth(userId, auth, browserCookie, { keepaliveAt: attemptedAt });
        return auth;
      } catch { /* 浏览器不可用或未刷新时，继续走官方 renewal 回退。 */ }
      try {
        const renewedCookie = await renewWereadCookie(auth.cookie);
        auth = await verifyAndSaveWereadAuth(userId, auth, renewedCookie, { keepaliveAt: attemptedAt });
        return auth;
      } catch {
        // 当前 Cookie 已被真实接口验证为有效；本次保活未换取新 token 时继续使用，6 小时后再试。
        db.prepare('UPDATE weread_auth SET keepalive_at=?,updated_at=? WHERE user_id=?').run(attemptedAt, now(), userId);
        return userWereadAuth(userId);
      }
    } catch (error) {
      if (!isWereadAuthFailure(error)) throw error;
      // Cookie 已失效：先复用持久化浏览器登录态，再使用 wr_rt 调 renewal；两者都失败才标记失效。
      for (const refresh of [
        async () => openWereadBrowserProfile(userId, stored.cookie, { navigate: true }),
        async () => renewWereadCookie(stored.cookie)
      ]) {
        try { return await verifyAndSaveWereadAuth(userId, stored, await refresh(), { keepaliveAt: now() }); }
        catch { /* 尝试下一条恢复路径。 */ }
      }
      markWereadAuthExpired(userId);
      throw new WereadError('WEREAD_AUTH_REQUIRED', '微信读书授权已失效，自动保活未能恢复，请重新扫码授权。');
    }
  })();
  wereadKeepAliveInFlight.set(userId, task);
  try { return await task; } finally { wereadKeepAliveInFlight.delete(userId); }
}
function normalizeMpBookId(value) {
  const raw = decodeURIComponent(String(value || '').trim());
  const found = raw.match(/MP_WXS_[A-Za-z0-9_]+/);
  return found ? found[0] : '';
}
async function createWereadQr(userId) {
  const { payload, headers } = await wereadJson('/api/auth/getLoginUid');
  const uid = String(payload.uid || payload.data?.uid || '');
  if (!uid) throw new WereadError('WEREAD_QR_UNAVAILABLE', '微信读书未返回登录二维码，请稍后重试。');
  const jar = new Map(); setCookieMap(jar, headers);
  const confirmUrl = `${WEREAD_BASE}/web/confirm?uid=${encodeURIComponent(uid)}`;
  const image = await QRCode.toDataURL(confirmUrl, { errorCorrectionLevel: 'M', margin: 2, width: 300 });
  wereadQrSessions.set(userId, { uid, jar, createdAt: Date.now() });
  return { image, expiresIn: 300 };
}
async function pollWereadQr(userId) {
  const session = wereadQrSessions.get(userId);
  if (!session) throw new WereadError('WEREAD_QR_MISSING', '请先获取新的授权二维码。');
  if (Date.now() - session.createdAt > 5 * 60_000) { wereadQrSessions.delete(userId); return { state: 'expired', message: '二维码已过期，请重新获取。' }; }
  const response = await wereadRequest(`/api/auth/getLoginInfo?uid=${encodeURIComponent(session.uid)}&otp=`, { cookie: cookieHeader(session.jar) });
  setCookieMap(session.jar, response.headers);
  let payload = {}; try { payload = await response.json(); } catch { throw new WereadError('WEREAD_QR_STATUS', '无法读取微信读书授权状态。'); }
  const detail = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  if (!(payload.succeed || detail.succeed)) {
    const code = payload.logicCode ?? detail.logicCode;
    if (code === 'NEED_OTP') return { state: 'otp', message: '该微信读书账户要求短信验证码，暂不支持，请改用其他账户或稍后重试。' };
    if (code === 1 || code === '1') return { state: 'scanned', message: '已扫码，请在手机上确认登录。' };
    return { state: 'waiting', message: '等待扫码。' };
  }
  // 微信读书在不同版本中会把登录资料放在顶层、data 子层，或只通过
  // Set-Cookie 下发。不要把 accessToken 当作唯一成功条件；最终以真实
  // 书架接口校验 Cookie 是否可用为准。
  const nested = detail.data && typeof detail.data === 'object' ? detail.data : {};
  const sources = [payload, detail, nested];
  const pick = (names) => {
    for (const source of sources) for (const name of names) if (source?.[name]) return String(source[name]);
    return '';
  };
  const vid = pick(['webLoginVid', 'vid', 'userVid', 'user_vid']) || session.jar.get('wr_vid') || '';
  const accessToken = pick(['accessToken', 'access_token', 'token', 'wr_skey', 'skey', 'sessionKey', 'session_key', 'authToken', 'auth_token', 'ticket']);
  const refreshToken = pick(['refreshToken', 'refresh_token']);
  if (!vid) throw new WereadError('WEREAD_QR_INCOMPLETE', '扫码成功但未获得用户标识，请重新扫码。');
  session.jar.set('wr_vid', vid);
  if (!session.jar.get('wr_skey') && accessToken) session.jar.set('wr_skey', accessToken);
  if (!session.jar.get('wr_rt') && refreshToken) session.jar.set('wr_rt', encodeURIComponent(refreshToken));
  let cookie = cookieHeader(session.jar);
  try { await verifyWereadCookie(cookie); }
  catch {
    try {
      const renewal = await wereadJson('/web/login/renewal', { cookie, method: 'POST', body: { rq: '%2Fweb%2Fbook%2Fread', ql: true } });
      setCookieMap(session.jar, renewal.headers); cookie = cookieHeader(session.jar); await verifyWereadCookie(cookie);
    } catch { throw new WereadError('WEREAD_COOKIE_INVALID', '登录成功但 Cookie 校验失败，请重新扫码。'); }
  }
  const time = now();
  db.prepare(`INSERT INTO weread_auth (user_id,encrypted_cookie,vid,account_name,status,verified_at,keepalive_at,updated_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET encrypted_cookie=excluded.encrypted_cookie,vid=excluded.vid,status='active',verified_at=excluded.verified_at,keepalive_at=excluded.keepalive_at,updated_at=excluded.updated_at`)
    .run(userId, encryptToken(cookie), vid, '', 'active', time, time, time);
  // 异步写入宿主机专用 Profile；失败不影响已通过真实接口校验的扫码授权。
  void seedWereadBrowserProfile(userId, cookie);
  wereadQrSessions.delete(userId); audit(userId, 'mp.weread.authorize');
  return { state: 'success', message: '微信读书授权成功。' };
}
async function wereadShelfForUser(userId, currentAuth = null) {
  const auth = currentAuth || await ensureWereadAuth(userId);
  try {
    const { payload } = await wereadJson('/web/shelf/sync?userVid=&synckey=0', { cookie: auth.cookie });
    return (payload.books || []).filter((book) => String(book.bookId || '').startsWith('MP_WXS_')).map((book) => ({ bookId: String(book.bookId), name: String(book.title || book.bookId), coverUrl: String(book.cover || '') }));
  } catch (error) {
    if (isWereadAuthFailure(error)) db.prepare("UPDATE weread_auth SET status='expired',updated_at=? WHERE user_id=?").run(now(), userId);
    throw error;
  }
}
async function addWereadMpSubscription(userId, rawBookId) {
  const bookId = normalizeMpBookId(rawBookId);
  if (!bookId) throw new WereadError('INVALID_MP_BOOK', '请输入有效的微信读书公众号 reader 链接或 MP_WXS 标识。');
  const auth = await ensureWereadAuth(userId);
  let shelf = await wereadShelfForUser(userId, auth);
  if (!shelf.some((book) => book.bookId === bookId)) {
    await wereadJson('/web/shelf/add', { cookie: auth.cookie, method: 'POST', body: { bookIds: [bookId] } });
    shelf = await wereadShelfForUser(userId, auth);
  }
  const book = shelf.find((entry) => entry.bookId === bookId) || { bookId, name: bookId, coverUrl: '' };
  const time = now(); let subscription = db.prepare('SELECT * FROM mp_subscriptions WHERE user_id=? AND book_id=?').get(userId, bookId);
  if (!subscription) {
    subscription = { id: id('mps') };
    db.prepare('INSERT INTO mp_subscriptions (id,user_id,book_id,name,cover_url,rss_token,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(subscription.id, userId, bookId, book.name, book.coverUrl, id('rss'), time, time);
    audit(userId, 'mp.subscription.create', subscription.id);
  } else db.prepare('UPDATE mp_subscriptions SET name=?,cover_url=?,enabled=1,updated_at=? WHERE id=?').run(book.name, book.coverUrl, time, subscription.id);
  return db.prepare('SELECT * FROM mp_subscriptions WHERE user_id=? AND book_id=?').get(userId, bookId);
}
function mpArticleUrl(reviewId) { const token = String(reviewId || '').split('_').pop(); return token ? `https://mp.weixin.qq.com/s/${token}` : 'https://mp.weixin.qq.com/'; }
function mpArticleImageUrl(cover, snapshot, baseUrl) {
  const coverImage = safeImageUrl(cover?.pic, baseUrl);
  if (coverImage) return coverImage;
  const attributes = snapshot.match(/<img\b([^>]*)>/i)?.[1] || '';
  return safeImageUrl(attributeValue(attributes, 'src'), baseUrl);
}
async function persistMpArticle(userId, subscription, cover, reviewId, content, contentStatus) {
  const articleId = id('itm'); const time = now(); const link = mpArticleUrl(reviewId);
  const source = content && /\bid=["']js_content["']/i.test(content) ? content : `<article id="js_content">${content || '<p>正文暂未获取成功，请通过原文链接查看。</p>'}</article>`;
  const page = sanitizeDocument(source, link);
  const articleImageUrl = mpArticleImageUrl(cover, page.snapshot, link);
  const title = String(cover.title || subscription.name || '微信公众号文章').slice(0, 300);
  const draft = { id: articleId, user_id: userId, title, archive_folder: '' }; const archiveFolder = archiveFolderFor(draft); const archive = archiveInfo({ ...draft, archive_folder: archiveFolder }, archiveUser(userId), archiveFolder);
  let snapshot = page.snapshot; let warning = contentStatus === 'ready' ? null : '正文暂未获取成功，请通过原文链接查看。';
  try { snapshot = await archiveSnapshot(userId, articleId, snapshot, archive); } catch { warning = `${warning || ''}${warning ? ' ' : ''}本地快照图片未能完全归档。`; }
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO items (id,user_id,url,normalized_url,title,summary,html_snapshot,fetch_status,fetch_warning,source_type,source_label,mp_image_url,archive_folder,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(articleId, userId, link, normalizedUrl(link), title, page.summary, snapshot, 'ready', warning, 'mp', subscription.name, articleImageUrl, archiveFolder, time, time);
    db.prepare('INSERT INTO mp_review_records (id,user_id,subscription_id,review_id,item_id,content_status,created_at) VALUES (?,?,?,?,?,?,?)').run(id('mpr'), userId, subscription.id, reviewId, articleId, contentStatus, time);
    timelineEvent(userId, articleId, 'item_created', null, time); db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return articleId;
}
async function runMpSync(userId, subscriptionId = null) {
  if (mpSyncInFlight.has(userId)) return mpSyncInFlight.get(userId);
  const task = (async () => {
    const runId = id('mprun'); const startedAt = now(); let discovered = 0; let imported = 0;
    db.prepare('INSERT INTO mp_sync_runs (id,user_id,started_at,status) VALUES (?,?,?,?)').run(runId, userId, startedAt, 'running');
    try {
      const auth = await ensureWereadAuth(userId);
      const subscriptions = db.prepare(`SELECT * FROM mp_subscriptions WHERE user_id=? AND enabled=1${subscriptionId ? ' AND id=?' : ''} ORDER BY created_at ASC`).all(...(subscriptionId ? [userId, subscriptionId] : [userId]));
      let shelfByBookId = new Map();
      try { shelfByBookId = new Map((await wereadShelfForUser(userId, auth)).map((book) => [book.bookId, book])); } catch { /* A cover refresh must not prevent article synchronization. */ }
      for (const subscription of subscriptions) {
        try {
          const { payload: cover } = await wereadJson(`/api/mp/cover?bookId=${encodeURIComponent(subscription.book_id)}`, { cookie: auth.cookie });
          const reviewId = String(cover.reviewId || ''); if (!reviewId) throw new WereadError('MP_EMPTY_COVER', '该公众号暂未返回最新文章。');
          discovered += 1;
          const shelfCover = String(shelfByBookId.get(subscription.book_id)?.coverUrl || subscription.cover_url || '');
          db.prepare('UPDATE mp_subscriptions SET name=?,cover_url=?,latest_title=?,last_error=NULL,updated_at=? WHERE id=?').run(String(cover.name || subscription.name), shelfCover, String(cover.title || ''), now(), subscription.id);
          if (!db.prepare('SELECT id FROM mp_review_records WHERE subscription_id=? AND review_id=?').get(subscription.id, reviewId)) {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 2000));
            let content = ''; let contentStatus = 'ready';
            try { const response = await wereadRequest(`/web/mp/content?reviewId=${encodeURIComponent(reviewId)}`, { cookie: auth.cookie }); if (!response.ok) throw new Error(); const source = await response.text(); if (!/\bid=["']js_content["']/i.test(source)) throw new Error(); content = source; }
            catch { contentStatus = 'failed'; }
            await persistMpArticle(userId, subscription, cover, reviewId, content, contentStatus); imported += 1;
          }
          db.prepare('UPDATE mp_subscriptions SET last_sync_at=?,last_error=NULL,updated_at=? WHERE id=?').run(now(), now(), subscription.id);
        } catch (error) { if (isWereadAuthFailure(error)) db.prepare("UPDATE weread_auth SET status='expired',updated_at=? WHERE user_id=?").run(now(), userId); db.prepare('UPDATE mp_subscriptions SET last_error=?,updated_at=? WHERE id=?').run(error instanceof WereadError ? error.message : '本次同步失败，请稍后重试。', now(), subscription.id); }
      }
      db.prepare('UPDATE mp_sync_settings SET last_run_at=?,updated_at=? WHERE user_id=?').run(now(), now(), userId);
      db.prepare('UPDATE mp_sync_runs SET finished_at=?,status=?,discovered_count=?,imported_count=? WHERE id=?').run(now(), 'success', discovered, imported, runId);
      audit(userId, 'mp.sync', runId); return { discovered, imported };
    } catch (error) {
      if (isWereadAuthFailure(error)) db.prepare("UPDATE weread_auth SET status='expired',updated_at=? WHERE user_id=?").run(now(), userId);
      db.prepare('UPDATE mp_sync_runs SET finished_at=?,status=?,discovered_count=?,imported_count=?,error_message=? WHERE id=?').run(now(), 'failed', discovered, imported, error instanceof WereadError ? error.message : '本次同步失败，请稍后重试。', runId);
      throw error;
    } finally { mpSyncInFlight.delete(userId); }
  })();
  mpSyncInFlight.set(userId, task); return task;
}
function mpWorkspace(userId, { articlePage = 1, articlePageSize = 20 } = {}) {
  const settings = mpSettings(userId);
  const sevenDaysAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const pageSize = mpArticlePageSizeOptions.has(Number(articlePageSize)) ? Number(articlePageSize) : 20;
  const total = db.prepare(`SELECT count(*) AS total FROM items WHERE user_id=? AND source_type='mp' AND created_at>=?`).get(userId, sevenDaysAgo).total;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(totalPages, Math.max(1, Number.parseInt(articlePage, 10) || 1));
  const articles = db.prepare(`SELECT i.*,COALESCE(NULLIF(i.source_label,''),s.name,'微信公众号') AS mp_name,COALESCE(s.cover_url,'') AS mp_cover_url,COALESCE(NULLIF(i.mp_image_url,''),s.cover_url,'') AS mp_article_image_url,r.content_status
    FROM items i LEFT JOIN mp_review_records r ON r.item_id=i.id AND r.user_id=i.user_id LEFT JOIN mp_subscriptions s ON s.id=r.subscription_id
    WHERE i.user_id=? AND i.source_type='mp' AND i.created_at>=? ORDER BY i.created_at DESC,i.id DESC LIMIT ? OFFSET ?`).all(userId, sevenDaysAgo, pageSize, (page - 1) * pageSize)
    .map((row) => ({ ...row, is_read: Boolean(row.is_read), is_archived: Boolean(row.is_archived), is_favorite: Boolean(row.is_favorite) }));
  return { auth: publicWereadAuth(userId), settings, subscriptions: db.prepare('SELECT * FROM mp_subscriptions WHERE user_id=? ORDER BY created_at DESC').all(userId).map((row) => { const { rss_token: rssToken, ...subscription } = row; return { ...subscription, enabled: Boolean(subscription.enabled), rssPath: `/feed/${encodeURIComponent(subscription.book_id)}.rss` }; }), articles, articlePagination: { page, pageSize, total, totalPages }, runs: db.prepare('SELECT * FROM mp_sync_runs WHERE user_id=? ORDER BY started_at DESC LIMIT 3').all(userId), syncing: mpSyncInFlight.has(userId) };
}
function startMpSubscriptionScheduler() {
  const tick = async () => {
    const rows = db.prepare(`SELECT s.user_id,s.refresh_minutes,s.last_run_at FROM mp_sync_settings s WHERE EXISTS (SELECT 1 FROM mp_subscriptions p WHERE p.user_id=s.user_id AND p.enabled=1)`).all();
    for (const row of rows) if (!mpSyncInFlight.has(row.user_id) && (!row.last_run_at || Date.now() - Date.parse(row.last_run_at) >= Number(row.refresh_minutes) * 60_000)) runMpSync(row.user_id).catch(() => undefined);
  };
  const timer = setInterval(() => { void tick(); }, 60_000); timer.unref?.(); void tick();
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
  const clauses = ["i.user_id=?", "i.source_type <> 'mp'"]; const values = [userId];
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
  const clauses = ["i.user_id=?", "i.source_type <> 'mp'", "trim(h.note_title) <> ''", "trim(h.note) <> ''"];
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
  if (query) { where += " AND (f.name LIKE ? OR EXISTS (SELECT 1 FROM item_folders sf JOIN items si ON si.id=sf.item_id WHERE sf.folder_id=f.id AND si.source_type <> 'mp' AND si.title LIKE ?))"; values.push(`%${query}%`, `%${query}%`); }
  const page = Math.max(Number(params.get('page') || 1), 1); const pageSize = Math.min(Math.max(Number(params.get('pageSize') || 100), 1), 100);
  const total = db.prepare(`SELECT count(*) AS total FROM folders f WHERE ${where}`).get(...values).total;
  const folders = db.prepare(`SELECT f.id,f.name,f.sort_order,f.created_at,count(CASE WHEN i.source_type <> 'mp' THEN ifo.item_id END) AS count,max(CASE WHEN i.source_type <> 'mp' THEN i.created_at END) AS latest_item_at
    FROM folders f LEFT JOIN item_folders ifo ON ifo.folder_id=f.id LEFT JOIN items i ON i.id=ifo.item_id
    WHERE ${where} GROUP BY f.id ORDER BY f.sort_order ASC,f.name ASC LIMIT ? OFFSET ?`).all(...values, pageSize, (page - 1) * pageSize);
  return { folders, total, page, pageSize };
}
function tagSummary(userId, params) {
  const query = String(params.get('q') || '').trim(); const values = [userId]; let where = 't.user_id=?';
  if (query) { where += " AND (t.name LIKE ? OR EXISTS (SELECT 1 FROM item_tags st JOIN items si ON si.id=st.item_id WHERE st.tag_id=t.id AND si.source_type <> 'mp' AND si.title LIKE ?))"; values.push(`%${query}%`, `%${query}%`); }
  const page = Math.max(Number(params.get('page') || 1), 1); const pageSize = Math.min(Math.max(Number(params.get('pageSize') || 100), 1), 100);
  const total = db.prepare(`SELECT count(*) AS total FROM tags t WHERE ${where}`).get(...values).total;
  const tags = db.prepare(`SELECT t.id,t.name,t.created_at,count(CASE WHEN i.source_type <> 'mp' THEN it.item_id END) AS count FROM tags t LEFT JOIN item_tags it ON it.tag_id=t.id LEFT JOIN items i ON i.id=it.item_id WHERE ${where} GROUP BY t.id ORDER BY t.name ASC LIMIT ? OFFSET ?`).all(...values, pageSize, (page - 1) * pageSize);
  return { tags, total, page, pageSize };
}
function folderDetail(userId, folderId, params) {
  const folder = db.prepare('SELECT id,name,sort_order,created_at FROM folders WHERE id=? AND user_id=?').get(folderId, userId); if (!folder) return null;
  const page = Math.max(Number(params.get('page') || 1), 1); const pageSize = Math.min(Math.max(Number(params.get('pageSize') || 100), 1), 100);
  const total = db.prepare("SELECT count(*) AS total FROM item_folders ifo JOIN items i ON i.id=ifo.item_id WHERE ifo.folder_id=? AND i.source_type <> 'mp'").get(folder.id).total;
  const rows = db.prepare("SELECT i.* FROM items i JOIN item_folders ifo ON ifo.item_id=i.id WHERE ifo.folder_id=? AND i.user_id=? AND i.source_type <> 'mp' ORDER BY i.created_at DESC,i.id DESC LIMIT ? OFFSET ?").all(folder.id, userId, pageSize, (page - 1) * pageSize).map(itemData);
  return { ...folder, items: rows, total, page, pageSize };
}
function tagDetail(userId, tagId, params) {
  const tag = db.prepare('SELECT id,name,created_at FROM tags WHERE id=? AND user_id=?').get(tagId, userId); if (!tag) return null;
  const page = Math.max(Number(params.get('page') || 1), 1); const pageSize = Math.min(Math.max(Number(params.get('pageSize') || 100), 1), 100);
  const total = db.prepare("SELECT count(*) AS total FROM item_tags it JOIN items i ON i.id=it.item_id WHERE it.tag_id=? AND i.source_type <> 'mp'").get(tag.id).total;
  const rows = db.prepare("SELECT i.* FROM items i JOIN item_tags it ON it.item_id=i.id WHERE it.tag_id=? AND i.user_id=? AND i.source_type <> 'mp' ORDER BY i.created_at DESC,i.id DESC LIMIT ? OFFSET ?").all(tag.id, userId, pageSize, (page - 1) * pageSize).map(itemData);
  return { ...tag, items: rows, total, page, pageSize };
}
function listTimeline(userId, params) {
  const categories = String(params.get('types') || '').split(',').filter(Boolean);
  const categoryTypes = { article: ['item_created', 'item_archived', 'item_unarchived', 'item_favorited', 'item_unfavorited'], note: ['highlight_created', 'note_updated'], created: ['item_created'], favorite: ['item_favorited', 'item_unfavorited'], archive: ['item_archived', 'item_unarchived'], highlight: ['highlight_created'], noteUpdated: ['note_updated'], archived: ['item_archived', 'item_unarchived'] };
  const allowedTypes = [...new Set(Object.values(categoryTypes).flat())]; const allowed = new Set(allowedTypes); const types = [...new Set(categories.flatMap((entry) => categoryTypes[entry] || [entry]).filter((entry) => allowed.has(entry)))];
  const clauses = ['e.user_id=?', "(i.source_type IS NULL OR i.source_type <> 'mp')", `e.event_type IN (${allowedTypes.map(() => '?').join(',')})`]; const values = [userId, ...allowedTypes];
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
  const normalized = normalizedUrl(payload.url);
  const itemId = id('itm'); const time = now(); let page;
  try { page = await fetchPage(normalized); }
  catch (error) {
    const browserSnapshot = clientSnapshotPage(payload, normalized);
    page = browserSnapshot
      ? { ...browserSnapshot, fetch_warning: `原网站未能由服务器抓取（${error.message}）。已保存当前浏览器提交的文章正文。` }
      : { url: normalized, title: payload.title || new URL(normalized).hostname, summary: '', snapshot: '', error: error.message };
  }
  const customTitle = String(payload.title || '').trim().slice(0, 300); if (customTitle) page.title = customTitle;
  const draft = { id: itemId, user_id: userId, title: page.title, archive_folder: '' };
  const archiveFolder = archiveFolderFor(draft);
  const archive = archiveInfo(draft, archiveUser(userId), archiveFolder);
  // Saving a link always keeps the HTML and local assets in Library. PDF creation is explicit from the reader toolbar.
  if (!page.error && page.snapshot) page.snapshot = await archiveSnapshot(userId, itemId, page.snapshot, archive);
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO items (id,user_id,url,normalized_url,title,summary,html_snapshot,fetch_status,fetch_error,fetch_warning,archive_folder,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(itemId, userId, page.url, normalized, page.title, page.summary, page.snapshot, page.error ? 'failed' : 'ready', page.error || null, page.fetch_warning || null, archiveFolder, time, time);
    addTags(userId, itemId, payload.tags); addFolders(userId, itemId, payload.folderId ? [payload.folderId] : payload.folderIds);
    timelineEvent(userId, itemId, 'item_created', null, time);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  audit(userId, 'item.create', itemId);
  return { duplicate: false, item: itemData(db.prepare('SELECT * FROM items WHERE id=?').get(itemId)) };
}
async function refetchItem(item, payload = {}) {
  const time = now(); let page;
  try { page = await fetchPage(item.normalized_url); }
  catch (error) {
    const browserSnapshot = clientSnapshotPage(payload, item.normalized_url);
    const retainedSnapshot = clientSnapshotPage({ htmlSnapshot: item.html_snapshot }, item.normalized_url);
    page = browserSnapshot
      ? { ...browserSnapshot, title: String(payload.title || item.title).trim() || item.title, fetch_warning: `原网站未能由服务器抓取（${error.message}）。已使用当前浏览器提交的文章正文更新快照。` }
      : retainedSnapshot
        ? { url: item.url, title: item.title, summary: item.summary, snapshot: item.html_snapshot, retained: true, fetch_warning: `原网站未能更新（${error.message}）。已保留此前保存的本地文章快照。` }
        : { url: item.url, title: item.title, summary: item.summary, snapshot: '', error: error.message };
  }
  const user = archiveUser(item.user_id);
  const archiveFolder = page.retained || page.error ? item.archive_folder : archiveFolderFor({ ...item, archive_folder: '', title: page.title }, page.title);
  const archive = page.retained || page.error ? archiveInfo(item, user) : moveArchiveDirectory(item, user, archiveFolder);
  if (!page.error && !page.retained && page.snapshot) page.snapshot = await archiveSnapshot(item.user_id, item.id, page.snapshot, archive);
  db.prepare('UPDATE items SET url=?,title=?,summary=?,html_snapshot=?,fetch_status=?,fetch_error=?,fetch_warning=?,archive_folder=?,updated_at=? WHERE id=?')
    .run(page.url, page.title, page.summary, page.snapshot, page.error ? 'failed' : 'ready', page.error || null, page.fetch_warning || null, archive.folder, time, item.id);
  return itemData(itemForUser(item.user_id, item.id));
}
function itemForUser(userId, itemId) { return db.prepare('SELECT * FROM items WHERE id=? AND user_id=?').get(itemId, userId); }
function requireUser(req, res) { const user = currentUser(req); if (!user || user.disabled) { fail(res, 401, 'UNAUTHENTICATED', '请先登录。'); return null; } return user; }
function cors(req, res) { if (req.headers.origin?.startsWith('chrome-extension://')) res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS'); }

async function api(req, res, url) {
  cors(req, res); if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const path = url.pathname;
  if (path === '/api/health') return ok(res, { status: 'ok', version: '1.0.0' });
  if (path === '/api/auth/login' && req.method === 'POST') { const body = await readBody(req); const user = db.prepare('SELECT * FROM users WHERE username=?').get(String(body.username || '').trim()); if (!user || user.disabled || !(await passwordMatches(String(body.password || ''), user.password_hash))) return fail(res, 401, 'INVALID_CREDENTIALS', '用户名或密码错误。'); const sessionId = id('ses'); db.prepare('INSERT INTO sessions (id,user_id,expires_at,created_at) VALUES (?,?,?,?)').run(sessionId, user.id, new Date(Date.now() + 7 * 864e5).toISOString(), now()); setCookie(res, sessionId); audit(user.id, 'auth.login'); return ok(res, { id: user.id, username: user.username, role: user.role }); }
  if (path === '/api/auth/logout' && req.method === 'POST') { const session = cookies(req).pl_session; if (session) db.prepare('DELETE FROM sessions WHERE id=?').run(session); clearCookie(res); return ok(res, { loggedOut: true }); }
  if (path === '/api/auth/me' && req.method === 'GET') { const user = requireUser(req, res); if (user) ok(res, user); return; }
  if (path === '/api/mp/media' && req.method === 'GET') {
    const user = requireUser(req, res); if (!user) return;
    let mediaUrl;
    try { mediaUrl = publicUrl(url.searchParams.get('url') || ''); }
    catch { return fail(res, 400, 'INVALID_MP_MEDIA', '无效的公众号图片地址。'); }
    const allowedHosts = new Set(['mmbiz.qpic.cn', 'wx.qlogo.cn', 'mmbiz.qlogo.cn', 'mmecoa.qpic.cn']);
    if (!allowedHosts.has(mediaUrl.hostname.toLowerCase())) return fail(res, 400, 'INVALID_MP_MEDIA', '仅支持微信公众平台图片。');
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(mediaUrl, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': pageHeaders['User-Agent'], Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8', Referer: 'https://mp.weixin.qq.com/' } });
      const contentType = response.headers.get('content-type') || '';
      const contentLength = Number(response.headers.get('content-length') || 0);
      if (!response.ok || !contentType.toLowerCase().startsWith('image/') || contentLength > 8 * 1024 * 1024) return fail(res, 502, 'MP_MEDIA_UNAVAILABLE', '公众号图片暂时无法加载。');
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > 8 * 1024 * 1024) return fail(res, 502, 'MP_MEDIA_UNAVAILABLE', '公众号图片文件过大。');
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': buffer.length, 'Cache-Control': 'private, max-age=86400' });
      return res.end(buffer);
    } catch { return fail(res, 502, 'MP_MEDIA_UNAVAILABLE', '公众号图片暂时无法加载。'); }
    finally { clearTimeout(timeout); }
  }
  if (path === '/api/mp/subscriptions' && req.method === 'GET') { const user = requireUser(req, res); if (user) ok(res, mpWorkspace(user.id, { articlePage: url.searchParams.get('articlePage'), articlePageSize: url.searchParams.get('articlePageSize') })); return; }
  if (path === '/api/mp/auth/qr' && req.method === 'POST') {
    const user = requireUser(req, res); if (!user) return;
    try { return ok(res, await createWereadQr(user.id)); } catch (error) { return fail(res, 502, error.code || 'WEREAD_QR_FAILED', error.message || '无法获取微信读书二维码。'); }
  }
  if (path === '/api/mp/auth/qr/status' && req.method === 'GET') {
    const user = requireUser(req, res); if (!user) return;
    try { return ok(res, await pollWereadQr(user.id)); } catch (error) { return fail(res, 400, error.code || 'WEREAD_QR_STATUS', error.message || '无法获取授权状态。'); }
  }
  if (path === '/api/mp/auth' && req.method === 'DELETE') {
    const user = requireUser(req, res); if (!user) return;
    db.prepare('DELETE FROM weread_auth WHERE user_id=?').run(user.id); wereadQrSessions.delete(user.id); removeWereadBrowserProfile(user.id); audit(user.id, 'mp.weread.revoke'); return ok(res, { removed: true });
  }
  if (path === '/api/mp/bookshelf' && req.method === 'GET') {
    const user = requireUser(req, res); if (!user) return;
    try { return ok(res, { books: await wereadShelfForUser(user.id) }); } catch (error) { return fail(res, 400, error.code || 'WEREAD_SHELF_FAILED', error.message || '无法读取微信读书书架。'); }
  }
  if (path === '/api/mp/settings' && req.method === 'PATCH') {
    const user = requireUser(req, res); if (!user) return; const body = await readBody(req); const syncMinutes = Number(body.syncMinutes);
    if (!mpSyncMinuteOptions.has(syncMinutes)) return fail(res, 400, 'INVALID_MP_SYNC_FREQUENCY', '同步频率仅支持每 1、4、6、8、12 或 24 小时。');
    db.prepare(`INSERT INTO mp_sync_settings (user_id,refresh_minutes,updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET refresh_minutes=excluded.refresh_minutes,updated_at=excluded.updated_at`).run(user.id, syncMinutes, now()); audit(user.id, 'mp.settings.update'); return ok(res, mpSettings(user.id));
  }
  if (path === '/api/mp/subscriptions' && req.method === 'POST') {
    const user = requireUser(req, res); if (!user) return; const body = await readBody(req);
    const requested = Array.isArray(body.bookIds) ? body.bookIds : [body.bookId || body.readerUrl];
    let bookIds = [];
    try { bookIds = [...new Set(requested.map(normalizeMpBookId).filter(Boolean))]; }
    catch { return fail(res, 400, 'INVALID_MP_SUBSCRIPTION', '请选择有效的微信读书公众号。'); }
    if (!bookIds.length) return fail(res, 400, 'INVALID_MP_SUBSCRIPTION', '请至少选择一个微信读书中的公众号。');
    const subscriptions = []; const failed = [];
    for (const bookId of bookIds) {
      try { subscriptions.push(await addWereadMpSubscription(user.id, bookId)); }
      catch (error) { failed.push({ bookId, message: error instanceof WereadError ? error.message : '添加失败，请稍后重试。' }); }
    }
    if (!subscriptions.length) return fail(res, 400, 'MP_SUBSCRIPTION_FAILED', failed[0]?.message || '无法添加公众号订阅。');
    return ok(res, { subscriptions, failed }, 201);
  }
  if (path === '/api/mp/sync' && req.method === 'POST') {
    const user = requireUser(req, res); if (!user) return;
    try { return ok(res, await runMpSync(user.id)); } catch (error) { return fail(res, 400, error.code || 'MP_SYNC_FAILED', error.message || '本次同步失败。'); }
  }
  const mpSubscriptionMatch = path.match(/^\/api\/mp\/subscriptions\/([^/]+)$/);
  const mpSubscriptionSyncMatch = path.match(/^\/api\/mp\/subscriptions\/([^/]+)\/sync$/);
  if (mpSubscriptionSyncMatch && req.method === 'POST') {
    const user = requireUser(req, res); if (!user) return; const subscription = db.prepare('SELECT id FROM mp_subscriptions WHERE id=? AND user_id=?').get(mpSubscriptionSyncMatch[1], user.id);
    if (!subscription) return fail(res, 404, 'MP_SUBSCRIPTION_NOT_FOUND', '未找到该公众号订阅。');
    try { return ok(res, await runMpSync(user.id, subscription.id)); } catch (error) { return fail(res, 400, error.code || 'MP_SYNC_FAILED', error.message || '本次同步失败。'); }
  }
  if (mpSubscriptionMatch) {
    const user = requireUser(req, res); if (!user) return; const subscription = db.prepare('SELECT * FROM mp_subscriptions WHERE id=? AND user_id=?').get(mpSubscriptionMatch[1], user.id);
    if (!subscription) return fail(res, 404, 'MP_SUBSCRIPTION_NOT_FOUND', '未找到该公众号订阅。');
    if (req.method === 'PATCH') { const body = await readBody(req); if (typeof body.enabled !== 'boolean') return fail(res, 400, 'INVALID_MP_SUBSCRIPTION', '请提供有效的启用状态。'); db.prepare('UPDATE mp_subscriptions SET enabled=?,updated_at=? WHERE id=?').run(Number(body.enabled), now(), subscription.id); audit(user.id, body.enabled ? 'mp.subscription.enable' : 'mp.subscription.pause', subscription.id); return ok(res, { ...db.prepare('SELECT * FROM mp_subscriptions WHERE id=?').get(subscription.id), enabled: body.enabled }); }
    if (req.method === 'DELETE') { db.prepare('DELETE FROM mp_subscriptions WHERE id=?').run(subscription.id); audit(user.id, 'mp.subscription.delete', subscription.id); return ok(res, { deleted: true }); }
    return fail(res, 405, 'METHOD_NOT_ALLOWED', '不支持的公众号订阅操作。');
  }
  if (path === '/api/preferences') { const user = requireUser(req, res); if (!user) return; if (req.method === 'GET') return ok(res, preferencesForUser(user.id)); if (req.method === 'PATCH') { const body = await readBody(req); const current = preferencesForUser(user.id); const homepageView = body.homepageView === 'cards' || body.homepageView === 'list' ? body.homepageView : current.homepageView; const readerDisplay = body.readerDisplay && typeof body.readerDisplay === 'object' && !Array.isArray(body.readerDisplay) ? body.readerDisplay : current.readerDisplay; db.prepare('INSERT INTO user_preferences (user_id,homepage_view,reader_display,updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET homepage_view=excluded.homepage_view,reader_display=excluded.reader_display,updated_at=excluded.updated_at').run(user.id, homepageView, json(readerDisplay), now()); audit(user.id, 'preferences.update'); return ok(res, { homepageView, readerDisplay }); } return fail(res, 405, 'METHOD_NOT_ALLOWED', '不支持的偏好设置操作。'); }
  if (path === '/api/auth/password' && req.method === 'POST') { const user = requireUser(req, res); if (!user) return; const body = await readBody(req); const newPassword = String(body.newPassword || ''); const stored = db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id); if (!(await passwordMatches(String(body.currentPassword || ''), stored.password_hash))) return fail(res, 400, 'INVALID_PASSWORD', '当前密码不正确。'); if (!newPassword) return fail(res, 400, 'INVALID_PASSWORD', '新密码不能为空。'); db.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').run(await passwordHash(newPassword), now(), user.id); audit(user.id, 'auth.password.change'); return ok(res, { changed: true }); }
  if (path === '/api/dashboard' && req.method === 'GET') { const user = requireUser(req, res); if (!user) return; const ordinary = "i.source_type <> 'mp'"; const tags = db.prepare(`SELECT t.id,t.name,count(it.item_id) AS count FROM tags t LEFT JOIN item_tags it ON it.tag_id=t.id LEFT JOIN items i ON i.id=it.item_id WHERE t.user_id=? GROUP BY t.id HAVING count(CASE WHEN ${ordinary} THEN 1 END) > 0 ORDER BY count(CASE WHEN ${ordinary} THEN 1 END) DESC,t.name LIMIT 12`).all(user.id); const folders = db.prepare(`SELECT f.id,f.name,f.sort_order,f.created_at,count(CASE WHEN ${ordinary} THEN ifo.item_id END) AS count FROM folders f LEFT JOIN item_folders ifo ON ifo.folder_id=f.id LEFT JOIN items i ON i.id=ifo.item_id WHERE f.user_id=? GROUP BY f.id ORDER BY f.sort_order,f.name`).all(user.id); const highlights = db.prepare(`SELECT h.*,i.title FROM highlights h JOIN items i ON i.id=h.item_id WHERE i.user_id=? AND ${ordinary} ORDER BY h.created_at DESC LIMIT 3`).all(user.id); const recentItem = db.prepare(`SELECT * FROM items i WHERE i.user_id=? AND ${ordinary} AND last_opened_at IS NOT NULL ORDER BY last_opened_at DESC LIMIT 1`).get(user.id); const mpAuth = publicWereadAuth(user.id); const mpSubscriptionCount = db.prepare('SELECT count(*) AS total FROM mp_subscriptions WHERE user_id=?').get(user.id).total; return ok(res, { tags, folders, highlights, recentItem: recentItem ? itemData(recentItem) : null, mpAuth, mpSubscriptionCount, counts: { all: db.prepare(`SELECT count(*) AS n FROM items i WHERE i.user_id=? AND ${ordinary}`).get(user.id).n, unread: db.prepare(`SELECT count(*) AS n FROM items i WHERE i.user_id=? AND ${ordinary} AND is_read=0`).get(user.id).n, archived: db.prepare(`SELECT count(*) AS n FROM items i WHERE i.user_id=? AND ${ordinary} AND is_archived=1`).get(user.id).n, favorite: db.prepare(`SELECT count(*) AS n FROM items i WHERE i.user_id=? AND ${ordinary} AND is_favorite=1`).get(user.id).n } }); }
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
  const pdfMatch = path.match(/^\/api\/items\/([^/]+)\/pdf$/);
  if (refetchMatch && req.method === 'POST') { const user = requireUser(req, res); if (!user) return; const item = itemForUser(user.id, refetchMatch[1]); if (!item) return fail(res, 404, 'NOT_FOUND', '未找到该条目。'); return ok(res, await refetchItem(item, await readBody(req))); }
  if (pdfMatch && req.method === 'POST') { const user = requireUser(req, res); if (!user) return; const item = itemForUser(user.id, pdfMatch[1]); if (!item) return fail(res, 404, 'NOT_FOUND', '未找到该条目。'); try { return ok(res, await createItemPdf(item)); } catch (error) { return fail(res, 409, 'PDF_UNAVAILABLE', error.message); } }
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
  if (path === '/api/export' && req.method === 'GET') {
    const user = requireUser(req, res); if (!user) return;
    if (user.role !== 'admin') return fail(res, 403, 'FORBIDDEN', '完整服务数据仅限管理员导出。');
    const tableNames = serviceBackupTables;
    const tables = Object.fromEntries(tableNames.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
    const payload = { format: 'paperleaf-service-backup', version: '1.0.0', exportedAt: now(), system: { tokenEncryptionKey: configuredTokenSecret ? null : tokenEncryptionSecret, tokenKeyManagedByEnvironment: Boolean(configuredTokenSecret), archiveNotice: '文章本地归档文件不会随 JSON 导出或在导入时自动删除。微信公众号订阅源会导出，但微信读书 Cookie、同步记录和去重记录不会导出，恢复后需重新扫码授权。' }, tables };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="paperleaf-service-backup-${new Date().toISOString().slice(0, 10)}.json"` });
    return res.end(JSON.stringify(payload, null, 2));
  }
  if (path === '/api/import' && req.method === 'POST') {
    const user = requireUser(req, res); if (!user) return;
    if (user.role !== 'admin') return fail(res, 403, 'FORBIDDEN', '完整服务数据仅限管理员导入。');
    const body = await readBody(req);
    const tableNames = serviceBackupTables;
    if (body?.format !== 'paperleaf-service-backup' || !body.tables || body.confirmReplace !== true || !tableNames.every((table) => Array.isArray(body.tables[table]))) return fail(res, 400, 'INVALID_BACKUP', '请选择有效的完整服务备份文件，并确认覆盖当前全部服务数据。');
    if (!body.tables.users.some((entry) => entry && entry.role === 'admin' && !entry.disabled)) return fail(res, 400, 'INVALID_BACKUP', '备份中至少需要保留一个启用的管理员账号。');
    const backupKey = String(body.system?.tokenEncryptionKey || '');
    if (configuredTokenSecret && backupKey) return fail(res, 400, 'TOKEN_KEY_MANAGED', '当前服务使用环境变量管理 Token 加密密钥，不能导入含独立密钥的备份。');
    if (!configuredTokenSecret && !backupKey && body.tables.api_tokens.length) return fail(res, 400, 'MISSING_TOKEN_KEY', '该备份缺少 Token 加密密钥，无法安全恢复 API Token。');
    const columns = Object.fromEntries(tableNames.map((table) => [table, db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name)]));
    if (!tableNames.every((table) => body.tables[table].every((row) => row && typeof row === 'object' && columns[table].every((column) => Object.hasOwn(row, column))))) return fail(res, 400, 'INVALID_BACKUP', '备份数据结构与当前服务版本不兼容。');
    db.exec('BEGIN IMMEDIATE');
    try {
      ['sessions', 'mp_review_records', 'mp_sync_runs', 'weread_auth', 'mp_subscriptions', 'mp_sync_settings', 'timeline_events', 'highlights', 'item_tags', 'item_folders', 'api_tokens', 'user_preferences', 'audit_logs', 'items', 'tags', 'folders', 'users'].forEach((table) => db.exec(`DELETE FROM ${table}`));
      tableNames.forEach((table) => {
        if (!body.tables[table].length) return;
        const names = columns[table]; const statement = db.prepare(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`);
        body.tables[table].forEach((row) => statement.run(...names.map((name) => row[name])));
      });
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('备份数据的关联关系校验失败。');
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch { /* Transaction has already ended. */ } return fail(res, 400, 'IMPORT_FAILED', `导入失败：${error.message}`); }
    if (!configuredTokenSecret && backupKey) { writeFileSync(tokenKeyPath, backupKey, { mode: 0o600 }); tokenEncryptionSecret = backupKey; tokenEncryptionKey = createHash('sha256').update(backupKey).digest(); }
    clearCookie(res);
    return ok(res, { imported: true, counts: Object.fromEntries(tableNames.map((table) => [table, body.tables[table].length])), message: '完整服务数据已恢复。请使用备份中的账号重新登录。' });
  }
  if (path === '/api/users') { const user = requireUser(req, res); if (!user || user.role !== 'admin') return fail(res, 403, 'FORBIDDEN', '需要管理员权限。'); if (req.method === 'GET') return ok(res, db.prepare('SELECT id,username,role,disabled,created_at,updated_at FROM users ORDER BY created_at').all().map((row) => ({ ...row, disabled: Boolean(row.disabled) }))); if (req.method === 'POST') { const body = await readBody(req); const username = String(body.username || '').trim(); if (!/^[a-zA-Z0-9_-]{3,40}$/.test(username) || !String(body.password || '')) return fail(res, 400, 'INVALID_USER', '用户名为 3-40 位字母、数字、下划线或连字符，密码不能为空。'); const userId = id('usr'); try { db.prepare('INSERT INTO users (id,username,password_hash,role,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(userId, username, await passwordHash(body.password), body.role === 'admin' ? 'admin' : 'user', now(), now()); } catch { return fail(res, 409, 'DUPLICATE_USER', '用户名已存在。'); } audit(user.id, 'user.create', userId); return ok(res, db.prepare('SELECT id,username,role,disabled,created_at FROM users WHERE id=?').get(userId), 201); } }
  const userMatch = path.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && req.method === 'DELETE') { const user = requireUser(req, res); if (!user || user.role !== 'admin') return fail(res, 403, 'FORBIDDEN', '需要管理员权限。'); if (user.id === userMatch[1]) return fail(res, 400, 'INVALID_USER', '不能删除当前登录管理员。'); const target = db.prepare('SELECT id FROM users WHERE id=?').get(userMatch[1]); if (!target) return fail(res, 404, 'NOT_FOUND', '未找到该用户。'); db.exec('BEGIN'); try { db.prepare('DELETE FROM audit_logs WHERE user_id=?').run(target.id); db.prepare('DELETE FROM users WHERE id=?').run(target.id); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } audit(user.id, 'user.delete', target.id); return ok(res, { deleted: true }); }
  // Public Token API: module names are intentionally stable even though the internal tables retain their original names.
  if (path === '/api/v1/bookmarks') { const user = tokenUser(req, req.method === 'POST' ? ['items:write'] : ['items:read']); if (!user) return fail(res, 401, 'INVALID_TOKEN', 'Token 无效、已撤销或没有所需权限。'); if (req.method === 'GET') return ok(res, listItems(user.id, url.searchParams)); if (req.method === 'POST') return ok(res, await createItem(user.id, await readBody(req)), 201); return fail(res, 405, 'METHOD_NOT_ALLOWED', '不支持的书签操作。'); }
  const v1BookmarkStateMatch = path.match(/^\/api\/v1\/bookmarks\/([^/]+)\/(favorite|archive)$/);
  if (v1BookmarkStateMatch) { const user = tokenUser(req, ['items:write']); if (!user) return fail(res, 401, 'INVALID_TOKEN', 'Token 无效、已撤销或没有所需权限。'); if (req.method !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED', '仅支持 POST 执行文章状态操作。'); const item = itemForUser(user.id, v1BookmarkStateMatch[1]); if (!item) return fail(res, 404, 'NOT_FOUND', '未找到该文章。'); const action = v1BookmarkStateMatch[2]; const field = action === 'favorite' ? 'is_favorite' : 'is_archived'; const event = action === 'favorite' ? 'item_favorited' : 'item_archived'; db.exec('BEGIN'); try { db.prepare(`UPDATE items SET ${field}=1,updated_at=? WHERE id=?`).run(now(), item.id); if (!Boolean(item[field])) timelineEvent(user.id, item.id, event, null); db.exec('COMMIT'); } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; } audit(user.id, `bookmark.${action}`, item.id); return ok(res, itemData(itemForUser(user.id, item.id))); }
  const v1BookmarkRefetchMatch = path.match(/^\/api\/v1\/bookmarks\/([^/]+)\/refetch$/);
  if (v1BookmarkRefetchMatch) { const user = tokenUser(req, ['items:write']); if (!user) return fail(res, 401, 'INVALID_TOKEN', 'Token 无效、已撤销或没有所需权限。'); const item = itemForUser(user.id, v1BookmarkRefetchMatch[1]); if (!item) return fail(res, 404, 'NOT_FOUND', '未找到该书签。'); if (req.method !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED', '仅支持 POST 重新抓取。'); return ok(res, await refetchItem(item, await readBody(req))); }
  const v1BookmarkMatch = path.match(/^\/api\/v1\/bookmarks\/([^/]+)$/);
  if (v1BookmarkMatch) {
    const user = tokenUser(req, req.method === 'GET' ? ['items:read'] : ['items:write']); if (!user) return fail(res, 401, 'INVALID_TOKEN', 'Token 无效、已撤销或没有所需权限。'); const item = itemForUser(user.id, v1BookmarkMatch[1]); if (!item) return fail(res, 404, 'NOT_FOUND', '未找到该书签。');
    if (req.method === 'GET') return ok(res, itemData(item));
    if (req.method === 'PATCH') { const body = await readBody(req); const fields = []; const values = []; const timestamp = now(); for (const key of ['is_read', 'is_archived', 'is_favorite']) if (typeof body[key] === 'boolean') { fields.push(`${key}=?`); values.push(Number(body[key])); } if (body.last_opened === true) { fields.push('last_opened_at=?'); values.push(timestamp); } if (Number.isFinite(body.reading_progress)) { fields.push('reading_progress=?'); values.push(Math.min(1, Math.max(0, Number(body.reading_progress)))); } const title = typeof body.title === 'string' ? body.title.trim().slice(0, 300) : null; if (title !== null) { fields.push('title=?'); values.push(title); } if (typeof body.summary === 'string') { fields.push('summary=?'); values.push(body.summary.trim().slice(0, 2000)); } if (title !== null && title !== item.title) { const folder = archiveFolderFor({ ...item, archive_folder: '', title }, title); moveArchiveDirectory(item, archiveUser(user.id), folder); fields.push('archive_folder=?'); values.push(folder); } db.exec('BEGIN'); try { if (fields.length) { fields.push('updated_at=?'); values.push(timestamp, item.id); db.prepare(`UPDATE items SET ${fields.join(',')} WHERE id=?`).run(...values); } if (typeof body.is_archived === 'boolean' && body.is_archived !== Boolean(item.is_archived)) timelineEvent(user.id, item.id, body.is_archived ? 'item_archived' : 'item_unarchived', null, timestamp); if (typeof body.is_favorite === 'boolean' && body.is_favorite !== Boolean(item.is_favorite)) timelineEvent(user.id, item.id, body.is_favorite ? 'item_favorited' : 'item_unfavorited', null, timestamp); if (Array.isArray(body.tags)) { db.prepare('DELETE FROM item_tags WHERE item_id=?').run(item.id); addTags(user.id, item.id, body.tags); clearOrphanTags(user.id); } if (Array.isArray(body.collectionIds)) { db.prepare('DELETE FROM item_folders WHERE item_id=?').run(item.id); addFolders(user.id, item.id, body.collectionIds); } db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } audit(user.id, 'bookmark.update', item.id); return ok(res, itemData(itemForUser(user.id, item.id))); }
    if (req.method === 'DELETE') { const archive = archiveInfo(item, archiveUser(user.id)); db.exec('BEGIN'); try { db.prepare('DELETE FROM timeline_events WHERE user_id=? AND item_id=?').run(user.id, item.id); db.prepare('DELETE FROM highlights WHERE item_id=?').run(item.id); db.prepare('DELETE FROM items WHERE id=?').run(item.id); clearItemArchive(user.id, item.id, archive); clearOrphanTags(user.id); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } audit(user.id, 'bookmark.delete', item.id); return ok(res, { deleted: true }); }
    return fail(res, 405, 'METHOD_NOT_ALLOWED', '不支持的书签操作。');
  }
  const v1BookmarkHighlightMatch = path.match(/^\/api\/v1\/bookmarks\/([^/]+)\/highlights$/);
  if (v1BookmarkHighlightMatch) { const user = tokenUser(req, ['items:write']); if (!user) return fail(res, 401, 'INVALID_TOKEN', 'Token 无效、已撤销或没有所需权限。'); const item = itemForUser(user.id, v1BookmarkHighlightMatch[1]); if (!item) return fail(res, 404, 'NOT_FOUND', '未找到该书签。'); if (req.method !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED', '仅支持 POST 创建高亮笔记。'); const body = await readBody(req); const text = String(body.text || '').trim(); const title = String(body.title || '').trim(); const note = String(body.note || '').trim(); if (!text) return fail(res, 400, 'INVALID_HIGHLIGHT', '高亮内容不能为空。'); if (!title || title.length > 120) return fail(res, 400, 'INVALID_NOTE_TITLE', '笔记标题为 1-120 字符。'); if (!note || note.length > 1000) return fail(res, 400, 'INVALID_NOTE', '笔记正文为 1-1000 字符。'); const highlightId = id('hlt'); const timestamp = now(); db.exec('BEGIN'); try { db.prepare('INSERT INTO highlights (id,item_id,text,note_title,note,color,start_offset,end_offset,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(highlightId, item.id, text.slice(0, 4000), title, note, 'yellow', null, null, timestamp, timestamp); timelineEvent(user.id, item.id, 'highlight_created', highlightId, timestamp); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } audit(user.id, 'highlight.create', highlightId); return ok(res, noteData(noteForUser(user.id, highlightId)), 201); }
  if (path === '/api/v1/highlights') { const user = tokenUser(req, ['items:read']); if (!user) return fail(res, 401, 'INVALID_TOKEN', 'Token 无效、已撤销或没有所需权限。'); if (req.method !== 'GET') return fail(res, 405, 'METHOD_NOT_ALLOWED', '仅支持 GET 读取高亮笔记。'); return ok(res, listNotes(user.id, url.searchParams)); }
  const v1HighlightDetailMatch = path.match(/^\/api\/v1\/highlights\/([^/]+)$/);
  if (v1HighlightDetailMatch) { const user = tokenUser(req, req.method === 'GET' ? ['items:read'] : ['items:write']); if (!user) return fail(res, 401, 'INVALID_TOKEN', 'Token 无效、已撤销或没有所需权限。'); const highlight = noteForUser(user.id, v1HighlightDetailMatch[1]); if (!highlight) return fail(res, 404, 'NOT_FOUND', '未找到该高亮笔记。'); if (req.method === 'GET') return ok(res, noteData(highlight)); if (req.method === 'PATCH') { const body = await readBody(req); const title = typeof body.title === 'string' ? body.title.trim() : ''; const note = typeof body.note === 'string' ? body.note.trim() : ''; if (!title || title.length > 120) return fail(res, 400, 'INVALID_NOTE_TITLE', '笔记标题为 1-120 字符。'); if (!note || note.length > 1000) return fail(res, 400, 'INVALID_NOTE', '笔记正文为 1-1000 字符。'); if (typeof body.updatedAt !== 'string' || !body.updatedAt) return fail(res, 400, 'INVALID_NOTE_VERSION', '缺少笔记更新时间。'); const timestamp = now(); const result = db.prepare('UPDATE highlights SET note_title=?,note=?,updated_at=? WHERE id=? AND updated_at=?').run(title, note, timestamp, highlight.id, body.updatedAt); if (result.changes !== 1) return fail(res, 409, 'NOTE_CONFLICT', '笔记已在其他位置更新。'); timelineEvent(user.id, highlight.item_id, 'note_updated', highlight.id, timestamp); audit(user.id, 'highlight.update', highlight.id); return ok(res, noteData(noteForUser(user.id, highlight.id))); } if (req.method === 'DELETE') { db.exec('BEGIN'); try { db.prepare('DELETE FROM timeline_events WHERE user_id=? AND highlight_id=?').run(user.id, highlight.id); db.prepare('DELETE FROM highlights WHERE id=?').run(highlight.id); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } audit(user.id, 'highlight.delete', highlight.id); return ok(res, { deleted: true }); } return fail(res, 405, 'METHOD_NOT_ALLOWED', '不支持的高亮笔记操作。'); }
  if (path === '/api/v1/tags') { const user = tokenUser(req, ['items:read']); if (!user) return fail(res, 401, 'INVALID_TOKEN', 'Token 无效、已撤销或没有所需权限。'); if (req.method !== 'GET') return fail(res, 405, 'METHOD_NOT_ALLOWED', '仅支持 GET 读取标签。'); return ok(res, tagSummary(user.id, url.searchParams)); }
  const v1TagMatch = path.match(/^\/api\/v1\/tags\/([^/]+)$/);
  if (v1TagMatch) { const user = tokenUser(req, req.method === 'GET' ? ['items:read'] : ['items:write']); if (!user) return fail(res, 401, 'INVALID_TOKEN', 'Token 无效、已撤销或没有所需权限。'); const tag = db.prepare('SELECT * FROM tags WHERE id=? AND user_id=?').get(v1TagMatch[1], user.id); if (!tag) return fail(res, 404, 'NOT_FOUND', '未找到标签。'); if (req.method === 'GET') return ok(res, tagDetail(user.id, tag.id, url.searchParams)); if (req.method === 'PATCH') { const body = await readBody(req); const name = normalizedName(body.name, { tag: true, maxLength: 40 }); if (!name) return fail(res, 400, 'INVALID_TAG', '标签名称为 1-40 个非空白字符，且不能包含空格或控制字符。'); try { db.prepare('UPDATE tags SET name=? WHERE id=? AND user_id=?').run(name, tag.id, user.id); } catch { return fail(res, 409, 'DUPLICATE_TAG', '已存在同名标签。'); } audit(user.id, 'tag.rename', tag.id); return ok(res, db.prepare('SELECT id,name,created_at FROM tags WHERE id=?').get(tag.id)); } return fail(res, 405, 'METHOD_NOT_ALLOWED', '不支持的标签操作。'); }
  if (path === '/api/v1/collections') { const user = tokenUser(req, req.method === 'POST' ? ['items:write'] : ['items:read']); if (!user) return fail(res, 401, 'INVALID_TOKEN', 'Token 无效、已撤销或没有所需权限。'); if (req.method === 'GET') return ok(res, folderSummary(user.id, url.searchParams)); if (req.method === 'POST') { const body = await readBody(req); const name = normalizedName(body.name, { maxLength: 9 }); if (!name) return fail(res, 400, 'INVALID_COLLECTION', '收藏夹名称为 1-9 个字符，且不能包含控制字符。'); const collectionId = id('fld'); try { db.prepare('INSERT INTO folders (id,user_id,name,sort_order,created_at) VALUES (?,?,?,?,?)').run(collectionId, user.id, name, Number(body.sortOrder || 0), now()); } catch { return fail(res, 409, 'DUPLICATE_COLLECTION', '已存在同名收藏夹。'); } audit(user.id, 'collection.create', collectionId); return ok(res, db.prepare('SELECT * FROM folders WHERE id=?').get(collectionId), 201); } return fail(res, 405, 'METHOD_NOT_ALLOWED', '不支持的收藏夹操作。'); }
  const v1CollectionBookmarkMatch = path.match(/^\/api\/v1\/collections\/([^/]+)\/bookmarks\/([^/]+)$/);
  if (v1CollectionBookmarkMatch) { const user = tokenUser(req, ['items:write']); if (!user) return fail(res, 401, 'INVALID_TOKEN', 'Token 无效、已撤销或没有所需权限。'); if (req.method !== 'DELETE') return fail(res, 405, 'METHOD_NOT_ALLOWED', '仅支持 DELETE 移出收藏夹。'); const collection = db.prepare('SELECT id FROM folders WHERE id=? AND user_id=?').get(v1CollectionBookmarkMatch[1], user.id); const item = itemForUser(user.id, v1CollectionBookmarkMatch[2]); if (!collection || !item) return fail(res, 404, 'NOT_FOUND', '未找到收藏夹或书签。'); const result = db.prepare('DELETE FROM item_folders WHERE folder_id=? AND item_id=?').run(collection.id, item.id); if (!result.changes) return fail(res, 404, 'NOT_FOUND', '书签不在该收藏夹中。'); audit(user.id, 'collection.bookmark.remove', collection.id); return ok(res, { removed: true }); }
  const v1CollectionMatch = path.match(/^\/api\/v1\/collections\/([^/]+)$/);
  if (v1CollectionMatch) { const user = tokenUser(req, req.method === 'GET' ? ['items:read'] : ['items:write']); if (!user) return fail(res, 401, 'INVALID_TOKEN', 'Token 无效、已撤销或没有所需权限。'); const collection = db.prepare('SELECT * FROM folders WHERE id=? AND user_id=?').get(v1CollectionMatch[1], user.id); if (!collection) return fail(res, 404, 'NOT_FOUND', '未找到收藏夹。'); if (req.method === 'GET') return ok(res, folderDetail(user.id, collection.id, url.searchParams)); if (req.method === 'PATCH') { const body = await readBody(req); const name = normalizedName(body.name, { maxLength: 9 }); if (!name) return fail(res, 400, 'INVALID_COLLECTION', '收藏夹名称为 1-9 个字符，且不能包含控制字符。'); try { db.prepare('UPDATE folders SET name=? WHERE id=?').run(name, collection.id); } catch { return fail(res, 409, 'DUPLICATE_COLLECTION', '已存在同名收藏夹。'); } audit(user.id, 'collection.rename', collection.id); return ok(res, db.prepare('SELECT * FROM folders WHERE id=?').get(collection.id)); } if (req.method === 'DELETE') { const removed = db.prepare('SELECT count(*) AS total FROM item_folders WHERE folder_id=?').get(collection.id).total; db.prepare('DELETE FROM folders WHERE id=?').run(collection.id); audit(user.id, 'collection.delete', collection.id); return ok(res, { deleted: true, removed }); } return fail(res, 405, 'METHOD_NOT_ALLOWED', '不支持的收藏夹操作。'); }
  if (path === '/api/v1/timeline') { const user = tokenUser(req, ['items:read']); if (!user) return fail(res, 401, 'INVALID_TOKEN', 'Token 无效、已撤销或没有所需权限。'); if (req.method !== 'GET') return fail(res, 405, 'METHOD_NOT_ALLOWED', '仅支持 GET 读取时间轴。'); return ok(res, listTimeline(user.id, url.searchParams)); }
  if (path === '/api/v1/data/export' && req.method === 'GET') { const user = tokenUser(req, ['items:read']); if (!user) return fail(res, 401, 'INVALID_TOKEN', 'Token 无效、已撤销或没有所需权限。'); if (user.role !== 'admin') return fail(res, 403, 'FORBIDDEN', '完整服务数据仅限管理员导出。'); const tableNames = serviceBackupTables; const tables = Object.fromEntries(tableNames.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()])); const payload = { format: 'paperleaf-service-backup', version: '1.0.0', exportedAt: now(), system: { tokenEncryptionKey: configuredTokenSecret ? null : tokenEncryptionSecret, tokenKeyManagedByEnvironment: Boolean(configuredTokenSecret), archiveNotice: '文章本地归档文件不会随 JSON 导出或在导入时自动删除。微信公众号订阅源会导出，但微信读书 Cookie、同步记录和去重记录不会导出，恢复后需重新扫码授权。' }, tables }; res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="paperleaf-service-backup-${new Date().toISOString().slice(0, 10)}.json"` }); return res.end(JSON.stringify(payload, null, 2)); }
  if (path === '/api/v1/data/import' && req.method === 'POST') { const user = tokenUser(req, ['items:write']); if (!user) return fail(res, 401, 'INVALID_TOKEN', 'Token 无效、已撤销或没有所需权限。'); if (user.role !== 'admin') return fail(res, 403, 'FORBIDDEN', '完整服务数据仅限管理员导入。'); const body = await readBody(req); const tableNames = serviceBackupTables; if (body?.format !== 'paperleaf-service-backup' || !body.tables || body.confirmReplace !== true || !tableNames.every((table) => Array.isArray(body.tables[table]))) return fail(res, 400, 'INVALID_BACKUP', '请选择有效的完整服务备份文件，并确认覆盖当前全部服务数据。'); if (!body.tables.users.some((entry) => entry && entry.role === 'admin' && !entry.disabled)) return fail(res, 400, 'INVALID_BACKUP', '备份中至少需要保留一个启用的管理员账号。'); const backupKey = String(body.system?.tokenEncryptionKey || ''); if (configuredTokenSecret && backupKey) return fail(res, 400, 'TOKEN_KEY_MANAGED', '当前服务使用环境变量管理 Token 加密密钥，不能导入含独立密钥的备份。'); if (!configuredTokenSecret && !backupKey && body.tables.api_tokens.length) return fail(res, 400, 'MISSING_TOKEN_KEY', '该备份缺少 Token 加密密钥，无法安全恢复 API Token。'); const columns = Object.fromEntries(tableNames.map((table) => [table, db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name)])); if (!tableNames.every((table) => body.tables[table].every((row) => row && typeof row === 'object' && columns[table].every((column) => Object.hasOwn(row, column))))) return fail(res, 400, 'INVALID_BACKUP', '备份数据结构与当前服务版本不兼容。'); db.exec('BEGIN IMMEDIATE'); try { ['sessions', 'mp_review_records', 'mp_sync_runs', 'weread_auth', 'mp_subscriptions', 'mp_sync_settings', 'timeline_events', 'highlights', 'item_tags', 'item_folders', 'api_tokens', 'user_preferences', 'audit_logs', 'items', 'tags', 'folders', 'users'].forEach((table) => db.exec(`DELETE FROM ${table}`)); tableNames.forEach((table) => { if (!body.tables[table].length) return; const names = columns[table]; const statement = db.prepare(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`); body.tables[table].forEach((row) => statement.run(...names.map((name) => row[name]))); }); if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('备份数据的关联关系校验失败。'); db.exec('COMMIT'); } catch (error) { try { db.exec('ROLLBACK'); } catch {} return fail(res, 400, 'IMPORT_FAILED', `导入失败：${error.message}`); } if (!configuredTokenSecret && backupKey) { writeFileSync(tokenKeyPath, backupKey, { mode: 0o600 }); tokenEncryptionSecret = backupKey; tokenEncryptionKey = createHash('sha256').update(backupKey).digest(); } clearCookie(res); return ok(res, { imported: true, counts: Object.fromEntries(tableNames.map((table) => [table, body.tables[table].length])), message: '完整服务数据已恢复。请使用备份中的账号重新登录。' }); }
  if (path === '/api/v1/items') { const user = tokenUser(req, req.method === 'POST' ? ['items:write'] : ['items:read']); if (!user) return fail(res, 401, 'INVALID_TOKEN', 'Token 无效、已撤销或没有所需权限。'); if (req.method === 'GET') return ok(res, listItems(user.id, url.searchParams)); if (req.method === 'POST') { const result = await createItem(user.id, await readBody(req)); return ok(res, result, result.duplicate ? 200 : 201); } }
  if (path === '/api/v1/me' && req.method === 'GET') { const user = tokenUser(req, []); if (!user) return fail(res, 401, 'INVALID_TOKEN', 'Token 无效或已撤销。'); return ok(res, { username: user.username }); }
  if (path === '/api/v1/tags' && req.method === 'GET') { const user = tokenUser(req, ['items:read']); if (!user) return fail(res, 401, 'INVALID_TOKEN', 'Token 无效、已撤销或没有所需权限。'); return ok(res, { tags: db.prepare('SELECT id,name FROM tags WHERE user_id=? ORDER BY name COLLATE NOCASE ASC').all(user.id) }); }
  const v1HighlightMatch = path.match(/^\/api\/v1\/items\/([^/]+)\/highlights$/);
  if (v1HighlightMatch && req.method === 'POST') { const user = tokenUser(req, ['items:write']); if (!user) return fail(res, 401, 'INVALID_TOKEN', 'Token 无效、已撤销或没有所需权限。'); const item = itemForUser(user.id, v1HighlightMatch[1]); if (!item) return fail(res, 404, 'NOT_FOUND', '未找到该条目。'); const body = await readBody(req); const text = String(body.text || '').trim().slice(0, 4000); if (!text) return fail(res, 400, 'INVALID_HIGHLIGHT', '高亮内容不能为空。'); const highlightId = id('hlt'); const timestamp = now(); db.exec('BEGIN'); try { db.prepare('INSERT INTO highlights (id,item_id,text,note_title,note,color,start_offset,end_offset,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(highlightId, item.id, text, '', '', 'yellow', null, null, timestamp, timestamp); timelineEvent(user.id, item.id, 'highlight_created', highlightId, timestamp); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } audit(user.id, 'highlight.create', highlightId); return ok(res, db.prepare('SELECT * FROM highlights WHERE id=?').get(highlightId), 201); }
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
  const extension = extname(file).toLowerCase();
  const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.html': 'text/html; charset=utf-8', '.pdf': 'application/pdf' };
  // PDFs may be regenerated after an archive repair. Do not serve a year-long
  // immutable response for a file whose contents can legitimately be replaced.
  const cacheControl = extension === '.pdf' ? 'private, no-cache, max-age=0, must-revalidate' : 'private, max-age=31536000, immutable';
  res.writeHead(200, { 'Content-Type': types[extension] || 'application/octet-stream', 'Cache-Control': cacheControl }); createReadStream(file).pipe(res);
}
function serveMpRss(req, res, url) {
  const feedMatch = url.pathname.match(/^\/feed\/([^/]+)\.rss$/);
  const legacyMatch = url.pathname.match(/^\/rss\/mp\/([^/]+)\/([^/]+)\.xml$/);
  if ((!feedMatch && !legacyMatch) || req.method !== 'GET') { res.writeHead(404); return res.end('Not found'); }
  // The canonical public URL mirrors the WeRead public-account ID, e.g. /feed/MP_WXS_3097726746.rss.
  const subscription = feedMatch
    ? db.prepare('SELECT id,book_id,name,cover_url,rss_token,updated_at FROM mp_subscriptions WHERE book_id=? ORDER BY created_at ASC LIMIT 1').get(decodeURIComponent(feedMatch[1]))
    : db.prepare('SELECT id,book_id,name,cover_url,rss_token,updated_at FROM mp_subscriptions WHERE id=? AND rss_token=?').get(decodeURIComponent(legacyMatch[1]), decodeURIComponent(legacyMatch[2]));
  if (!subscription) { res.writeHead(404); return res.end('Not found'); }
  const sevenDaysAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const articles = db.prepare(`SELECT i.id,i.url,i.title,i.summary,i.created_at,COALESCE(NULLIF(i.mp_image_url,''),s.cover_url,'') AS image_url,r.review_id
    FROM mp_review_records r JOIN items i ON i.id=r.item_id AND i.user_id=r.user_id JOIN mp_subscriptions s ON s.id=r.subscription_id
    WHERE r.subscription_id=? AND i.source_type='mp' AND i.created_at>=?
    ORDER BY i.created_at DESC,i.id DESC`).all(subscription.id, sevenDaysAgo);
  const feedPath = `/feed/${encodeURIComponent(subscription.book_id)}.rss`;
  const rssDate = (value) => {
    const timestamp = new Date(value).getTime(); if (!Number.isFinite(timestamp)) return '';
    const date = new Date(timestamp + 8 * 60 * 60 * 1000);
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']; const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const pad = (number) => String(number).padStart(2, '0');
    return `${weekdays[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0800`;
  };
  const rssImageType = (imageUrl) => {
    try {
      const parsed = new URL(imageUrl); const format = (parsed.searchParams.get('wx_fmt') || extname(parsed.pathname).slice(1)).toLowerCase();
      return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' })[format] || 'image/jpeg';
    } catch { return 'image/jpeg'; }
  };
  const entries = articles.map((article) => {
    const title = String(article.title || '未命名文章'); const description = String(article.summary || title).replace(/\s+/g, ' ').trim();
    const reviewId = String(article.review_id || article.id).replace(/^MP_WXS_/, ''); const identifier = `${subscription.book_id.replace(/^MP_WXS_/, '')}-${reviewId}`;
    const enclosure = article.image_url ? `<enclosure url="${html(article.image_url)}" length="0" type="${rssImageType(article.image_url)}"></enclosure>` : '';
    return ['    <item>', `      <id>${html(identifier)}</id>`, `      <title>${html(title)}</title>`, `      <description>${html(description)}</description>`, `      <guid>${html(article.url)}</guid>`, enclosure && `      ${enclosure}`, `      <link>${html(article.url)}</link>`, `      <pubDate>${rssDate(article.created_at)}</pubDate>`, '    </item>'].filter(Boolean).join('\n');
  }).join('\n');
  const channelImage = subscription.cover_url ? ['    <image>', `      <url>${html(subscription.cover_url)}</url>`, `      <title>${html(subscription.name)}</title>`, `      <link>${html(feedPath)}</link>`, '    </image>'].join('\n') : '';
  const channel = ['  <channel>', `    <title>${html(subscription.name)}</title>`, `    <link>${html(feedPath)}</link>`, `    <description>${html(`${subscription.name} 的微信公众号订阅，由 PaperLeaf 通过微信读书同步，保留最近 7 天文章。`)}</description>`, '    <language>zh-CN</language>', '    <generator>PaperLeaf</generator>', `    <lastBuildDate>${rssDate(new Date())}</lastBuildDate>`, channelImage, entries, '  </channel>'].filter(Boolean).join('\n');
  const xml = `<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0">\n${channel}\n</rss>\n`;
  res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'private, max-age=300' });
  res.end(xml);
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
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
  res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); createReadStream(file).pipe(res);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  migrate(); await seed(); migrateArchivePaths(); if (process.env.PAPERLEAF_REBUILD_PDFS === '1') await createMissingArchivePdfs({ force: true }); startLibraryMonitor(); startMpSubscriptionScheduler();
  createServer(async (req, res) => { try { const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); if (url.pathname.startsWith('/api/')) await api(req, res, url); else if (url.pathname.startsWith('/feed/') || url.pathname.startsWith('/rss/')) serveMpRss(req, res, url); else serveStatic(req, res, url); } catch (error) { console.error(error); fail(res, 500, 'INTERNAL_ERROR', '请求未完成，请稍后重试。'); } }).listen(port, host, () => console.log(`PaperLeaf listening on http://${host}:${port}`));
}

export { archiveSegment, archiveSnapshot, clearItemArchive, clientSnapshotPage, createArchivePdf, fetchPage, itemData, sanitizeDocument };
