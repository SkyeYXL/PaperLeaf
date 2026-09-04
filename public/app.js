const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const docsSettingsTarget = new URLSearchParams(window.location.search).get('settings');
const state = { user: null, status: 'all', tag: '', folderId: '', search: '', items: [], dashboard: null, reader: null, workspace: 'articles', homeView: 'list', notes: [], noteTotal: 0, selectedNoteId: '', noteArticleQuery: '', noteField: 'note', noteArticleStatus: 'all', notesScroll: 0, noteEditing: false, noteArticleSuggestions: [], manageMode: 'folders', manageRows: [], manageTags: [], manageSelectedId: '', manageDetail: null, manageQuery: '', manageDialog: null, manageDialogType: 'folders', timelineItems: [], timelinePage: 1, timelineTotal: 0, timelineHasMore: false, timelineStats: { events: 0, articles: 0, notes: 0, archivedArticles: 0 }, timelineType: 'all', timelineArticleStatus: 'all', timelineView: 'cards', mp: null };
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const mpMediaUrl = (value = '') => value ? `/api/mp/media?url=${encodeURIComponent(value)}` : '';
const readerDate = (value) => { const date = new Date(value); const pad = (number) => String(number).padStart(2, '0'); return `${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`; };
const shortDate = readerDate;
const domain = (value) => { try { return new URL(value).hostname; } catch { return value; } };
const sourceLabel = (value) => { const host = domain(value).replace(/^www\./i, ''); const labels = { 'mp.weixin.qq.com': '微信', 'juejin.cn': '掘金', 'zhihu.com': '知乎', 'medium.com': 'Medium', 'developer.mozilla.org': 'MDN', 'css-tricks.com': 'CSS-Tricks' }; return labels[host] || host; };
let toastTimer;
let progressSaveTimer;
let pendingHighlightSelection = null;
let pendingHighlightDelete = null;
let pendingItemDelete = null;
let pendingTokenRevoke = null;
let pendingNoteDelete = null;
let noteSearchTimer;
let propertyTags = [];
let propertyTagOptions = [];
let imagePreviewScale = 1;
const readerDisplayDefaults = { font: 17, family: 'songti', width: 'standard', line: 'normal', mode: 'classic' };
let readerDisplay = { ...readerDisplayDefaults };
let mpQrTimer = null;
let mpQrPolling = false;
let selectedMpBookIds = new Set();
const mpArticlePageSizeOptions = [{ value: '10', label: '每页 10 篇' }, { value: '20', label: '每页 20 篇' }, { value: '50', label: '每页 50 篇' }, { value: '100', label: '每页 100 篇' }];
let mpArticlePage = 1;
let mpArticlePageSize = [10, 20, 50, 100].includes(Number(localStorage.getItem('paperleaf-mp-article-page-size'))) ? Number(localStorage.getItem('paperleaf-mp-article-page-size')) : 20;

function toast(message) { const element = $('#toast'); element.textContent = message; element.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => element.classList.remove('show'), 3200); }
async function request(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const body = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error(body?.error?.message || '请求未完成，请稍后重试。');
  return body.data;
}
function dialog(id) { const element = $(`#${id}`); if (!element.open) element.showModal(); }
function closeDialog(id) { $(`#${id}`).close(); }
function readingProgress(item) { return item.is_read ? 1 : Math.min(0.99, Math.max(0, Number(item.reading_progress) || 0)); }
function renderReadingRing(item) { const progress = readingProgress(item); const percent = Math.round(progress * 100); return `<span class="reading-ring ${item.is_read ? 'is-complete' : ''}" style="--reading-progress:${percent}%" role="img" aria-label="${item.is_read ? '已读' : `未读，阅读进度 ${percent}%`}">${item.is_read ? '<i class="ti ti-check" aria-hidden="true"></i>' : ''}</span>`; }
function renderTags(tags = []) { return tags.map((tag) => `<span>#${escapeHtml(tag.name)}</span>`).join(''); }
function closeSelect(control) { control.classList.remove('is-open'); control.querySelector('.select-trigger')?.setAttribute('aria-expanded', 'false'); }
function setupSelectControl(control, input) {
  if (control.dataset.ready) return;
  const trigger = control.querySelector('.select-trigger'); const menu = control.querySelector('.select-menu');
  trigger.addEventListener('click', () => { const open = !control.classList.contains('is-open'); $$('.select-control.is-open').forEach(closeSelect); control.classList.toggle('is-open', open); trigger.setAttribute('aria-expanded', String(open)); if (open) menu.querySelector('[aria-selected="true"], [role="option"]')?.focus(); });
  trigger.addEventListener('keydown', (event) => { if (event.key === 'Escape') { closeSelect(control); trigger.focus(); } if (event.key === 'ArrowDown') { event.preventDefault(); if (!control.classList.contains('is-open')) trigger.click(); menu.querySelector('[aria-selected="true"], [role="option"]')?.focus(); } });
  menu.addEventListener('click', (event) => { const option = event.target.closest('[role="option"]'); if (!option) return; input.value = option.dataset.value; trigger.querySelector('span').textContent = option.textContent; menu.querySelectorAll('[role="option"]').forEach((entry) => entry.setAttribute('aria-selected', String(entry === option))); closeSelect(control); trigger.focus(); input.dispatchEvent(new Event('change', { bubbles: true })); });
  menu.addEventListener('keydown', (event) => { const options = [...menu.querySelectorAll('[role="option"]')]; const index = options.indexOf(document.activeElement); if (event.key === 'Escape') { closeSelect(control); trigger.focus(); } if (event.key === 'ArrowDown' && index < options.length - 1) { event.preventDefault(); options[index + 1].focus(); } if (event.key === 'ArrowUp' && index > 0) { event.preventDefault(); options[index - 1].focus(); } if ((event.key === 'Enter' || event.key === ' ') && index >= 0) { event.preventDefault(); options[index].click(); } });
  control.dataset.ready = 'true';
}
function setSelectOptions(control, input, options) {
  const currentValue = input.value;
  if (input.tagName === 'SELECT') input.innerHTML = options.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join('');
  const selected = options.some((option) => option.value === currentValue) ? currentValue : options[0]?.value || '';
  input.value = selected; const trigger = control.querySelector('.select-trigger'); const menu = control.querySelector('.select-menu'); const choice = options.find((option) => option.value === selected) || options[0];
  trigger.querySelector('span').textContent = choice?.label || '请选择';
  menu.innerHTML = options.map((option) => `<button type="button" role="option" data-value="${escapeHtml(option.value)}" aria-selected="${option.value === selected}">${escapeHtml(option.label)}</button>`).join('');
  setupSelectControl(control, input);
}
function upgradeReaderFontSelect() {
  const select = $('#reader-font-family'); const control = $('#reader-font-family-control'); if (!select || !control) return;
  setSelectOptions(control, select, [...select.options].map((option) => ({ value: option.value, label: option.textContent })));
}
function renderItems() {
  const list = $('#item-list'); const cards = $('#card-grid'); const empty = $('#empty-state');
  $('#item-count').textContent = `${state.items.length} 篇`;
  empty.classList.toggle('hidden', state.items.length > 0);
  const rows = state.items.map((item, index) => `<article class="item"><span class="item-number">${String(index + 1).padStart(2, '0')}</span><button class="item-main" type="button" data-open-item="${item.id}" aria-label="打开文章：${escapeHtml(item.title)}"><span class="item-title">${escapeHtml(item.title)}</span><span class="item-meta"><span>${escapeHtml(domain(item.url))}</span><span>${shortDate(item.created_at)}</span>${item.tags.slice(0, 2).map((tag) => `<span>#${escapeHtml(tag.name)}</span>`).join('')}</span></button><div class="item-actions" aria-label="文章操作">${renderReadingRing(item)}<button class="list-action ${item.is_favorite ? 'active' : ''}" type="button" data-list-favorite="${item.id}" aria-label="${item.is_favorite ? '取消收藏' : '收藏'}" aria-pressed="${item.is_favorite}" title="${item.is_favorite ? '取消收藏' : '收藏'}"><i class="ti ti-star"></i></button><button class="list-action ${item.is_archived ? 'active' : ''}" type="button" data-list-archive="${item.id}" aria-label="${item.is_archived ? '取消归档' : '归档'}" aria-pressed="${item.is_archived}" title="${item.is_archived ? '取消归档' : '归档'}"><i class="ti ti-archive"></i></button><button class="list-action" type="button" data-list-source="${item.id}" aria-label="打开原文" title="打开原文"><i class="ti ti-external-link"></i></button><button class="list-action danger" type="button" data-list-delete="${item.id}" aria-label="删除文章" title="删除文章"><i class="ti ti-trash"></i></button></div></article>`).join('');
  const cardRows = state.items.map((item) => { const source = sourceLabel(item.url); const sourceInitial = source.slice(0, 1).toUpperCase() || '纸'; return `<article class="card"><button class="card-main" type="button" data-open-item="${item.id}" aria-label="打开文章：${escapeHtml(item.title)}"><h3>${escapeHtml(item.title)}</h3><p class="ex">${escapeHtml(item.summary || '尚未提取到摘要。')}</p><div class="tg">${renderTags(item.tags)}</div><div class="ft"><span class="av">${escapeHtml(sourceInitial)}</span><span class="card-source">${escapeHtml(source)}</span><span class="card-time">${shortDate(item.created_at)}</span></div></button><div class="card-actions" aria-label="文章操作">${renderReadingRing(item)}<button class="list-action ${item.is_favorite ? 'active' : ''}" type="button" data-list-favorite="${item.id}" aria-label="${item.is_favorite ? '取消收藏' : '收藏'}" aria-pressed="${item.is_favorite}" title="${item.is_favorite ? '取消收藏' : '收藏'}"><i class="ti ti-star"></i></button><button class="list-action ${item.is_archived ? 'active' : ''}" type="button" data-list-archive="${item.id}" aria-label="${item.is_archived ? '取消归档' : '归档'}" aria-pressed="${item.is_archived}" title="${item.is_archived ? '取消归档' : '归档'}"><i class="ti ti-archive"></i></button><button class="list-action" type="button" data-list-source="${item.id}" aria-label="打开原文" title="打开原文"><i class="ti ti-external-link"></i></button><button class="list-action danger" type="button" data-list-delete="${item.id}" aria-label="删除文章" title="删除文章"><i class="ti ti-trash"></i></button></div></article>`; }).join('');
  list.innerHTML = rows; cards.innerHTML = cardRows;
  $$('[data-open-item]').forEach((button) => button.addEventListener('click', () => openItem(button.dataset.openItem)));
  $$('[data-list-favorite]').forEach((button) => button.addEventListener('click', async () => {
    const item = state.items.find((entry) => entry.id === button.dataset.listFavorite); if (!item) return;
    try { await request(`/api/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ is_favorite: !item.is_favorite }) }); await loadContent(); toast(item.is_favorite ? '已取消收藏。' : '已收藏。'); } catch (error) { toast(error.message); }
  }));
  $$('[data-list-archive]').forEach((button) => button.addEventListener('click', async () => {
    const item = state.items.find((entry) => entry.id === button.dataset.listArchive); if (!item) return;
    try { await request(`/api/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ is_archived: !item.is_archived }) }); await loadContent(); toast(item.is_archived ? '已取消归档。' : '已归档。'); } catch (error) { toast(error.message); }
  }));
  $$('[data-list-source]').forEach((button) => button.addEventListener('click', () => {
    const item = state.items.find((entry) => entry.id === button.dataset.listSource); if (item) window.open(item.url, '_blank', 'noopener,noreferrer');
  }));
  $$('[data-list-delete]').forEach((button) => button.addEventListener('click', async () => {
    const item = state.items.find((entry) => entry.id === button.dataset.listDelete); if (!item) return;
    pendingItemDelete = item.id; $('#home-delete-copy').textContent = `删除「${item.title}」后，文章快照、图片、高亮与笔记将无法恢复。`; dialog('home-delete-dialog');
  }));
}
function renderDashboard() {
  const dashboard = state.dashboard; if (!dashboard) return;
  const allActive = !state.folderId;
  const recentFolders = [...dashboard.folders].sort((left, right) => String(right.created_at || '').localeCompare(String(left.created_at || ''))).slice(0, 5);
  $('#folder-list').innerHTML = `<button class="${allActive ? 'active' : ''}" data-folder="">全部内容 <small>${dashboard.counts.all}</small></button>${recentFolders.map((folder) => `<button class="${state.folderId === folder.id ? 'active' : ''}" data-folder="${folder.id}">${escapeHtml(folder.name)} <small>${folder.count}</small></button>`).join('')}`;
  $('#tag-list').innerHTML = dashboard.tags.length ? dashboard.tags.map((tag) => `<button class="${state.tag === tag.name ? 'active' : ''}" data-tag="${escapeHtml(tag.name)}">#${escapeHtml(tag.name)} <small>${tag.count}</small></button>`).join('') : '<span>保存文章后显示标签</span>';
  setSelectOptions($('#save-folder-control'), $('#save-folder-select'), [{ value: '', label: '不归入收藏夹' }, ...dashboard.folders.map((folder) => ({ value: folder.id, label: folder.name }))]);
  const mpAuth = dashboard.mpAuth || { configured: false, status: 'missing' };
  const mpAuthorized = mpAuth.configured && mpAuth.status === 'active';
  const mpSubscriptionCount = Number(dashboard.mpSubscriptionCount || 0);
  $('#wx-card').classList.toggle('is-authorized', mpAuthorized);
  $('#wx-card-copy').textContent = mpAuthorized
    ? `微信读书已授权${mpSubscriptionCount ? `，已订阅 ${mpSubscriptionCount} 个公众号。` : '，可从书架添加公众号。'}`
    : mpAuth.status === 'expired' ? '微信读书授权已失效，请重新扫码后继续同步。' : '尚未授权微信读书，扫码后即可同步已关注的公众号文章。';
  $('#wx-button-label').textContent = mpAuthorized ? '管理公众号订阅' : '前往扫码授权';
  const recentItem = dashboard.recentItem;
  $('#daily-pick').innerHTML = recentItem ? `<button data-open-item="${recentItem.id}"><strong>${escapeHtml(recentItem.title)}</strong><span>最近访问 · ${shortDate(recentItem.last_opened_at)}</span></button>` : '<span class="setting-copy">阅读文章后会显示最近访问</span>';
  $('#recent-highlights').innerHTML = dashboard.highlights.length ? dashboard.highlights.map((highlight) => `<article class="home-note-entry"><button data-open-highlight="${highlight.id}" data-item-id="${highlight.item_id}" aria-label="跳转至笔记：${escapeHtml(highlight.title)}"><span class="home-note-mark"><i class="ti ti-note"></i></span><span class="home-note-body"><strong>${escapeHtml(highlight.note || '未添加笔记')}</strong><span class="home-note-quote">${escapeHtml(highlight.text)}</span><em>${escapeHtml(highlight.title)} · ${shortDate(highlight.created_at)}</em></span></button></article>`).join('') : '<div class="home-note-empty"><span>尚未添加笔记</span></div>';
  $$('[data-folder]').forEach((button) => button.addEventListener('click', () => { state.folderId = button.dataset.folder; state.tag = ''; loadContent(); }));
  $$('[data-tag]').forEach((button) => button.addEventListener('click', () => { state.tag = state.tag === button.dataset.tag ? '' : button.dataset.tag; state.folderId = ''; loadContent(); }));
  $$('[data-open-item]').forEach((button) => button.addEventListener('click', () => openItem(button.dataset.openItem)));
  $$('[data-open-highlight]').forEach((button) => button.addEventListener('click', async () => { await openItem(button.dataset.itemId); requestAnimationFrame(() => requestAnimationFrame(() => jumpToHighlight(button.dataset.openHighlight))); }));
}
function updateHeading() {
  const labels = { all: '全部内容', unread: '未读', archived: '归档', favorite: '收藏' };
  $('#heading-label').textContent = state.search ? `搜索 · ${state.search}` : state.tag ? `标签 · #${state.tag}` : state.folderId ? '收藏夹' : labels[state.status];
  $('#heading-title').textContent = state.search ? `标题包含「${state.search}」的文章。` : state.status === 'unread' ? '还没有读过的，仍在这里等你。' : state.status === 'archived' ? '已经读完，也仍然可以回来。' : state.status === 'favorite' ? '值得反复翻看的内容。' : state.tag ? `关于「${state.tag}」的阅读。` : '先收下，留给稍后的自己。';
}
const articleStatuses = new Set(['all', 'unread', 'archived', 'favorite']);
const homeViewStorageKey = 'paperleaf.homepageView';
function savedHomeView() {
  try { return localStorage.getItem(homeViewStorageKey) === 'cards' ? 'cards' : 'list'; }
  catch { return 'list'; }
}
function setHomeView(view) {
  state.homeView = view === 'cards' ? 'cards' : 'list';
  document.body.dataset.view = state.homeView;
  $$('.home-view-toggle [data-view]').forEach((button) => {
    const active = button.dataset.view === state.homeView;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}
function articlesRoute() {
  const params = new URLSearchParams();
  if (state.status !== 'all') params.set('status', state.status);
  return `${window.location.pathname}${params.size ? `?${params}` : ''}`;
}
function syncArticlesRoute({ replace = false } = {}) {
  if (state.workspace !== 'articles' || readerIdFromLocation()) return;
  const route = articlesRoute();
  if (`${window.location.pathname}${window.location.search}` === route) return;
  history[replace ? 'replaceState' : 'pushState']({ workspace: 'articles', status: state.status }, '', route);
}
function noteTitle(note) { return String(note.title || '').trim() || '未命名笔记'; }
function noteUrlState() {
  const params = new URLSearchParams();
  if (state.noteArticleQuery) params.set('articleQ', state.noteArticleQuery);
  if (state.noteQuery) params.set('noteQ', state.noteQuery);
  if (state.noteField !== 'note') params.set('noteField', state.noteField);
  if (state.noteArticleStatus !== 'all') params.set('noteArticleStatus', state.noteArticleStatus);
  if (state.selectedNoteId) params.set('note', state.selectedNoteId);
  return params;
}
function syncNotesRoute({ replace = false } = {}) {
  if (state.workspace !== 'notes') return;
  const query = noteUrlState().toString(); const route = `${window.location.pathname}${query ? `?${query}` : ''}#notes`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === route) return;
  history[replace ? 'replaceState' : 'pushState']({ workspace: 'notes' }, '', route);
}
function clearNotesRoute() {
  if (window.location.hash === '#notes' || new URLSearchParams(window.location.search).has('note')) history.pushState({ workspace: 'articles', status: state.status }, '', articlesRoute());
}
function openNotesWorkspace({ restore = false } = {}) {
  state.workspace = 'notes'; state.tag = ''; state.folderId = ''; state.search = '';
  state.noteEditing = false; $('#notes-page').classList.remove('hidden'); $('.layout').classList.add('hidden'); $('#application').classList.add('notes-active');
  $$('.nav-link').forEach((button) => button.classList.toggle('active', button.dataset.workspace === 'notes'));
  $('#notes-article-search').value = state.noteArticleQuery; $('#notes-note-search').value = state.noteQuery; $('#notes-note-field').value = state.noteField;
  setSelectOptions($('#notes-note-field-control'), $('#notes-note-field'), [{ value: 'note', label: '笔记内容' }, { value: 'highlight', label: '高亮片段' }]);
  loadNotes({ restore });
}
function renderNotes() {
  const notes = state.notes; const list = $('#notes-list'); const empty = $('#notes-empty'); const selected = notes.find((note) => note.id === state.selectedNoteId) || notes[0] || null;
  if (selected && selected.id !== state.selectedNoteId) state.selectedNoteId = selected.id;
  $('#notes-count').textContent = `${state.noteTotal} 条`;
  list.innerHTML = notes.map((note, index) => `<button class="note-list-row ${note.id === state.selectedNoteId ? 'active' : ''}" type="button" role="option" aria-selected="${note.id === state.selectedNoteId}" data-note-select="${note.id}"><span class="note-list-index">${String(index + 1).padStart(2, '0')}</span><span class="note-list-body"><strong>${escapeHtml(noteTitle(note))}</strong><span class="note-list-summary">${escapeHtml(note.note)}</span><span class="note-list-quote">${escapeHtml(note.text)}</span><span class="note-list-meta">${escapeHtml(note.article.title)} · 创建于 ${readerDate(note.created_at)}</span></span>${note.article.is_archived ? '<em>已归档</em>' : ''}</button>`).join('');
  const noMatches = state.noteTotal === 0 && (state.noteArticleQuery || state.noteQuery || state.noteArticleStatus !== 'all');
  empty.classList.toggle('hidden', notes.length > 0); list.classList.toggle('hidden', notes.length === 0);
  $('#notes-empty-title').textContent = noMatches ? '没有匹配的笔记' : '在阅读页选中正文后添加高亮';
  $('#notes-empty-copy').textContent = noMatches ? '保留当前搜索和筛选条件，你可以清除搜索后继续查看。' : '在阅读页划线并写下标题和笔记后，它会集中显示在这里。';
  $('#notes-clear-search').classList.toggle('hidden', !noMatches);
  renderNoteDetail(selected);
  $$('[data-note-select]').forEach((button) => button.addEventListener('click', () => { state.selectedNoteId = button.dataset.noteSelect; syncNotesRoute(); renderNotes(); }));
  requestAnimationFrame(sizeNotesListToFiveRows);
  updateNoteControls();
}
function sizeNotesListToFiveRows() {
  const list = $('#notes-list'); const rows = [...list.querySelectorAll('.note-list-row')];
  if (!list || !rows.length || window.innerWidth <= 900) return;
  const visibleRows = rows.slice(0, 5); const firstTop = visibleRows[0].offsetTop; const fifthBottom = visibleRows.at(-1).offsetTop + visibleRows.at(-1).offsetHeight;
  const height = fifthBottom - firstTop;
  list.style.height = `${height}px`; list.style.maxHeight = `${height}px`;
}
function renderNoteDetail(note) {
  const detail = $('#notes-detail');
  if (!note) { detail.innerHTML = '<section class="notes-detail-empty"><i class="ti ti-notebook"></i><p>选择一条笔记后在这里查看详情。</p></section>'; return; }
  if (state.noteEditing) { detail.innerHTML = `<header class="notes-detail-header"><div><p class="eyebrow">编辑笔记</p><h2>修改这段阅读记录</h2></div></header><form class="note-inline-editor" id="note-inline-editor"><label>笔记标题<input name="title" maxlength="120" required value="${escapeHtml(noteTitle(note))}"></label><label>笔记内容<textarea name="note" maxlength="1000" required>${escapeHtml(note.note)}</textarea><span class="field-hint"><span id="note-inline-count">${note.note.length}</span> / 1000</span></label><section class="note-editor-quote"><p>高亮文字</p><blockquote>${escapeHtml(note.text)}</blockquote></section><p class="form-message" id="note-inline-message" role="alert"></p><footer class="note-detail-footer"><button class="secondary" type="button" data-note-edit-cancel>取消</button><button class="primary" type="submit"><i class="ti ti-device-floppy"></i>保存</button></footer></form>`; detail.querySelector('[data-note-edit-cancel]').addEventListener('click', () => { state.noteEditing = false; renderNoteDetail(note); }); detail.querySelector('textarea').addEventListener('input', (event) => { $('#note-inline-count').textContent = event.currentTarget.value.length; }); detail.querySelector('form').addEventListener('submit', (event) => saveInlineNote(event, note)); return; }
  detail.innerHTML = `<a class="note-article-link" href="#reader/${encodeURIComponent(note.item_id)}" data-note-open="${note.id}"><span><i class="ti ti-file-text"></i>关联文章</span><strong>${escapeHtml(note.article.title)}</strong><i class="ti ti-arrow-right"></i></a><header class="notes-detail-header"><div><p class="eyebrow">笔记标题${note.article.is_archived ? ' · 已归档文章' : ''}</p><h2>${escapeHtml(noteTitle(note))}</h2></div><div class="notes-detail-actions"><button class="icon-button" type="button" data-note-edit="${note.id}" aria-label="编辑笔记" title="编辑笔记"><i class="ti ti-pencil"></i></button><button class="icon-button danger-icon" type="button" data-note-delete="${note.id}" aria-label="删除笔记" title="删除笔记"><i class="ti ti-trash"></i></button></div></header><section class="note-detail-section"><p class="side-label">笔记内容</p><p class="note-detail-content">${escapeHtml(note.note)}</p></section><section class="note-detail-quote"><p class="side-label">高亮段落</p><blockquote>${escapeHtml(note.text)}</blockquote></section><dl class="note-detail-meta"><div><dt>来源</dt><dd><a href="${escapeHtml(note.article.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(domain(note.article.url))} <i class="ti ti-external-link"></i></a></dd></div><div><dt>创建时间</dt><dd>${readerDate(note.created_at)}</dd></div><div><dt>最后编辑</dt><dd>${readerDate(note.updated_at)}</dd></div></dl>`;
  detail.querySelector('[data-note-edit]')?.addEventListener('click', () => { state.noteEditing = true; renderNoteDetail(note); });
  detail.querySelector('[data-note-delete]')?.addEventListener('click', () => { pendingNoteDelete = note.id; dialog('note-delete-dialog'); });
  detail.querySelector('[data-note-open]')?.addEventListener('click', (event) => { event.preventDefault(); openNoteArticle(note, true); });
}
function updateNoteControls() {
  $$('[data-note-article-status]').forEach((button) => button.classList.toggle('active', button.dataset.noteArticleStatus === state.noteArticleStatus));
}
function renderArticleSuggestions() {
  const results = $('#notes-article-results'); const input = $('#notes-article-search');
  results.innerHTML = state.noteArticleSuggestions.map((article) => `<button type="button" role="option" data-note-article-choice="${escapeHtml(article.title)}">${escapeHtml(article.title)}</button>`).join('');
  results.classList.toggle('hidden', !input.matches(':focus') || !state.noteArticleSuggestions.length);
  $$('[data-note-article-choice]').forEach((button) => button.addEventListener('click', () => { state.noteArticleQuery = button.dataset.noteArticleChoice; input.value = state.noteArticleQuery; results.classList.add('hidden'); loadNotes(); }));
}
async function loadNotes({ restore = false } = {}) {
  const params = new URLSearchParams({ pageSize: '100' }); if (state.noteArticleQuery) params.set('articleQ', state.noteArticleQuery); if (state.noteQuery) params.set('noteQ', state.noteQuery); if (state.noteField !== 'note') params.set('noteField', state.noteField); if (state.noteArticleStatus !== 'all') params.set('articleStatus', state.noteArticleStatus);
  try { const result = await request(`/api/notes?${params}`); state.notes = result.notes; state.noteTotal = result.total; state.noteArticleSuggestions = [...new Map(result.notes.map((note) => [note.article.id, { ...note.article, count: 0 }])).values()]; result.notes.forEach((note) => { const item = state.noteArticleSuggestions.find((article) => article.id === note.article.id); if (item) item.count += 1; }); if (!restore) syncNotesRoute({ replace: true }); renderNotes(); renderArticleSuggestions(); if (restore && state.notesScroll) requestAnimationFrame(() => $('#notes-list').scrollTop = state.notesScroll); } catch (error) { toast(error.message); }
}
async function saveInlineNote(event, note) { event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('[type="submit"]'); const data = new FormData(form); button.disabled = true; $('#note-inline-message').textContent = ''; try { const updated = await request(`/api/notes/${note.id}`, { method: 'PATCH', body: JSON.stringify({ title: data.get('title'), note: data.get('note'), updatedAt: note.updated_at }) }); state.notes = state.notes.map((entry) => entry.id === updated.id ? updated : entry).sort((a, b) => b.updated_at.localeCompare(a.updated_at)); state.selectedNoteId = updated.id; state.noteEditing = false; renderNotes(); syncNotesRoute({ replace: true }); await loadContent(); toast('笔记已保存'); } catch (error) { $('#note-inline-message').textContent = error.message.includes('其他位置更新') ? `${error.message} 请重新加载后再编辑。` : error.message; } finally { button.disabled = false; } }
async function openNoteArticle(note, locate) {
  state.notesScroll = $('#notes-list').scrollTop; state.workspace = 'notes'; $('#notes-page').classList.add('hidden'); $('.layout').classList.remove('hidden'); $('#application').classList.remove('notes-active'); await openItem(note.item_id, { restoreProgress: !locate });
  if (locate) requestAnimationFrame(() => requestAnimationFrame(() => jumpToHighlight(note.id)));
}
async function loadContent() {
  const params = new URLSearchParams(); if (state.status !== 'all') params.set('status', state.status); if (state.tag) params.set('tag', state.tag); if (state.folderId) params.set('folderId', state.folderId); if (state.search) params.set('q', state.search);
  try { const [items, dashboard] = await Promise.all([request(`/api/items?${params}`), request('/api/dashboard')]); state.items = items.items; state.dashboard = dashboard; renderDashboard(); renderItems(); updateHeading(); } catch (error) { toast(error.message); }
}
async function copyReaderCode(value) {
  if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return; }
  const textarea = document.createElement('textarea');
  textarea.value = value; textarea.setAttribute('readonly', ''); textarea.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
  document.body.append(textarea); textarea.select();
  const copied = document.execCommand('copy'); textarea.remove();
  if (!copied) throw new Error('复制失败');
}
function addReaderCodeCopyButtons(content) {
  content.querySelectorAll('pre').forEach((pre) => {
    const code = pre.querySelector('code'); const value = (code || pre).textContent || '';
    if (!value.trim()) return;
    const wrapper = document.createElement('div'); wrapper.className = 'reader-code-block';
    pre.replaceWith(wrapper); wrapper.append(pre);
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'reader-code-copy'; button.setAttribute('aria-label', '复制代码'); button.title = '复制代码';
    button.innerHTML = '<i class="ti ti-copy"></i><span>复制</span>';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await copyReaderCode(value); button.innerHTML = '<i class="ti ti-check"></i><span>已复制</span>'; }
      catch { button.innerHTML = '<i class="ti ti-x"></i><span>复制失败</span>'; }
      window.setTimeout(() => { button.innerHTML = '<i class="ti ti-copy"></i><span>复制</span>'; button.disabled = false; }, 1600);
    });
    wrapper.append(button);
  });
}
function renderReaderContent(snapshot, error) {
  const content = $('#reader-content'); const template = document.createElement('template');
  template.innerHTML = snapshot || `<p>${escapeHtml(error || '此网页未能生成阅读快照。')}</p>`;
  template.content.querySelectorAll('script,style,iframe,object,embed,form,input,button,svg,canvas,video,audio,source,picture').forEach((element) => element.remove());
  template.content.querySelectorAll('*').forEach((element) => {
    [...element.attributes].forEach((attribute) => { if (/^(on|style$)/i.test(attribute.name)) element.removeAttribute(attribute.name); });
    if (element.matches('img')) {
      try { const url = new URL(element.getAttribute('src'), window.location.href); if (!['http:', 'https:'].includes(url.protocol) || url.pathname.startsWith('/archive/') === false && url.origin === window.location.origin) throw new Error(); element.src = url.href; element.loading = 'lazy'; element.decoding = 'async'; element.referrerPolicy = 'no-referrer'; element.tabIndex = 0; element.setAttribute('role', 'button'); element.setAttribute('aria-label', `${element.alt || '正文图片'}，点击放大查看`); } catch { element.remove(); }
    }
    if (element.matches('a')) { element.target = '_blank'; element.rel = 'noopener noreferrer'; }
  });
  content.replaceChildren(template.content);
  addReaderCodeCopyButtons(content);
  content.querySelectorAll('img').forEach((image) => { const openImage = () => openImagePreview(image.currentSrc || image.src, image.alt || '正文图片'); image.addEventListener('click', openImage); image.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openImage(); } }); });
  applyArticleHighlights();
  const headings = [...content.querySelectorAll('h2,h3')]; const toc = $('#reader-toc-list');
  headings.forEach((heading, index) => { heading.id ||= `reader-section-${index + 1}`; });
  toc.innerHTML = headings.length ? headings.map((heading) => { const label = heading.textContent.trim() || '未命名段落'; return `<button type="button" class="${heading.tagName === 'H3' ? 'sub' : ''}" data-reader-section="${heading.id}" title="${escapeHtml(label)}">${escapeHtml(label)}</button>`; }).join('') : '<span class="reader-toc-empty">正文没有可用目录</span>';
  $$('[data-reader-section]').forEach((button) => button.addEventListener('click', () => document.getElementById(button.dataset.readerSection)?.scrollIntoView({ behavior: 'smooth', block: 'start' })));
}
async function savePreferences(changes) {
  try { await request('/api/preferences', { method: 'PATCH', body: JSON.stringify(changes) }); }
  catch (error) { toast(`偏好设置未保存：${error.message}`); }
}
function saveReaderDisplay() { void savePreferences({ readerDisplay }); }
function applyReaderDisplay() {
  document.documentElement.style.setProperty('--reader-font-size', `${readerDisplay.font}px`);
  document.body.dataset.readerFontFamily = readerDisplay.family; document.body.dataset.readerWidth = readerDisplay.width; document.body.dataset.readerLine = readerDisplay.line; document.body.dataset.readerMode = readerDisplay.mode;
  $('#reader-font-family').value = readerDisplay.family;
  $$('[data-reader-font]').forEach((button) => button.classList.toggle('active', Number(button.dataset.readerFont) === readerDisplay.font));
  $$('[data-reader-width]').forEach((button) => button.classList.toggle('active', button.dataset.readerWidth === readerDisplay.width));
  $$('[data-reader-line]').forEach((button) => button.classList.toggle('active', button.dataset.readerLine === readerDisplay.line));
  const minimal = readerDisplay.mode === 'minimal'; $('#reader-mode-button').classList.toggle('active', minimal); $('#reader-mode-button').setAttribute('aria-pressed', String(minimal)); $('#reader-mode-button').setAttribute('aria-label', minimal ? '切换经典模式' : '切换极简模式'); $('#reader-mode-button').setAttribute('title', minimal ? '切换经典模式' : '切换极简模式');
}
function closeReaderAppearance() { $('#reader-appearance').classList.add('hidden'); $('#reader-appearance-button').setAttribute('aria-expanded', 'false'); }
function renderPropertyTags() {
  $('#reader-tag-chips').innerHTML = propertyTags.map((tag) => `<span>#${escapeHtml(tag)}<button type="button" data-remove-property-tag="${escapeHtml(tag)}" aria-label="移除标签 ${escapeHtml(tag)}"><i class="ti ti-x"></i></button></span>`).join('');
  $$('[data-remove-property-tag]').forEach((button) => button.addEventListener('click', () => { propertyTags = propertyTags.filter((tag) => tag !== button.dataset.removePropertyTag); renderPropertyTags(); }));
  $('#reader-tag-options').innerHTML = propertyTagOptions.length ? propertyTagOptions.map((tag) => `<button type="button" class="${propertyTags.includes(tag) ? 'active' : ''}" data-toggle-property-tag="${escapeHtml(tag)}" aria-pressed="${propertyTags.includes(tag)}">#${escapeHtml(tag)}</button>`).join('') : '<span>还没有可选的已有标签</span>';
  $$('[data-toggle-property-tag]').forEach((button) => button.addEventListener('click', () => { const tag = button.dataset.togglePropertyTag; propertyTags = propertyTags.includes(tag) ? propertyTags.filter((entry) => entry !== tag) : [...propertyTags, tag]; renderPropertyTags(); }));
}
function addPropertyTag(input) {
  const raw = String(input || '').trim();
  if (!raw) return true;
  if (!/^#[^#\s]{1,40}$/.test(raw)) { $('#reader-property-message').textContent = '标签格式为 #标签名，输入后按回车生成。'; return false; }
  const tag = raw.slice(1);
  if (!propertyTags.includes(tag)) propertyTags.push(tag);
  $('#reader-property-message').textContent = ''; renderPropertyTags(); return true;
}
async function openReaderPropertyEditor() {
  if (!state.reader) return;
  const form = $('#reader-property-form'); const folders = state.dashboard?.folders || [];
  form.elements.title.value = state.reader.title || ''; form.elements.summary.value = state.reader.summary || ''; propertyTags = state.reader.tags.map((tag) => tag.name);
  const folderValue = $('#reader-edit-folder-value'); const selectedFolder = state.reader.folders[0]?.id || ''; folderValue.value = selectedFolder;
  setSelectOptions($('#reader-edit-folders'), folderValue, [{ value: '', label: '不归入收藏夹' }, ...folders.map((folder) => ({ value: folder.id, label: folder.name }))]);
  try { const result = await request('/api/tags?pageSize=100'); propertyTagOptions = result.tags.map((tag) => tag.name); }
  catch { propertyTagOptions = state.dashboard?.tags.map((tag) => tag.name) || []; }
  propertyTagOptions = [...new Set([...propertyTags, ...propertyTagOptions])].sort((left, right) => left.localeCompare(right, 'zh-CN'));
  $('#reader-new-folder').value = ''; $('#reader-tag-input').value = ''; $('#reader-property-message').textContent = ''; renderPropertyTags(); dialog('reader-property-dialog');
}
function syncReaderState(item) {
  const readButton = $('#reader-read'); readButton.classList.toggle('active', item.is_read); readButton.setAttribute('aria-label', item.is_read ? '标记为未读' : '标记为已读'); readButton.setAttribute('title', item.is_read ? '标记为未读' : '标记为已读'); readButton.innerHTML = '<i class="ti ti-check"></i>';
  $('#reader-favorite').classList.toggle('active', item.is_favorite); $('#reader-archive').classList.toggle('active', item.is_archived);
  const pdfButton = $('#reader-pdf'); const hasArchive = Boolean(item.archive_path); pdfButton.disabled = !hasArchive; pdfButton.setAttribute('aria-label', hasArchive ? '生成并查看 PDF' : 'HTML 档案尚未生成'); pdfButton.setAttribute('title', hasArchive ? '生成并查看 PDF' : 'HTML 档案尚未生成');
}
function propertyPills(entries, emptyLabel, prefix = '') { return entries.length ? entries.map((entry) => `<span>${prefix}${escapeHtml(entry.name)}</span>`).join('') : `<em>${emptyLabel}</em>`; }
function renderReaderProperties(item) {
  const text = $('#reader-content').textContent.replace(/\s+/g, ' ').trim(); const chinese = (text.match(/[\u3400-\u9fff]/g) || []).length; const words = text.replace(/[\u3400-\u9fff]/g, ' ').trim().split(/\s+/).filter(Boolean).length; const count = chinese + words;
  const archivePath = item.archive_path || '未生成 HTML 档案';
  $('#reader-prop-title').textContent = item.title || '未命名文章'; $('#reader-prop-summary').textContent = item.summary || '未添加描述'; $('#reader-prop-source').href = item.url; $('#reader-prop-source').textContent = domain(item.url); $('#reader-prop-archive-path').textContent = archivePath; $('#reader-prop-archive-path').title = archivePath; $('#reader-prop-saved').textContent = readerDate(item.created_at); $('#reader-prop-words').textContent = `${count.toLocaleString('zh-CN')} 字`; $('#reader-prop-duration').textContent = `约 ${Math.max(1, Math.ceil(count / 400))} 分钟`;
  $('#reader-prop-folders').innerHTML = propertyPills(item.folders, '未归入收藏夹'); $('#reader-prop-tags').innerHTML = propertyPills(item.tags, '未添加标签', '#'); syncReaderState(item);
}
function readerIdFromLocation() {
  const match = window.location.hash.match(/^#reader\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : '';
}
function setReaderRoute(itemId) {
  const route = `#reader/${encodeURIComponent(itemId)}`;
  if (window.location.hash !== route) history.pushState(null, '', route);
}
function clearReaderRoute() {
  if (readerIdFromLocation()) history.pushState(null, '', `${window.location.pathname}${window.location.search}`);
}
function readerProgress() {
  const maximum = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  return maximum ? Math.min(1, Math.max(0, window.scrollY / maximum)) : 0;
}
async function saveReaderProgress(force = false) {
  if (!state.reader) return;
  const itemId = state.reader.id;
  const progress = readerProgress();
  if (!force && Math.abs(progress - Number(state.reader.reading_progress || 0)) < 0.01) return;
  state.reader.reading_progress = progress;
  try {
    const updated = await request(`/api/items/${itemId}`, { method: 'PATCH', body: JSON.stringify({ reading_progress: progress }) });
    if (state.reader?.id === itemId) state.reader = updated;
  } catch { /* A later scroll or pagehide will retry the position. */ }
}
function scheduleReaderProgressSave() {
  clearTimeout(progressSaveTimer);
  progressSaveTimer = setTimeout(() => saveReaderProgress(), 700);
}
function restoreReaderProgress(progress) {
  const saved = Math.min(1, Math.max(0, Number(progress) || 0));
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const maximum = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    window.scrollTo({ top: Math.round(maximum * saved), behavior: 'instant' });
    updateReaderProgress();
  }));
}
function updateReaderProgress() {
  if (!state.reader) return;
  const percent = Math.round(readerProgress() * 100);
  $('#reader-progress').style.setProperty('--reader-progress', String(percent / 100)); $('#reader-percent').textContent = `${percent}%`;
  scheduleReaderProgressSave();
  if (percent >= 100 && !state.reader.is_read && !state.reader.is_archived) void updateItem({ is_read: true }, false).catch(() => {});
}
function closeReaderPage({ updateRoute = true } = {}) {
  saveReaderProgress(true); clearTimeout(progressSaveTimer); if (updateRoute) clearReaderRoute();
  $('#reader-page').classList.add('hidden'); $('#application').classList.remove('reader-active'); state.reader = null; document.title = '纸笺 · 稍后阅读';
  if (state.workspace === 'notes') { openNotesWorkspace({ restore: true }); syncNotesRoute({ replace: true }); } else if (state.workspace === 'manage') { openManage(); } else if (state.workspace === 'timeline') { openTimeline(); } else if (state.workspace === 'mp') { openMpSubscriptions(); } else loadContent();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
async function openItem(itemId, { updateRoute = true, restoreProgress = true } = {}) {
  try {
    if (state.reader && state.reader.id !== itemId) await saveReaderProgress(true);
    state.reader = await request(`/api/items/${itemId}`); const item = state.reader;
    void request(`/api/items/${itemId}`, { method: 'PATCH', body: JSON.stringify({ last_opened: true }) }).then((updated) => { if (state.reader?.id === itemId) state.reader = updated; }).catch(() => {});
    $('#reader-bar-title').textContent = item.title; document.title = `${item.title} · 纸笺`;
    renderReaderContent(item.fetch_status === 'ready' ? item.html_snapshot : '', item.fetch_error); renderReaderProperties(item); applyReaderDisplay();
    const notice = $('#fetch-notice'); const fetchNotice = item.fetch_status === 'failed' ? `快照抓取失败：${item.fetch_error}。原文链接仍已保存。` : item.fetch_warning || ''; notice.classList.toggle('hidden', !fetchNotice); $('#fetch-notice-text').textContent = fetchNotice;
    renderHighlights(); $('#reader-page').classList.remove('hidden'); $('#application').classList.add('reader-active'); if (updateRoute) setReaderRoute(item.id); window.scrollTo({ top: 0, behavior: 'instant' });
    if (restoreProgress) restoreReaderProgress(item.reading_progress); else updateReaderProgress();
  } catch (error) { toast(error.message); }
}
function articleTextNodes() {
  const walker = document.createTreeWalker($('#reader-content'), NodeFilter.SHOW_TEXT, { acceptNode: (node) => node.nodeValue.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode); return nodes;
}
function highlightSelectionOffsets(range) {
  const root = $('#reader-content');
  const before = document.createRange(); before.selectNodeContents(root); before.setEnd(range.startContainer, range.startOffset);
  return { start: before.toString().length, end: before.toString().length + range.toString().length };
}
function applyArticleHighlights() {
  const articleText = articleTextNodes().map((node) => node.nodeValue).join('');
  const highlights = [...(state.reader?.highlights || [])].map((highlight) => {
    if (Number.isInteger(highlight.start_offset) && Number.isInteger(highlight.end_offset)) return highlight;
    // Highlights created before offsets existed can still be restored when their quote appears once.
    const start = articleText.indexOf(highlight.text);
    return start >= 0 && articleText.indexOf(highlight.text, start + 1) < 0 ? { ...highlight, start_offset: start, end_offset: start + highlight.text.length } : null;
  }).filter(Boolean).sort((a, b) => b.start_offset - a.start_offset);
  for (const highlight of highlights) {
    const nodes = articleTextNodes(); let cursor = 0;
    for (const node of nodes) {
      const start = cursor; const end = cursor + node.nodeValue.length; cursor = end;
      if (end <= highlight.start_offset || start >= highlight.end_offset || node.parentElement?.closest('mark.reader-highlight')) continue;
      const from = Math.max(0, highlight.start_offset - start); const to = Math.min(node.nodeValue.length, highlight.end_offset - start);
      const selected = node.splitText(from); const after = selected.splitText(to - from); const mark = document.createElement('mark');
      mark.className = 'reader-highlight'; mark.dataset.highlightId = highlight.id; selected.replaceWith(mark); mark.append(selected);
      if (!after.nodeValue) after.remove();
    }
  }
}
function closeHighlightPopover() {
  pendingHighlightSelection = null; const popover = $('#highlight-popover'); popover.classList.add('hidden'); popover.reset();
}
function openHighlightPopover(range) {
  const text = range.toString().replace(/\s+/g, ' ').trim();
  if (!text || text.length > 4000 || !$('#reader-content').contains(range.commonAncestorContainer)) return;
  if ($$('#reader-content .reader-highlight').some((mark) => range.intersectsNode(mark))) return toast('这段文字已经有笔记了。');
  const offsets = highlightSelectionOffsets(range); const rect = range.getBoundingClientRect(); const popover = $('#highlight-popover'); const edge = 14; const gap = 12;
  pendingHighlightSelection = { text, ...offsets }; popover.classList.remove('hidden');
  const width = Math.min(390, window.innerWidth - edge * 2); popover.style.width = `${width}px`; popover.style.left = `${Math.min(Math.max(edge, rect.left), window.innerWidth - width - edge)}px`; popover.style.maxHeight = `${Math.max(160, window.innerHeight - edge * 2)}px`;
  const height = popover.getBoundingClientRect().height; const below = window.innerHeight - rect.bottom - gap; const above = rect.top - gap;
  if (below >= height || below >= above) popover.style.top = `${Math.max(edge, Math.min(rect.bottom + gap, window.innerHeight - Math.min(height, window.innerHeight - edge * 2) - edge))}px`;
  else popover.style.top = `${Math.max(edge, rect.top - gap - height)}px`;
}
function jumpToHighlight(highlightId) {
  const target = $(`.reader-highlight[data-highlight-id="${highlightId}"]`);
  if (!target) return toast('该高亮无法在当前正文中定位。');
  target.scrollIntoView({ behavior: 'smooth', block: 'center' }); target.classList.add('is-target'); setTimeout(() => target.classList.remove('is-target'), 1400);
}
function showHighlightDetail(highlightId) {
  const highlight = state.reader?.highlights.find((entry) => entry.id === highlightId); if (!highlight) return;
  $('#highlight-detail-note').textContent = highlight.note_title ? `${highlight.note_title}\n\n${highlight.note}` : (highlight.note || '未命名笔记。'); $('#highlight-detail-text').textContent = highlight.text; dialog('highlight-detail-dialog');
}
function renderHighlights() {
  const highlights = state.reader?.highlights || [];
  $('#highlight-list').innerHTML = highlights.map((highlight) => `<article class="highlight-entry"><button class="highlight-entry-main" type="button" data-show-highlight="${highlight.id}" aria-label="查看笔记详情：${escapeHtml((highlight.note_title || highlight.note || highlight.text).slice(0, 60))}"><p class="highlight-note">${escapeHtml(highlight.note_title || '未命名笔记')}</p><span class="highlight-quote">${escapeHtml(highlight.note || highlight.text)}</span></button><div class="highlight-meta"><span>高亮于 ${readerDate(highlight.created_at)}</span><span class="highlight-actions"><button class="highlight-jump" type="button" data-jump-highlight="${highlight.id}" aria-label="跳转至文中高亮" title="跳转至文中高亮"><i class="ti ti-location"></i></button><button class="delete-link" type="button" data-delete-highlight="${highlight.id}" aria-label="删除笔记" title="删除笔记"><i class="ti ti-trash"></i></button></span></div></article>`).join('') || '<p class="setting-copy">尚未添加高亮笔记。</p>';
  $$('[data-jump-highlight]').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); jumpToHighlight(button.dataset.jumpHighlight); }));
  $$('[data-show-highlight]').forEach((entry) => entry.addEventListener('click', () => showHighlightDetail(entry.dataset.showHighlight)));
  $$('[data-delete-highlight]').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); pendingHighlightDelete = button.dataset.deleteHighlight; dialog('highlight-delete-dialog'); }));
}
async function updateItem(changes, refresh = true) {
  const updated = await request(`/api/items/${state.reader.id}`, { method: 'PATCH', body: JSON.stringify(changes) }); state.reader = updated;
  syncReaderState(updated);
  if (refresh) await loadContent();
}
async function loadTokens() { const tokens = await request('/api/tokens'); $('#token-list').innerHTML = tokens.length ? tokens.map((token) => `<div class="token-record"><div class="token-record-main"><strong>${escapeHtml(token.name)}</strong><code class="token-plaintext">${escapeHtml(token.token)}</code><span>${token.scopes.join(', ')} · 创建于 ${shortDate(token.created_at)}${token.last_used_at ? ` · 最近使用 ${shortDate(token.last_used_at)}` : ''}</span></div><button class="secondary" type="button" data-revoke-token="${token.id}">撤销</button></div>`).join('') : '<div class="token-empty"><span>还没有 Token</span></div>';
  $$('[data-revoke-token]').forEach((button) => button.addEventListener('click', () => { pendingTokenRevoke = button.dataset.revokeToken; dialog('token-revoke-dialog'); })); }
async function loadUsers() { if (state.user.role !== 'admin') return; const users = await request('/api/users'); $('#user-list').innerHTML = users.map((user) => `<div class="user-record"><div class="user-record-main"><strong>${escapeHtml(user.username)}</strong><span>${user.role === 'admin' ? '管理员' : '普通用户'} · ${shortDate(user.created_at)}</span></div>${user.id === state.user.id ? '<span class="user-record-spacer" aria-hidden="true"></span>' : `<button class="secondary" type="button" data-delete-user="${user.id}">删除</button>`}</div>`).join(''); $$('[data-delete-user]').forEach((button) => button.addEventListener('click', async () => { button.disabled = true; try { await request(`/api/users/${button.dataset.deleteUser}`, { method: 'DELETE' }); toast('用户及其全部数据已删除。'); await loadUsers(); } catch (error) { toast(error.message); button.disabled = false; } })); }
function setSettingsPage(sectionId) { $$('[data-settings-section]').forEach((button) => { const active = button.dataset.settingsSection === sectionId; button.classList.toggle('active', active); button.setAttribute('aria-current', active ? 'page' : 'false'); }); $$('.settings-panel').forEach((panel) => panel.classList.toggle('hidden', panel.id !== sectionId)); }
async function refreshWorkspaceAfterSettings() {
  // Refresh the homepage data on every return; restore the active workspace as well so data changed in another tab or via the extension is immediately visible.
  const refreshes = [loadContent()];
  if (state.workspace === 'notes') refreshes.push(loadNotes({ restore: true }));
  if (state.workspace === 'manage') refreshes.push(loadManage());
  if (state.workspace === 'timeline') { state.timelinePage = 1; refreshes.push(loadTimeline()); }
  if (state.workspace === 'mp') refreshes.push(loadMpWorkspace());
  await Promise.all(refreshes);
}
async function closeSettingsPage({ refresh = true } = {}) { $('#settings-page').classList.add('hidden'); $('#application').classList.remove('settings-active'); window.scrollTo({ top: 0, behavior: 'instant' }); if (refresh) await refreshWorkspaceAfterSettings(); }
async function openSettings(sectionId = 'settings-account') {
  $('#account-line').textContent = `${state.user.username} · ${state.user.role === 'admin' ? '管理员' : '普通用户'}`;
  const isAdmin = state.user.role === 'admin'; $('#admin-nav').classList.toggle('hidden', !isAdmin); $$('[data-admin-only]').forEach((element) => element.classList.toggle('hidden', !isAdmin)); $('#data-non-admin-copy').classList.toggle('hidden', isAdmin); $('#new-token').classList.add('hidden');
  await loadTokens(); await loadUsers(); setSettingsPage(sectionId); $('#settings-page').classList.remove('hidden'); $('#application').classList.add('settings-active'); window.scrollTo({ top: 0, behavior: 'instant' });
}
function downloadExport() { window.location.assign('/api/export'); }
async function initialize() {
  document.body.dataset.authState = 'checking';
  try { state.user = await request('/api/auth/me'); const preferences = await request('/api/preferences'); readerDisplay = { ...readerDisplayDefaults, ...(preferences.readerDisplay || {}) }; setHomeView(preferences.homepageView || savedHomeView()); applyReaderDisplay(); $('#login-screen').classList.add('hidden'); $('#application').classList.remove('hidden'); const routeParams = new URLSearchParams(window.location.search); const routeStatus = routeParams.get('status'); state.status = articleStatuses.has(routeStatus) ? routeStatus : 'all'; if (window.location.hash === '#notes') { state.noteArticleQuery = routeParams.get('articleQ') || ''; state.noteQuery = routeParams.get('noteQ') || ''; state.noteField = routeParams.get('noteField') === 'highlight' ? 'highlight' : 'note'; state.noteArticleStatus = routeParams.get('noteArticleStatus') || 'all'; state.selectedNoteId = routeParams.get('note') || ''; openNotesWorkspace({ restore: true }); } else { $$('.nav-link').forEach((button) => button.classList.toggle('active', button.dataset.status === state.status)); await loadContent(); } const readerId = readerIdFromLocation(); if (readerId) await openItem(readerId, { updateRoute: false, restoreProgress: true }); document.body.dataset.authState = 'authenticated'; } catch { $('#application').classList.add('hidden'); $('#login-screen').classList.remove('hidden'); document.body.dataset.authState = 'unauthenticated'; }
}

if (docsSettingsTarget === 'token') {
  const openTokenSettingsFromDocs = () => {
    if (state.user) return openSettings('settings-token');
    if (document.body.dataset.authState === 'checking') window.setTimeout(openTokenSettingsFromDocs, 50);
  };
  window.setTimeout(openTokenSettingsFromDocs, 0);
}

function passwordVisibilityIcon(visible) { return visible ? '<i class="ti ti-eye-off" aria-hidden="true"></i>' : '<i class="ti ti-eye" aria-hidden="true"></i>'; }
function addPasswordVisibilityControl(input) { const wrapper = document.createElement('span'); wrapper.className = 'password-input'; input.before(wrapper); wrapper.append(input); const button = document.createElement('button'); button.type = 'button'; button.className = 'password-visibility-toggle'; button.setAttribute('aria-label', '查看密码'); button.setAttribute('title', '查看密码'); button.innerHTML = passwordVisibilityIcon(false); button.addEventListener('click', () => { const visible = input.type === 'text'; input.type = visible ? 'password' : 'text'; button.setAttribute('aria-label', visible ? '查看密码' : '隐藏密码'); button.setAttribute('title', visible ? '查看密码' : '隐藏密码'); button.innerHTML = passwordVisibilityIcon(!visible); }); wrapper.append(button); }
$$('input[type="password"]').forEach(addPasswordVisibilityControl);
$$('form').forEach((form) => { form.noValidate = true; });
setSelectOptions($('#user-role-control'), $('#user-role-value'), [{ value: 'user', label: '普通用户' }, { value: 'admin', label: '管理员' }]);
$('#login-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { state.user = await request('/api/auth/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) }); $('#login-message').textContent = ''; await initialize(); } catch (error) { $('#login-message').textContent = error.message; } });
async function saveUrl(url, { tags = [], folderId = '' } = {}) { const result = await request('/api/items', { method: 'POST', body: JSON.stringify({ url, tags, folderId }) }); toast(result.item.fetch_status === 'failed' ? '链接已保存，但抓取失败，可从原文打开。' : '已保存并生成阅读快照。'); await loadContent(); await openItem(result.item.id); return result; }
$$('[data-open-save]').forEach((button) => button.addEventListener('click', () => dialog('save-dialog')));
$('#quick-save-form').addEventListener('submit', async (event) => { event.preventDefault(); const formElement = event.currentTarget; const submit = formElement.querySelector('[type="submit"]'); const url = new FormData(formElement).get('url'); submit.disabled = true; try { await saveUrl(url); formElement.reset(); } catch (error) { toast(error.message); } finally { submit.disabled = false; } });
$('#save-form').addEventListener('submit', async (event) => { event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement); const submit = formElement.querySelector('[type="submit"]'); submit.disabled = true; $('#save-message').textContent = '正在抓取网页并生成安全快照…'; try { await saveUrl(form.get('url'), { tags: String(form.get('tags')).split(/[，,]/).map((tag) => tag.trim()).filter(Boolean), folderId: form.get('folderId') }); closeDialog('save-dialog'); formElement.reset(); } catch (error) { $('#save-message').textContent = error.message; } finally { submit.disabled = false; } });
$('#service-import-file-button').addEventListener('click', () => $('#service-import-file').click());
$('#service-import-file').addEventListener('change', (event) => { const file = event.currentTarget.files?.[0]; $('#service-import-file-name').textContent = file ? `${file.name}（${Math.ceil(file.size / 1024)} KB）` : '尚未选择文件'; $('#data-transfer-message').textContent = ''; });
$('#service-import-form').addEventListener('submit', async (event) => { event.preventDefault(); const message = $('#data-transfer-message'); const file = $('#service-import-file').files?.[0]; if (!file) { message.textContent = '请先选择完整服务备份 JSON 文件。'; return; } if (!$('#service-import-confirm').checked) { message.textContent = '请勾选确认项后再导入。'; return; } if (file.size > 50_000_000) { message.textContent = '导入文件不能超过 50MB。'; return; } let backup; try { backup = JSON.parse(await file.text()); } catch { message.textContent = '文件不是有效的 JSON 备份。'; return; } const submit = event.currentTarget.querySelector('[type="submit"]'); submit.disabled = true; message.textContent = '正在恢复全部服务数据，请不要关闭此页面…'; try { const result = await request('/api/import', { method: 'POST', body: JSON.stringify({ ...backup, confirmReplace: true }) }); message.textContent = result.message || '完整服务数据已恢复，请重新登录。'; toast('完整服务数据已恢复。'); window.setTimeout(() => window.location.reload(), 1300); } catch (error) { message.textContent = error.message; } finally { submit.disabled = false; } });
$('#settings-export-json-button').addEventListener('click', downloadExport); $('#new-folder-button').addEventListener('click', () => dialog('folder-dialog')); $('#notes-new-folder').addEventListener('click', () => dialog('folder-dialog')); $('#folder-form').elements.name.maxLength = 9; $('#reader-new-folder').maxLength = 9; $('#folder-form').addEventListener('submit', async (event) => { event.preventDefault(); const formElement = event.currentTarget; try { await request('/api/folders', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(formElement))) }); closeDialog('folder-dialog'); formElement.reset(); toast('收藏夹已创建。'); await loadContent(); } catch (error) { $('#folder-message').textContent = error.message; } });
$('#api-docs-button').addEventListener('click', () => window.location.assign('/api-docs.html')); $('#settings-button').addEventListener('click', () => openSettings()); $$('[data-open-settings]').forEach((button) => button.addEventListener('click', () => openSettings(button.dataset.openSettings || 'settings-account'))); $('#wx-button')?.addEventListener('click', () => { openMpSubscriptions(); history.pushState({ workspace: 'mp' }, '', workspaceRoute('mp')); });
$('#settings-back').addEventListener('click', async (event) => { const button = event.currentTarget; button.disabled = true; try { await closeSettingsPage(); } finally { button.disabled = false; } });
$$('[data-settings-section]').forEach((button) => button.addEventListener('click', () => setSettingsPage(button.dataset.settingsSection)));
let articleSearchTimer;
$('#article-search').addEventListener('input', (event) => { const query = event.currentTarget.value.trim(); clearTimeout(articleSearchTimer); articleSearchTimer = setTimeout(() => { state.search = query; loadContent(); }, 220); });
$$('[data-close]').forEach((button) => button.addEventListener('click', () => closeDialog(button.dataset.close)));
document.addEventListener('pointerdown', (event) => { $$('.select-control.is-open').forEach((control) => { if (!control.contains(event.target)) closeSelect(control); }); const popover = $('#highlight-popover'); if (!popover.classList.contains('hidden') && !popover.contains(event.target) && !$('#reader-content').contains(event.target)) closeHighlightPopover(); });
 $$('.nav-link').forEach((button) => button.addEventListener('click', () => { if (button.dataset.workspace === 'notes') { openNotesWorkspace(); syncNotesRoute(); return; } if (button.dataset.workspace === 'timeline') { openTimeline(); return; } if (button.dataset.workspace === 'mp') { openMpSubscriptions(); history.pushState({ workspace: 'mp' }, '', workspaceRoute('mp')); return; } state.status = button.dataset.status; state.tag = ''; state.folderId = ''; setWorkspaceVisibility('articles'); setHomeView(state.homeView); clearNotesRoute(); syncArticlesRoute(); $$('.nav-link').forEach((item) => item.classList.toggle('active', item === button)); loadContent(); }));
 $('#notes-article-search').addEventListener('input', (event) => { state.noteArticleQuery = event.currentTarget.value; clearTimeout(noteSearchTimer); noteSearchTimer = setTimeout(() => loadNotes(), 300); });
 $('#notes-article-search').addEventListener('focus', renderArticleSuggestions);
 $('#notes-article-search').addEventListener('blur', () => setTimeout(() => $('#notes-article-results').classList.add('hidden'), 150));
 $('#notes-note-search').addEventListener('input', (event) => { state.noteQuery = event.currentTarget.value; clearTimeout(noteSearchTimer); noteSearchTimer = setTimeout(() => loadNotes(), 300); });
 $('#notes-note-field').addEventListener('change', (event) => { state.noteField = event.currentTarget.value; loadNotes(); });
 $$('[data-note-article-status]').forEach((button) => button.addEventListener('click', () => { state.noteArticleStatus = button.dataset.noteArticleStatus; loadNotes(); }));
 $('#notes-clear-search').addEventListener('click', () => { state.noteArticleQuery = ''; state.noteQuery = ''; state.noteField = 'note'; state.noteArticleStatus = 'all'; $('#notes-article-search').value = ''; $('#notes-note-search').value = ''; $('#notes-note-field').value = 'note'; loadNotes(); });
 $('#notes-list').addEventListener('keydown', (event) => { const rows = $$('[data-note-select]'); const index = rows.indexOf(document.activeElement); if (index < 0) return; if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const next = rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]; next?.focus(); next?.click(); } if (event.key === 'Enter') openNoteArticle(state.notes.find((note) => note.id === state.selectedNoteId), true); if (event.key.toLowerCase() === 'e') { state.noteEditing = true; renderNotes(); } if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); pendingNoteDelete = state.selectedNoteId; dialog('note-delete-dialog'); } });
 $('#note-delete-confirm').addEventListener('click', async () => { const noteId = pendingNoteDelete; if (!noteId) return; const button = $('#note-delete-confirm'); button.disabled = true; try { await request(`/api/notes/${noteId}`, { method: 'DELETE' }); const removedIndex = state.notes.findIndex((note) => note.id === noteId); state.notes = state.notes.filter((note) => note.id !== noteId); state.noteTotal = Math.max(0, state.noteTotal - 1); state.selectedNoteId = state.notes[removedIndex]?.id || state.notes[removedIndex - 1]?.id || ''; pendingNoteDelete = null; closeDialog('note-delete-dialog'); renderNotes(); syncNotesRoute({ replace: true }); await loadContent(); toast('笔记已删除。'); } catch (error) { toast(error.message); } finally { button.disabled = false; } });
$$('.home-view-toggle [data-view]').forEach((button) => button.addEventListener('click', () => {
  setHomeView(button.dataset.view);
  try { localStorage.setItem(homeViewStorageKey, state.homeView); } catch { /* Storage can be unavailable in private contexts. */ }
  void savePreferences({ homepageView: state.homeView });
}));
$('#reader-back').addEventListener('click', closeReaderPage);
$('#reader-refetch').addEventListener('click', async (event) => { const button = event.currentTarget; if (!state.reader) return; button.disabled = true; try { const item = await request(`/api/items/${state.reader.id}/refetch`, { method: 'POST' }); state.reader = item; await loadContent(); await openItem(item.id); toast(item.fetch_status !== 'ready' ? '重新抓取失败，请查看提示或打开原文。' : item.fetch_warning ? '原网站未返回新正文，已继续使用本地快照。' : '网页已重新抓取。'); } catch (error) { toast(error.message); } finally { button.disabled = false; } });
$('#reader-read').addEventListener('click', () => updateItem({ is_read: !state.reader.is_read })); $('#reader-favorite').addEventListener('click', () => updateItem({ is_favorite: !state.reader.is_favorite })); $('#reader-archive').addEventListener('click', () => updateItem({ is_archived: !state.reader.is_archived })); $('#reader-pdf').addEventListener('click', async (event) => { if (!state.reader?.archive_path) return; const button = event.currentTarget; const target = window.open('', '_blank'); button.disabled = true; try { const item = await request(`/api/items/${state.reader.id}/pdf`, { method: 'POST' }); state.reader = item; syncReaderState(item); const filename = item.pdf_path.split(/[\\/]/).pop(); const revision = encodeURIComponent(item.updated_at || item.created_at || Date.now()); const href = `/archive/${encodeURIComponent(item.id)}/${encodeURIComponent(filename)}?v=${revision}`; if (target) { target.opener = null; target.location.replace(href); } else window.open(href, '_blank', 'noopener'); } catch (error) { target?.close(); toast(error.message); } finally { syncReaderState(state.reader); } });
$('#reader-mode-button').addEventListener('click', () => { readerDisplay.mode = readerDisplay.mode === 'classic' ? 'minimal' : 'classic'; saveReaderDisplay(); applyReaderDisplay(); });
$('#reader-appearance-button').addEventListener('click', () => { const panel = $('#reader-appearance'); const willOpen = panel.classList.contains('hidden'); panel.classList.toggle('hidden', !willOpen); $('#reader-appearance-button').setAttribute('aria-expanded', String(willOpen)); });
$('#reader-appearance-close').addEventListener('click', closeReaderAppearance);
$$('[data-reader-font]').forEach((button) => button.addEventListener('click', () => { readerDisplay.font = Number(button.dataset.readerFont); saveReaderDisplay(); applyReaderDisplay(); }));
$('#reader-font-family').addEventListener('change', (event) => { readerDisplay.family = event.currentTarget.value; saveReaderDisplay(); applyReaderDisplay(); });
$$('[data-reader-width]').forEach((button) => button.addEventListener('click', () => { readerDisplay.width = button.dataset.readerWidth; saveReaderDisplay(); applyReaderDisplay(); }));
$$('[data-reader-line]').forEach((button) => button.addEventListener('click', () => { readerDisplay.line = button.dataset.readerLine; saveReaderDisplay(); applyReaderDisplay(); }));
$('#reader-property-edit-toggle').addEventListener('click', openReaderPropertyEditor);
$('#reader-new-folder-button').addEventListener('click', async () => { const input = $('#reader-new-folder'); const name = input.value.trim(); if (!name) return; const button = $('#reader-new-folder-button'); button.disabled = true; try { const folder = await request('/api/folders', { method: 'POST', body: JSON.stringify({ name }) }); const folders = [...(state.dashboard?.folders || []).filter((entry) => entry.id !== folder.id), folder]; state.dashboard = { ...state.dashboard, folders }; const value = $('#reader-edit-folder-value'); setSelectOptions($('#reader-edit-folders'), value, [{ value: '', label: '不归入收藏夹' }, ...folders.map((entry) => ({ value: entry.id, label: entry.name }))]); value.value = folder.id; const control = $('#reader-edit-folders'); control.querySelector('.select-trigger span').textContent = folder.name; control.querySelectorAll('[role="option"]').forEach((option) => option.setAttribute('aria-selected', String(option.dataset.value === folder.id))); input.value = ''; toast('收藏夹已创建，保存后将关联到当前文章。'); } catch (error) { $('#reader-property-message').textContent = error.message; } finally { button.disabled = false; } });
function fitImagePreview({ center = false } = {}) {
  const image = $('#image-preview'); const stage = $('.image-preview-stage');
  if (!image.naturalWidth || !image.naturalHeight || !stage.clientWidth || !stage.clientHeight) return;
  const fit = Math.min(1, (stage.clientWidth * .94) / image.naturalWidth, (stage.clientHeight * .94) / image.naturalHeight);
  image.style.width = `${Math.max(1, Math.round(image.naturalWidth * fit * imagePreviewScale))}px`;
  image.style.height = 'auto';
  requestAnimationFrame(() => {
    stage.classList.toggle('is-draggable', stage.scrollWidth > stage.clientWidth || stage.scrollHeight > stage.clientHeight);
    if (center) stage.scrollTo({ left: Math.max(0, (stage.scrollWidth - stage.clientWidth) / 2), top: Math.max(0, (stage.scrollHeight - stage.clientHeight) / 2) });
  });
}
function setImagePreviewScale(scale, options) { imagePreviewScale = Math.max(0.5, Math.min(3, scale)); fitImagePreview(options); $('#image-zoom-out').disabled = imagePreviewScale <= 0.5; $('#image-zoom-in').disabled = imagePreviewScale >= 3; }
function openImagePreview(source, alt) {
  const image = $('#image-preview'); const stage = $('.image-preview-stage');
  imagePreviewScale = 1; image.style.width = ''; image.style.height = ''; image.alt = alt; stage.scrollTo({ left: 0, top: 0 }); dialog('image-preview-dialog');
  const resetPreview = () => setImagePreviewScale(1, { center: true });
  image.onload = resetPreview; image.src = source;
  if (image.complete) requestAnimationFrame(resetPreview);
}
$('#image-zoom-out').addEventListener('click', () => setImagePreviewScale(imagePreviewScale - 0.25));
$('#image-zoom-in').addEventListener('click', () => setImagePreviewScale(imagePreviewScale + 0.25));
$('.image-preview-stage').addEventListener('wheel', (event) => { if (!$('#image-preview-dialog').open) return; event.preventDefault(); setImagePreviewScale(imagePreviewScale + (event.deltaY < 0 ? .1 : -.1)); }, { passive: false });
let imagePreviewPan = null;
const imagePreviewStage = $('.image-preview-stage');
function endImagePreviewPan(event) {
  if (!imagePreviewPan) return;
  if (event?.pointerId != null && imagePreviewPan.pointerId !== event.pointerId) return;
  imagePreviewStage.releasePointerCapture?.(imagePreviewPan.pointerId);
  imagePreviewStage.classList.remove('is-panning');
  imagePreviewPan = null;
}
imagePreviewStage.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('.image-preview-controls') || !imagePreviewStage.classList.contains('is-draggable')) return;
  imagePreviewPan = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: imagePreviewStage.scrollLeft, top: imagePreviewStage.scrollTop };
  imagePreviewStage.setPointerCapture(event.pointerId);
  imagePreviewStage.classList.add('is-panning');
  event.preventDefault();
});
imagePreviewStage.addEventListener('pointermove', (event) => {
  if (!imagePreviewPan || imagePreviewPan.pointerId !== event.pointerId) return;
  imagePreviewStage.scrollLeft = imagePreviewPan.left - (event.clientX - imagePreviewPan.x);
  imagePreviewStage.scrollTop = imagePreviewPan.top - (event.clientY - imagePreviewPan.y);
  event.preventDefault();
});
imagePreviewStage.addEventListener('pointerup', endImagePreviewPan);
imagePreviewStage.addEventListener('pointercancel', endImagePreviewPan);
$('#image-preview-dialog').addEventListener('close', () => endImagePreviewPan());
window.addEventListener('resize', () => { if ($('#image-preview-dialog').open) fitImagePreview(); });
$('#reader-tag-input').addEventListener('keydown', (event) => { if (event.key !== 'Enter') return; event.preventDefault(); if (addPropertyTag(event.currentTarget.value)) event.currentTarget.value = ''; });
$('#reader-property-form').addEventListener('submit', async (event) => { event.preventDefault(); if (!state.reader) return; const pending = $('#reader-tag-input').value.trim(); if (pending && !addPropertyTag(pending)) return; const form = new FormData(event.currentTarget); const folderId = $('#reader-edit-folder-value').value; const folderIds = folderId ? [folderId] : []; const button = event.currentTarget.querySelector('[type="submit"]'); button.disabled = true; try { const item = await request(`/api/items/${state.reader.id}`, { method: 'PATCH', body: JSON.stringify({ title: form.get('title'), summary: form.get('summary'), tags: propertyTags, folderIds }) }); state.reader = item; $('#reader-bar-title').textContent = item.title; document.title = `${item.title} · 纸笺`; renderReaderProperties(item); closeDialog('reader-property-dialog'); await loadContent(); toast('文章属性已保存。'); } catch (error) { $('#reader-property-message').textContent = error.message; } finally { button.disabled = false; } });
$('#home-delete-confirm').addEventListener('click', async () => { const itemId = pendingItemDelete; if (!itemId) return; const button = $('#home-delete-confirm'); button.disabled = true; try { await request(`/api/items/${itemId}`, { method: 'DELETE' }); closeDialog('home-delete-dialog'); pendingItemDelete = null; await loadContent(); toast('文章已删除。'); } catch (error) { toast(error.message); } finally { button.disabled = false; } });
$('#new-highlight-button').addEventListener('click', () => toast('请在正文中选择一段文字后添加笔记。'));
$('#reader-content').addEventListener('mouseup', () => { setTimeout(() => { const selection = window.getSelection(); if (!selection?.rangeCount || selection.isCollapsed) return; openHighlightPopover(selection.getRangeAt(0)); }, 0); });
$('#reader-content').addEventListener('keyup', (event) => { if (!event.shiftKey && !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return; const selection = window.getSelection(); if (selection?.rangeCount && !selection.isCollapsed) openHighlightPopover(selection.getRangeAt(0)); });
$('#reader-content').addEventListener('click', (event) => { const mark = event.target.closest('.reader-highlight'); if (mark) showHighlightDetail(mark.dataset.highlightId); });
$('#highlight-cancel').addEventListener('click', closeHighlightPopover);
$('#highlight-popover').addEventListener('submit', async (event) => { event.preventDefault(); if (!pendingHighlightSelection || !state.reader) return; const form = new FormData(event.currentTarget); try { const highlight = await request(`/api/items/${state.reader.id}/highlights`, { method: 'POST', body: JSON.stringify({ text: pendingHighlightSelection.text, title: form.get('title'), note: form.get('note'), start_offset: pendingHighlightSelection.start, end_offset: pendingHighlightSelection.end }) }); state.reader.highlights.unshift(highlight); closeHighlightPopover(); renderReaderContent(state.reader.html_snapshot); renderHighlights(); await loadContent(); toast('高亮笔记已保存。'); } catch (error) { toast(error.message); } });
$('#highlight-delete-confirm').addEventListener('click', async () => { const highlightId = pendingHighlightDelete; if (!highlightId || !state.reader) return; const button = $('#highlight-delete-confirm'); button.disabled = true; try { await request(`/api/items/${state.reader.id}/highlights/${highlightId}`, { method: 'DELETE' }); state.reader.highlights = state.reader.highlights.filter((highlight) => highlight.id !== highlightId); renderReaderContent(state.reader.html_snapshot); renderHighlights(); await loadContent(); closeDialog('highlight-delete-dialog'); pendingHighlightDelete = null; toast('高亮笔记已删除。'); } catch (error) { toast(error.message); } finally { button.disabled = false; } });
$('#token-revoke-confirm').addEventListener('click', async () => { const tokenId = pendingTokenRevoke; if (!tokenId) return; const button = $('#token-revoke-confirm'); button.disabled = true; try { await request(`/api/tokens/${tokenId}`, { method: 'DELETE' }); closeDialog('token-revoke-dialog'); pendingTokenRevoke = null; toast('Token 已删除。'); await loadTokens(); } catch (error) { toast(error.message); } finally { button.disabled = false; } });
$('#password-form').addEventListener('submit', async (event) => { event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement); if (form.get('newPassword') !== form.get('confirmPassword')) { $('#password-message').textContent = '两次输入的新密码不一致。'; return; } try { await request('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword: form.get('currentPassword'), newPassword: form.get('newPassword') }) }); formElement.reset(); $('#password-message').textContent = ''; toast('密码已更新。'); } catch (error) { $('#password-message').textContent = error.message; } });
$('#settings-logout').addEventListener('click', async () => { try { await request('/api/auth/logout', { method: 'POST' }); await closeSettingsPage({ refresh: false }); $('#reader-page').classList.add('hidden'); $('#application').classList.add('hidden'); $('#login-screen').classList.remove('hidden'); $('#login-form').reset(); state.user = null; document.body.dataset.authState = 'unauthenticated'; toast('已退出登录。'); } catch (error) { toast(error.message); } });
$('#token-form').addEventListener('submit', async (event) => { event.preventDefault(); const formElement = event.currentTarget; try { const result = await request('/api/tokens', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(formElement))) }); const value = $('#new-token'); value.textContent = `新建 Token：${result.token}`; value.classList.remove('hidden'); formElement.reset(); await loadTokens(); } catch (error) { toast(error.message); } });
$('#user-form').addEventListener('submit', async (event) => { event.preventDefault(); const formElement = event.currentTarget; try { await request('/api/users', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(formElement))) }); formElement.reset(); toast('用户已创建。'); loadUsers(); } catch (error) { toast(error.message); } });
function mpDate(value) { return value ? readerDate(value) : '尚未同步'; }
const mpSyncOptions = [{ value: '60', label: '每 1 小时' }, { value: '240', label: '每 4 小时' }, { value: '360', label: '每 6 小时' }, { value: '480', label: '每 8 小时' }, { value: '720', label: '每 12 小时' }, { value: '1440', label: '每 24 小时' }];
function mpRunLabel(run) { if (run.status === 'running') return '同步中'; if (run.status === 'success') return '完成'; return '失败'; }
function mpArticlePageNumbers(page, totalPages) {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);
  if (page <= 4) return [1, 2, 3, 4, 5, 'ellipsis', totalPages];
  if (page >= totalPages - 3) return [1, 'ellipsis', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  return [1, 'ellipsis', page - 1, page, page + 1, 'ellipsis', totalPages];
}
function renderMpWorkspace() {
  const data = state.mp; if (!data) return;
  const auth = data.auth || { configured: false, status: 'missing' }; const active = auth.configured && auth.status === 'active';
  const expired = auth.configured && auth.status === 'expired';
  const authTitle = active ? '微信读书已授权' : expired ? '微信读书授权已失效' : '尚未授权微信读书';
  const authCopy = active ? `自动保活已开启，最近校验：${mpDate(auth.verifiedAt)}` : expired ? '授权失败或已过期，请重新扫码授权后继续同步。' : '完成扫码授权后，才能读取微信读书书架并同步文章。';
  $('#mp-auth-card').innerHTML = `<div class="mp-auth-state"><span class="mp-status-dot ${active ? 'is-active' : ''}"></span><div><strong>${authTitle}</strong><p>${authCopy}</p></div></div><div class="mp-auth-actions"><button class="secondary" type="button" data-mp-authorize>${active ? '重新授权' : expired ? '重新授权' : '扫码授权'}</button></div>`;
  $('#mp-auth-settings-copy').textContent = active ? `已授权${auth.accountName ? `：${auth.accountName}` : ''}；自动保活已开启，最近校验于 ${mpDate(auth.verifiedAt)}。` : expired ? '微信读书授权失败或已过期，请重新扫码授权。' : '当前没有可用的微信读书授权，请扫码授权后再添加或同步公众号。';
  $('#mp-authorize-button').innerHTML = `<i class="ti ti-qrcode"></i>${active || expired ? '重新授权' : '扫码授权'}`; $('#mp-revoke-button').classList.toggle('hidden', !auth.configured);
  const syncSelect = $('#mp-refresh-select'); syncSelect.value = String(data.settings?.syncMinutes || 60); setSelectOptions($('#mp-refresh-control'), syncSelect, mpSyncOptions);
  const subscriptions = data.subscriptions || []; $('#mp-subscription-count').textContent = `${subscriptions.length} 个订阅`;
  $('#mp-subscription-list').innerHTML = subscriptions.length ? subscriptions.map((subscription) => `<article class="mp-subscription ${subscription.enabled ? '' : 'is-paused'}"><div class="mp-cover">${subscription.cover_url ? `<img src="${escapeHtml(mpMediaUrl(subscription.cover_url))}" alt="">` : '<i class="ti ti-brand-wechat"></i>'}</div><div class="mp-subscription-main"><div class="mp-subscription-title"><h3>${escapeHtml(subscription.name)}</h3><span>${subscription.enabled ? '同步中' : '已暂停'}</span></div><p>${escapeHtml(subscription.latest_title || '尚未发现文章')}</p><small>最近同步：${mpDate(subscription.last_sync_at)}${subscription.last_error ? ` · ${escapeHtml(subscription.last_error)}` : ''}</small></div><div class="mp-subscription-actions"><button class="icon-button" type="button" data-mp-copy-rss="${escapeHtml(subscription.rssPath)}" aria-label="复制 RSS 链接" title="复制 RSS 链接"><i class="ti ti-link"></i></button><button class="icon-button" type="button" data-mp-sync-sub="${subscription.id}" aria-label="立即同步" title="立即同步" ${active && subscription.enabled ? '' : 'disabled'}><i class="ti ti-refresh"></i></button><button class="icon-button" type="button" data-mp-toggle="${subscription.id}" aria-label="${subscription.enabled ? '暂停订阅' : '恢复订阅'}" title="${subscription.enabled ? '暂停订阅' : '恢复订阅'}"><i class="ti ti-${subscription.enabled ? 'player-pause' : 'player-play'}"></i></button><button class="icon-button danger-icon" type="button" data-mp-delete="${subscription.id}" aria-label="移除订阅" title="移除订阅"><i class="ti ti-trash"></i></button></div></article>`).join('') : `<section class="manage-empty"><div><i class="ti ti-brand-wechat"></i><p>${active ? '还没有公众号订阅。请从微信读书书架添加。' : '请先完成微信读书扫码授权。'}</p>${active ? '<button class="primary" type="button" data-mp-add>从书架添加公众号</button>' : '<button class="primary" type="button" data-mp-authorize>扫码授权</button>'}</div></section>`;
  const articles = data.articles || []; const articlePagination = data.articlePagination || { page: 1, pageSize: mpArticlePageSize, total: articles.length, totalPages: 1 };
  mpArticlePage = articlePagination.page; mpArticlePageSize = articlePagination.pageSize;
  $('#mp-article-count').textContent = `${articlePagination.total} 篇文章`;
  const pageSizeSelect = $('#mp-article-page-size'); pageSizeSelect.value = String(mpArticlePageSize); setSelectOptions($('#mp-article-page-size-control'), pageSizeSelect, mpArticlePageSizeOptions);
  $('#mp-article-list').innerHTML = articles.length ? articles.map((article) => `<a class="mp-article" href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer"><span class="mp-article-cover">${article.mp_article_image_url ? `<img src="${escapeHtml(mpMediaUrl(article.mp_article_image_url))}" alt="">` : '<i class="ti ti-brand-wechat"></i>'}</span><span class="mp-article-main"><small>${escapeHtml(article.mp_name || article.source_label || '微信公众号')}</small><strong>${escapeHtml(article.title)}</strong><em>${escapeHtml(article.summary || article.fetch_warning || (article.content_status === 'failed' ? '正文暂未获取成功，请通过原文链接查看。' : '点击直接查看原文。'))}</em></span><time>${mpDate(article.created_at)}</time><i class="ti ti-external-link" aria-hidden="true"></i></a>`).join('') : `<section class="manage-empty mp-article-empty"><div><i class="ti ti-news"></i><p>同步后的公众号文章会只在这里展示。</p></div></section>`;
  const pagination = $('#mp-article-pagination');
  pagination.classList.toggle('hidden', articlePagination.total === 0);
  $('#mp-article-page-info').textContent = `第 ${articlePagination.page} / ${articlePagination.totalPages} 页`;
  const pageNumbers = mpArticlePageNumbers(articlePagination.page, articlePagination.totalPages).map((entry) => entry === 'ellipsis'
    ? '<span class="mp-page-ellipsis" aria-hidden="true">…</span>'
    : `<button class="mp-page-number ${entry === articlePagination.page ? 'is-current' : ''}" type="button" data-mp-article-page="${entry}" ${entry === articlePagination.page ? 'aria-current="page"' : ''}>${entry}</button>`).join('');
  $('#mp-article-page-controls').innerHTML = articlePagination.totalPages > 1 ? `<button class="mp-page-nav" type="button" data-mp-article-page="${articlePagination.page - 1}" aria-label="上一页" title="上一页" ${articlePagination.page <= 1 ? 'disabled' : ''}><i class="ti ti-chevron-left"></i></button>${pageNumbers}<button class="mp-page-nav" type="button" data-mp-article-page="${articlePagination.page + 1}" aria-label="下一页" title="下一页" ${articlePagination.page >= articlePagination.totalPages ? 'disabled' : ''}><i class="ti ti-chevron-right"></i></button>` : '';
  const runs = data.runs || []; $('#mp-runs-list').innerHTML = runs.length ? runs.map((run) => `<div class="mp-run"><span>${mpRunLabel(run)}</span><time>${mpDate(run.started_at)}</time><p>发现 ${run.discovered_count} 篇，入库 ${run.imported_count} 篇${run.error_message ? ` · ${escapeHtml(run.error_message)}` : ''}</p></div>`).join('') : '<p class="setting-copy">尚无同步记录。</p>';
  $('#mp-sync-button').disabled = !active || !subscriptions.some((subscription) => subscription.enabled) || data.syncing; $('#mp-add-button').disabled = !active;
  bindMpActions();
}
function bindMpActions() {
  $$('[data-mp-authorize]').forEach((button) => button.addEventListener('click', startMpAuthorization)); $$('[data-mp-add]').forEach((button) => button.addEventListener('click', openMpAdd));
  $$('[data-mp-copy-rss]').forEach((button) => button.addEventListener('click', async () => { try { await copyReaderCode(new URL(button.dataset.mpCopyRss, window.location.origin).href); toast('RSS 链接已复制，仅包含最近 7 天文章。'); } catch (error) { toast(error.message); } }));
  $$('[data-mp-sync-sub]').forEach((button) => button.addEventListener('click', async () => { button.disabled = true; try { await request(`/api/mp/subscriptions/${button.dataset.mpSyncSub}/sync`, { method: 'POST' }); toast('公众号同步完成。'); await loadMpWorkspace(); } catch (error) { toast(error.message); button.disabled = false; } }));
  $$('[data-mp-toggle]').forEach((button) => button.addEventListener('click', async () => { const subscription = state.mp?.subscriptions.find((entry) => entry.id === button.dataset.mpToggle); if (!subscription) return; try { await request(`/api/mp/subscriptions/${subscription.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !subscription.enabled }) }); await loadMpWorkspace(); } catch (error) { toast(error.message); } }));
  $$('[data-mp-delete]').forEach((button) => button.addEventListener('click', async () => { if (!window.confirm('移除后已同步文章会保留在本页的公众号文章板块中，确定移除该订阅？')) return; try { await request(`/api/mp/subscriptions/${button.dataset.mpDelete}`, { method: 'DELETE' }); await loadMpWorkspace(); } catch (error) { toast(error.message); } }));
  $$('[data-mp-article-page]').forEach((button) => button.addEventListener('click', () => { mpArticlePage = Number(button.dataset.mpArticlePage); void loadMpWorkspace(); }));
}
async function loadMpWorkspace() { try { state.mp = await request(`/api/mp/subscriptions?articlePage=${mpArticlePage}&articlePageSize=${mpArticlePageSize}`); renderMpWorkspace(); } catch (error) { toast(error.message); } }
function openMpSubscriptions() { setWorkspaceVisibility('mp'); loadMpWorkspace(); window.scrollTo({ top: 0, behavior: 'instant' }); }
function stopMpQrPolling() { if (mpQrTimer) window.clearInterval(mpQrTimer); mpQrTimer = null; mpQrPolling = false; }
async function pollMpAuthorization() { if (mpQrPolling) return; mpQrPolling = true; try { const result = await request('/api/mp/auth/qr/status'); $('#mp-qr-message').textContent = result.message || ''; if (result.state === 'success') { stopMpQrPolling(); $('#mp-qr-stage').innerHTML = '<i class="ti ti-circle-check"></i><strong>微信读书授权成功</strong>'; window.setTimeout(() => closeDialog('mp-auth-dialog'), 800); await loadMpWorkspace(); await loadContent(); } else if (['expired', 'otp'].includes(result.state)) stopMpQrPolling(); } catch (error) { stopMpQrPolling(); $('#mp-qr-message').textContent = error.message; } finally { mpQrPolling = false; } }
async function startMpAuthorization() { stopMpQrPolling(); $('#mp-qr-stage').innerHTML = '<i class="ti ti-loader-2 ti-spin"></i><p>正在获取二维码…</p>'; $('#mp-qr-message').textContent = ''; dialog('mp-auth-dialog'); try { const result = await request('/api/mp/auth/qr', { method: 'POST' }); $('#mp-qr-stage').innerHTML = `<img src="${result.image}" alt="微信读书授权二维码"><p>请用微信扫一扫并确认登录微信读书网页版。</p>`; mpQrTimer = window.setInterval(() => { void pollMpAuthorization(); }, 2500); void pollMpAuthorization(); } catch (error) { $('#mp-qr-stage').innerHTML = '<i class="ti ti-alert-circle"></i>'; $('#mp-qr-message').textContent = error.message; } }
function updateMpAddSubmit() {
  $('#mp-add-submit').disabled = selectedMpBookIds.size === 0;
  $('#mp-add-submit').textContent = selectedMpBookIds.size ? `添加所选公众号（${selectedMpBookIds.size}）` : '添加所选公众号';
}
function renderMpBookshelf(books) {
  const subscribed = new Set((state.mp?.subscriptions || []).map((subscription) => subscription.book_id));
  $('#mp-bookshelf-list').innerHTML = books.length ? books.map((book) => {
    const exists = subscribed.has(book.bookId);
    return `<label class="mp-bookshelf-row ${exists ? 'is-subscribed' : ''}"><span class="mp-check-control"><input type="checkbox" value="${escapeHtml(book.bookId)}" ${exists ? 'checked disabled aria-label="已订阅"' : ''}><span aria-hidden="true"><i class="ti ti-check"></i></span></span><span class="mp-bookshelf-cover">${book.coverUrl ? `<img src="${escapeHtml(book.coverUrl)}" alt="">` : '<i class="ti ti-brand-wechat"></i>'}</span><span class="mp-bookshelf-meta"><strong>${escapeHtml(book.name)}</strong>${exists ? '<small>已订阅</small>' : ''}</span></label>`;
  }).join('') : '<p class="setting-copy">微信读书书架中还没有公众号。请先在微信读书中关注公众号后再回来添加。</p>';
  $$('#mp-bookshelf-list input[type="checkbox"]:not(:disabled)').forEach((input) => input.addEventListener('change', () => { if (input.checked) selectedMpBookIds.add(input.value); else selectedMpBookIds.delete(input.value); updateMpAddSubmit(); }));
  updateMpAddSubmit();
}
async function openMpAdd() { if (!state.mp?.auth?.configured || state.mp.auth.status !== 'active') { dialog('mp-settings-dialog'); toast('请先完成微信读书扫码授权。'); return; } selectedMpBookIds = new Set(); $('#mp-add-message').textContent = ''; $('#mp-add-submit').disabled = true; $('#mp-add-submit').textContent = '添加所选公众号'; $('#mp-bookshelf-list').innerHTML = '<p class="setting-copy">正在读取微信读书书架…</p>'; dialog('mp-add-dialog'); try { const result = await request('/api/mp/bookshelf'); renderMpBookshelf(result.books); } catch (error) { $('#mp-bookshelf-list').innerHTML = `<p class="form-message">${escapeHtml(error.message)}</p>`; } }
$('#mp-open-settings').addEventListener('click', () => dialog('mp-settings-dialog'));
$('#mp-close-settings').addEventListener('click', () => closeDialog('mp-settings-dialog'));
$('#mp-authorize-button').addEventListener('click', startMpAuthorization);
$('#mp-auth-cancel').addEventListener('click', () => closeDialog('mp-auth-dialog'));
$('#mp-auth-dialog').addEventListener('close', stopMpQrPolling);
$('#mp-add-button').addEventListener('click', openMpAdd);
$('#mp-sync-button').addEventListener('click', async () => { const button = $('#mp-sync-button'); button.disabled = true; try { await request('/api/mp/sync', { method: 'POST' }); toast('公众号同步完成。'); await loadMpWorkspace(); } catch (error) { toast(error.message); button.disabled = false; } });
$('#mp-revoke-button').addEventListener('click', async () => { if (!window.confirm('移除授权会停止所有公众号同步，已同步文章和订阅源会保留。确定继续？')) return; try { await request('/api/mp/auth', { method: 'DELETE' }); await loadMpWorkspace(); await loadContent(); toast('微信读书授权已移除。'); } catch (error) { toast(error.message); } });
$('#mp-refresh-select').addEventListener('change', async (event) => { try { await request('/api/mp/settings', { method: 'PATCH', body: JSON.stringify({ syncMinutes: Number(event.currentTarget.value) }) }); toast('订阅同步频率已保存。'); await loadMpWorkspace(); } catch (error) { toast(error.message); } });
$('#mp-article-page-size').addEventListener('change', (event) => { mpArticlePageSize = Number(event.currentTarget.value); mpArticlePage = 1; localStorage.setItem('paperleaf-mp-article-page-size', String(mpArticlePageSize)); void loadMpWorkspace(); });
$('#mp-add-form').addEventListener('submit', async (event) => { event.preventDefault(); const message = $('#mp-add-message'); const button = $('#mp-add-submit'); if (!selectedMpBookIds.size) return; button.disabled = true; message.textContent = ''; try { const result = await request('/api/mp/subscriptions', { method: 'POST', body: JSON.stringify({ bookIds: [...selectedMpBookIds] }) }); closeDialog('mp-add-dialog'); await loadMpWorkspace(); toast(result.failed?.length ? `已添加 ${result.subscriptions.length} 个公众号，${result.failed.length} 个未添加成功。` : `已添加 ${result.subscriptions.length} 个公众号。`); } catch (error) { message.textContent = error.message; button.disabled = false; } });
function workspaceRoute(name, params = new URLSearchParams()) { return `${window.location.pathname}${params.size ? `?${params}` : ''}#${name}`; }
function setWorkspaceVisibility(name) {
  state.workspace = name;
  $('.layout').classList.toggle('hidden', name !== 'articles');
  $('#notes-page').classList.toggle('hidden', name !== 'notes');
  $('#manage-page').classList.toggle('hidden', name !== 'manage');
  $('#timeline-page').classList.toggle('hidden', name !== 'timeline');
  $('#mp-page').classList.toggle('hidden', name !== 'mp');
  $$('.nav-link').forEach((button) => button.classList.toggle('active', button.dataset.workspace === name || (name === 'articles' && button.dataset.status === state.status)));
}
function timelineTitle(eventType) { return ({ item_created: '收录', highlight_created: '创建笔记', note_updated: '更新笔记', item_archived: '归档', item_unarchived: '取消归档', item_favorited: '收藏', item_unfavorited: '取消收藏' })[eventType] || eventType; }
function timelineDay(value) { const date = new Date(value); return `${date.getFullYear()}年${String(date.getMonth() + 1).padStart(2, '0')}月${String(date.getDate()).padStart(2, '0')}日`; }
function timelineTime(value) { const date = new Date(value); return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; }
function syncTimelineRoute({ replace = false } = {}) { if (state.workspace !== 'timeline') return; const params = new URLSearchParams(); if (state.timelineView !== 'cards') params.set('view', state.timelineView); if (state.timelineType !== 'all') params.set('types', state.timelineType); if (state.timelineArticleStatus !== 'all') params.set('articleStatus', state.timelineArticleStatus); history[replace ? 'replaceState' : 'pushState']({ workspace: 'timeline' }, '', workspaceRoute('timeline', params)); }
function syncTimelineControls() {
  $$('.timeline-toolbar [data-timeline-type]').forEach((button) => { const active = button.dataset.timelineType === state.timelineType; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
  $$('.timeline-toolbar [data-timeline-status]').forEach((button) => { const active = button.dataset.timelineStatus === state.timelineArticleStatus; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
}
function timelineEntry(entry) { const noteEvent = ['highlight_created', 'note_updated'].includes(entry.event_type); const missingArticle = !entry.article; const missingNote = noteEvent && !entry.highlight; const placeholder = missingArticle ? '已删除文章' : missingNote ? '已删除笔记' : ''; return { ...entry, noteEvent, placeholder, title: entry.article?.title || '已删除文章', noteTitle: entry.highlight?.title || '已删除笔记' }; }
function timelineArticleDescription(entry) {
  const source = entry.article?.url ? domain(entry.article.url) : '已删除文章';
  return ({ item_created: `从 ${source} 保存链接，自动存为 HTML 档案。`, item_favorited: '文章已加入收藏，可在收藏夹中查看。', item_unfavorited: '文章已取消收藏，阅读记录与笔记保持不变。', item_archived: '阅读完成，已归档至阅读档案。', item_unarchived: '已从阅读档案恢复至未归档文章。' })[entry.event_type] || '';
}
function timelineCardDetail(entry) { return entry.noteEvent ? '' : timelineArticleDescription(entry); }
async function openTimelineNote(noteId) { try { const note = await request(`/api/notes/${noteId}`); state.noteArticleQuery = ''; state.noteQuery = ''; state.noteField = 'note'; state.noteArticleStatus = 'all'; state.selectedNoteId = note.id; openNotesWorkspace(); state.notes = [note]; state.noteTotal = 1; renderNotes(); syncNotesRoute({ replace: true }); await loadNotes(); } catch (error) { toast(error.message); } }
function bindTimelineActions() { $$('[data-timeline-open]').forEach((button) => button.addEventListener('click', () => openItem(button.dataset.timelineOpen))); $$('[data-timeline-note]').forEach((button) => button.addEventListener('click', () => openTimelineNote(button.dataset.timelineNote))); }
function renderTimeline() {
  const groups = new Map(); state.timelineItems.map(timelineEntry).forEach((entry) => { const day = timelineDay(entry.occurred_at); if (!groups.has(day)) groups.set(day, []); groups.get(day).push(entry); });
  const dates = [...groups.entries()]; const cards = dates.map(([day, entries]) => `<article class="timeline-card"><header class="timeline-card-head"><i></i><h3>${day}</h3><span>${entries.length} 条</span></header><div class="timeline-card-body">${entries.map((entry) => { const detail = timelineCardDetail(entry); const title = entry.noteEvent ? `<button type="button" class="timeline-card-title" ${entry.highlight ? `data-timeline-note="${entry.highlight.id}"` : 'disabled'}>${escapeHtml(entry.noteTitle)}</button><span class="timeline-card-article">${escapeHtml(entry.title)}</span>` : `<button type="button" class="timeline-card-title" ${entry.article ? `data-timeline-open="${entry.article.id}"` : 'disabled'}>${escapeHtml(entry.title)}</button>`; return `<section class="timeline-card-event"><div class="timeline-card-event-meta"><time>${timelineTime(entry.occurred_at)}</time><b>${timelineTitle(entry.event_type)}</b></div>${title}${detail ? `<p>${escapeHtml(detail)}</p>` : ''}</section>`; }).join('')}</div><footer>PaperLeaf · ${day}</footer></article>`).join('');
  const journal = dates.map(([day, entries]) => `<section class="timeline-day"><header class="timeline-journal-date"><h2>${day}</h2><span>${entries.length} 条事件</span><i></i></header>${entries.map((entry) => { const title = entry.noteEvent ? `<button type="button" class="timeline-journal-title" ${entry.highlight ? `data-timeline-note="${entry.highlight.id}"` : 'disabled'}>${escapeHtml(entry.noteTitle)}</button>` : `<button type="button" class="timeline-journal-title" ${entry.article ? `data-timeline-open="${entry.article.id}"` : 'disabled'}>${escapeHtml(entry.title)}</button>`; const articleTitle = entry.noteEvent ? `<p class="timeline-journal-article">${escapeHtml(entry.title)}</p>` : ''; const description = timelineArticleDescription(entry); return `<article class="timeline-event"><time datetime="${escapeHtml(entry.occurred_at)}">${timelineTime(entry.occurred_at)}</time><div class="timeline-event-body"><h3><span class="timeline-journal-event-name">${escapeHtml(timelineTitle(entry.event_type))}</span>${title}</h3>${articleTitle}${description ? `<p class="timeline-journal-copy">${escapeHtml(description)}</p>` : ''}</div></article>`; }).join('')}</section>`).join('');
  $('#timeline-page').dataset.timelineView = state.timelineView; $('#timeline-view-label').textContent = state.timelineView === 'cards' ? '每日索引卡' : '阅读日记'; $('#timeline-stat-events').textContent = state.timelineStats.events; $('#timeline-stat-articles').textContent = state.timelineStats.articles; $('#timeline-stat-notes').textContent = state.timelineStats.notes; $('#timeline-stat-archived').textContent = state.timelineStats.archivedArticles;
  $('#timeline-list').innerHTML = dates.length ? `<section class="timeline-cards" aria-label="索引卡时间轴">${cards}</section><section class="timeline-journal" aria-label="日记本时间轴">${journal}</section>` : '<section class="manage-empty"><div><i class="ti ti-timeline"></i><p>还没有匹配的阅读轨迹。</p></div></section>';
  $('#timeline-more').classList.toggle('hidden', !state.timelineHasMore); bindTimelineActions();
}
async function loadTimeline({ append = false } = {}) { const params = new URLSearchParams({ page: String(state.timelinePage), pageSize: '12' }); if (state.timelineType !== 'all') params.set('types', state.timelineType); if (state.timelineArticleStatus !== 'all') params.set('articleStatus', state.timelineArticleStatus); try { const result = await request(`/api/timeline?${params}`); state.timelineItems = append ? [...state.timelineItems, ...result.items] : result.items; state.timelineTotal = result.total; state.timelineHasMore = Boolean(result.hasMore); state.timelineStats = result.stats || { events: result.total, articles: 0, notes: 0, archivedArticles: 0 }; renderTimeline(); syncTimelineRoute({ replace: true }); } catch (error) { toast(error.message); } }
function openTimeline() { setWorkspaceVisibility('timeline'); state.timelinePage = 1; state.timelineItems = []; state.timelineHasMore = false; loadTimeline(); window.scrollTo({ top: 0, behavior: 'instant' }); }
function syncManageRoute({ replace = false } = {}) { if (state.workspace !== 'manage') return; const params = new URLSearchParams(); if (state.manageMode !== 'folders') params.set('mode', state.manageMode); if (state.manageQuery) params.set('q', state.manageQuery); if (state.manageSelectedId) params.set('selected', state.manageSelectedId); history[replace ? 'replaceState' : 'pushState']({ workspace: 'manage' }, '', workspaceRoute('manage', params)); }
function renderManageItem(item, index, removable) { return `<article class="manage-item"><span class="manage-item-num">${String(index + 1).padStart(2, '0')}</span><button class="manage-item-main" type="button" data-manage-open-item="${item.id}"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(domain(item.url))} · ${shortDate(item.created_at)}${item.tags.length ? ` · ${item.tags.map((tag) => `#${escapeHtml(tag.name)}`).join(' ')}` : ''}</span></button><div class="manage-item-tools">${removable ? `<button class="icon-button" type="button" data-manage-remove="${item.id}" aria-label="移出收藏夹" title="移出收藏夹"><i class="ti ti-folder-minus"></i></button>` : ''}<a class="icon-button" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" aria-label="打开原文" title="打开原文"><i class="ti ti-external-link"></i></a></div></article>`; }
let pendingFolderRemoval = null;

function manageDetailMarkup(detail, isFolder) {
  if (!detail) return `<section class="manage-empty"><div><i class="ti ti-${isFolder ? 'folder' : 'tag'}"></i><p>选择一个${isFolder ? '收藏夹' : '标签'}后在这里查看文章。</p></div></section>`;
  const actions = isFolder
    ? `<div class="manage-detail-actions"><button class="icon-button" type="button" data-manage-rename aria-label="重命名收藏夹" title="重命名"><i class="ti ti-pencil"></i></button><button class="icon-button danger-icon" type="button" data-manage-delete aria-label="删除收藏夹" title="删除收藏夹"><i class="ti ti-trash"></i></button></div>`
    : `<div class="manage-detail-actions"><button class="icon-button" type="button" data-manage-rename aria-label="重命名标签" title="重命名"><i class="ti ti-pencil"></i></button></div>`;
  const items = detail.items.length
    ? detail.items.map((item, index) => renderManageItem(item, index, isFolder)).join('')
    : '<section class="manage-empty"><div><i class="ti ti-file-off"></i><p>这里还没有文章。</p></div></section>';
  return `<header class="manage-detail-head"><div class="manage-detail-title-row"><h2>${isFolder ? '' : '#'}${escapeHtml(detail.name)}</h2>${actions}</div><p class="count">${detail.total} 篇关联文章${isFolder ? ` · 创建于 ${shortDate(detail.created_at)}` : ''}</p></header><div>${items}</div>`;
}

function bindManageActions() {
  $$('[data-manage-select]').forEach((button) => button.addEventListener('click', () => {
    state.manageSelectedId = button.dataset.manageSelect;
    loadManageDetail();
  }));
  $$('[data-manage-open-item]').forEach((button) => button.addEventListener('click', () => openItem(button.dataset.manageOpenItem)));
  $$('[data-manage-remove]').forEach((button) => button.addEventListener('click', () => {
    const item = state.manageDetail?.items.find((entry) => entry.id === button.dataset.manageRemove);
    if (!item || !state.manageDetail) return;
    pendingFolderRemoval = { folderId: state.manageSelectedId, itemId: item.id };
    $('#manage-folder-remove-copy').textContent = `将“${item.title}”移出“${state.manageDetail.name}”。文章、笔记和标签都会保留。`;
    dialog('manage-folder-remove-dialog');
  }));
  $$('[data-manage-rename]').forEach((button) => button.addEventListener('click', () => openManageNameDialog('rename')));
  $('[data-manage-delete]')?.addEventListener('click', () => {
    $('#manage-folder-delete-copy').textContent = `删除“${state.manageDetail.name}”并将其中 ${state.manageDetail.total} 篇文章移出收藏夹。文章、笔记和标签都会保留。`;
    dialog('manage-folder-delete-dialog');
  });
}

function manageTagCards(tags) {
  return tags.length
    ? `<section class="manage-tag-index">${tags.map((entry) => { const count = Number(entry.count || 0); return `<button class="manage-tag-chip" type="button" data-manage-rename-tag="${entry.id}" aria-label="重命名标签 ${escapeHtml(entry.name)}，引用 ${count} 篇" title="重命名标签"><strong>${escapeHtml(entry.name)}</strong><b aria-label="引用 ${count} 篇">${count}</b></button>`; }).join('')}</section>`
    : '<section class="manage-empty"><div><i class="ti ti-tag-off"></i><p>文章添加标签后会在这里出现</p></div></section>';
}

function renderManageV2() {
  const rows = state.manageRows;
  $('#manage-count').textContent = `${rows.length} 个收藏夹`;
  $('#manage-tags-count').textContent = `${state.manageTags.length} 个标签`;
  $('#manage-search').placeholder = '搜索收藏夹或文章';
  $('#manage-create-folder').classList.remove('hidden');
  $('#manage-entities').innerHTML = rows.length
    ? rows.map((entry) => `<button class="manage-entity ${entry.id === state.manageSelectedId ? 'active' : ''}" type="button" data-manage-select="${entry.id}"><span><strong>${escapeHtml(entry.name)}</strong><span>${entry.latest_item_at ? `最近加入 ${shortDate(entry.latest_item_at)}` : '暂无文章'}</span></span><b>${entry.count}</b></button>`).join('')
    : '<section class="manage-empty"><div><i class="ti ti-folder-off"></i><p>还没有收藏夹</p></div></section>';
  $('#manage-detail').innerHTML = manageDetailMarkup(state.manageDetail, true);
  $('#manage-tags').innerHTML = manageTagCards(state.manageTags);
  bindManageActions();
  $$('[data-manage-rename-tag]').forEach((button) => button.addEventListener('click', () => {
    state.manageSelectedId = button.dataset.manageRenameTag;
    state.manageDetail = state.manageTags.find((entry) => entry.id === state.manageSelectedId) || null;
    if (state.manageDetail) openManageNameDialog('rename', 'tags');
  }));
}

async function loadManageDetail() { if (!state.manageSelectedId) { state.manageDetail = null; renderManageV2(); return; } try { state.manageDetail = await request(`/api/folders/${state.manageSelectedId}`); renderManageV2(); syncManageRoute({ replace: true }); } catch (error) { toast(error.message); } }
async function loadManage() { try { const [folderResult, tagResult] = await Promise.all([request(`/api/folders?q=${encodeURIComponent(state.manageQuery)}`), request('/api/tags')]); state.manageMode = 'folders'; state.manageRows = folderResult.folders; state.manageTags = tagResult.tags; if (!state.manageRows.some((entry) => entry.id === state.manageSelectedId)) state.manageSelectedId = state.manageRows[0]?.id || ''; await loadManageDetail(); } catch (error) { toast(error.message); } }
function openManage() { state.manageMode = 'folders'; setWorkspaceVisibility('manage'); loadManage(); window.scrollTo({ top: 0, behavior: 'instant' }); }
function openManageNameDialog(mode, entityType = 'folders') { state.manageDialog = mode; state.manageDialogType = entityType; const isFolder = entityType === 'folders'; $('#manage-name-eyebrow').textContent = isFolder ? '收藏夹' : '标签'; $('#manage-name-title').textContent = mode === 'create' ? '新建收藏夹' : `重命名${isFolder ? '收藏夹' : '标签'}`; $('#manage-name-input').value = mode === 'rename' ? state.manageDetail.name : ''; $('#manage-name-input').maxLength = isFolder ? 9 : 40; $('#manage-name-message').textContent = ''; dialog('manage-name-dialog'); $('#manage-name-input').focus(); }
$('#open-manage').addEventListener('click', openManage); $('#manage-create-folder').addEventListener('click', () => openManageNameDialog('create'));
let manageSearchTimer; $('#manage-search').addEventListener('input', (event) => { state.manageQuery = event.currentTarget.value.trim(); clearTimeout(manageSearchTimer); manageSearchTimer = setTimeout(loadManage, 300); });
$('#manage-name-form').addEventListener('submit', async (event) => { event.preventDefault(); const input = $('#manage-name-input'); const name = input.value.trim(); const action = state.manageDialog; const url = action === 'create' ? '/api/folders' : `/api/${state.manageDialogType}/${state.manageSelectedId}`; try { await request(url, { method: action === 'create' ? 'POST' : 'PATCH', body: JSON.stringify({ name }) }); closeDialog('manage-name-dialog'); toast(action === 'create' ? '收藏夹已创建。' : '名称已更新。'); await loadManage(); await loadContent(); } catch (error) { $('#manage-name-message').textContent = error.message; } });
$('#manage-folder-delete-confirm').addEventListener('click', async () => { if (!state.manageSelectedId) return; try { await request(`/api/folders/${state.manageSelectedId}`, { method: 'DELETE' }); closeDialog('manage-folder-delete-dialog'); state.manageSelectedId = ''; state.manageDetail = null; toast('收藏夹已删除，文章仍然保留。'); await loadManage(); await loadContent(); } catch (error) { toast(error.message); } });
$('#manage-folder-remove-confirm').addEventListener('click', async () => {
  const removal = pendingFolderRemoval;
  if (!removal) return;
  const button = $('#manage-folder-remove-confirm');
  button.disabled = true;
  try {
    await request(`/api/folders/${removal.folderId}/items/${removal.itemId}`, { method: 'DELETE' });
    closeDialog('manage-folder-remove-dialog');
    pendingFolderRemoval = null;
    toast('已移出收藏夹。');
    await loadManage();
    await loadContent();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});
$$('[data-timeline-type]').forEach((button) => button.addEventListener('click', () => { state.timelineType = button.dataset.timelineType; state.timelinePage = 1; syncTimelineControls(); loadTimeline(); }));
$$('[data-timeline-status]').forEach((button) => button.addEventListener('click', () => { state.timelineArticleStatus = button.dataset.timelineStatus; state.timelinePage = 1; syncTimelineControls(); loadTimeline(); }));
$$('[data-timeline-view]').forEach((button) => button.addEventListener('click', () => { state.timelineView = button.dataset.timelineView; $$('.timeline-view-toggle [data-timeline-view]').forEach((entry) => { const active = entry === button; entry.classList.toggle('active', active); entry.setAttribute('aria-pressed', String(active)); }); renderTimeline(); syncTimelineRoute(); }));
$('#timeline-more').addEventListener('click', () => { state.timelinePage += 1; loadTimeline({ append: true }); });
upgradeReaderFontSelect();
applyReaderDisplay();
window.addEventListener('scroll', updateReaderProgress, { passive: true });
window.addEventListener('pagehide', () => { if (state.reader) saveReaderProgress(true); });
 window.addEventListener('hashchange', () => { const readerId = readerIdFromLocation(); if (readerId && readerId !== state.reader?.id) openItem(readerId, { updateRoute: false, restoreProgress: true }); else if (!readerId && state.reader) closeReaderPage({ updateRoute: false }); else if (window.location.hash === '#notes' && state.workspace !== 'notes') { const params = new URLSearchParams(window.location.search); state.noteArticleQuery = params.get('articleQ') || ''; state.noteQuery = params.get('noteQ') || ''; state.noteField = params.get('noteField') === 'highlight' ? 'highlight' : 'note'; state.noteArticleStatus = params.get('noteArticleStatus') || 'all'; state.selectedNoteId = params.get('note') || ''; openNotesWorkspace({ restore: true }); } else if (window.location.hash === '#mp' && state.workspace !== 'mp') openMpSubscriptions(); });
initialize().then(() => { const params = new URLSearchParams(window.location.search); if (window.location.hash === '#manage') { state.manageMode = params.get('mode') === 'tags' ? 'tags' : 'folders'; state.manageQuery = params.get('q') || ''; state.manageSelectedId = params.get('selected') || ''; $('#manage-search').value = state.manageQuery; $$('.workspace-toggle .vt-btn').forEach((button) => { const active = button.dataset.manageMode === state.manageMode; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }); openManage(); } if (window.location.hash === '#timeline') { state.timelineView = params.get('view') === 'journal' ? 'journal' : 'cards'; state.timelineType = ['created', 'favorite', 'archive', 'note'].includes(params.get('types')) ? params.get('types') : 'all'; state.timelineArticleStatus = ['active', 'archived'].includes(params.get('articleStatus')) ? params.get('articleStatus') : 'all'; syncTimelineControls(); $$('.timeline-view-toggle [data-timeline-view]').forEach((button) => { const active = button.dataset.timelineView === state.timelineView; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }); openTimeline(); } if (window.location.hash === '#mp') openMpSubscriptions(); });
