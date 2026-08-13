const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = { user: null, status: 'all', tag: '', folderId: '', search: '', items: [], dashboard: null, reader: null };
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
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
let propertyTags = [];
const readerDisplayDefaults = { font: 17, family: 'songti', width: 'standard', line: 'normal', mode: 'classic' };
let readerDisplay = { ...readerDisplayDefaults };

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
  const selected = options.some((option) => option.value === input.value) ? input.value : options[0]?.value || '';
  input.value = selected; const trigger = control.querySelector('.select-trigger'); const menu = control.querySelector('.select-menu'); const choice = options.find((option) => option.value === selected) || options[0];
  trigger.querySelector('span').textContent = choice?.label || '请选择';
  menu.innerHTML = options.map((option) => `<button type="button" role="option" data-value="${escapeHtml(option.value)}" aria-selected="${option.value === selected}">${escapeHtml(option.label)}</button>`).join('');
  setupSelectControl(control, input);
}
function upgradeRoleSelect() {
  const select = $('#user-form select[name="role"]'); if (!select) return;
  const control = document.createElement('div'); control.className = 'select-control'; control.innerHTML = '<button class="select-trigger" type="button" aria-expanded="false" aria-haspopup="listbox"><span></span><i class="ti ti-chevron-down" aria-hidden="true"></i></button><div class="select-menu" role="listbox" aria-label="角色"></div>';
  select.classList.add('select-native-value'); select.setAttribute('tabindex', '-1'); select.setAttribute('aria-hidden', 'true'); select.after(control); control.append(select);
  setSelectOptions(control, select, [...select.options].map((option) => ({ value: option.value, label: option.textContent })));
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
  $('#folder-list').innerHTML = `<button class="${allActive ? 'active' : ''}" data-folder="">全部内容 <small>${dashboard.counts.all}</small></button>${dashboard.folders.map((folder) => `<button class="${state.folderId === folder.id ? 'active' : ''}" data-folder="${folder.id}">${escapeHtml(folder.name)} <small>${folder.count}</small></button>`).join('')}`;
  $('#tag-list').innerHTML = dashboard.tags.length ? dashboard.tags.map((tag) => `<button class="${state.tag === tag.name ? 'active' : ''}" data-tag="${escapeHtml(tag.name)}">#${escapeHtml(tag.name)} <small>${tag.count}</small></button>`).join('') : '<span>保存文章后显示标签</span>';
  setSelectOptions($('#save-folder-control'), $('#save-folder-select'), [{ value: '', label: '不归入收藏夹' }, ...dashboard.folders.map((folder) => ({ value: folder.id, label: folder.name }))]);
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
async function loadContent() {
  const params = new URLSearchParams(); if (state.status !== 'all') params.set('status', state.status); if (state.tag) params.set('tag', state.tag); if (state.folderId) params.set('folderId', state.folderId); if (state.search) params.set('q', state.search);
  try { const [items, dashboard] = await Promise.all([request(`/api/items?${params}`), request('/api/dashboard')]); state.items = items.items; state.dashboard = dashboard; renderDashboard(); renderItems(); updateHeading(); } catch (error) { toast(error.message); }
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
  content.querySelectorAll('img').forEach((image) => { const openImage = () => { $('#image-preview').src = image.currentSrc || image.src; $('#image-preview').alt = image.alt || '正文图片'; dialog('image-preview-dialog'); }; image.addEventListener('click', openImage); image.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openImage(); } }); });
  applyArticleHighlights();
  const headings = [...content.querySelectorAll('h2,h3')]; const toc = $('#reader-toc-list');
  headings.forEach((heading, index) => { heading.id ||= `reader-section-${index + 1}`; });
  toc.innerHTML = headings.length ? headings.map((heading) => `<button type="button" class="${heading.tagName === 'H3' ? 'sub' : ''}" data-reader-section="${heading.id}">${escapeHtml(heading.textContent.trim() || '未命名段落')}</button>`).join('') : '<span class="reader-toc-empty">正文没有可用目录</span>';
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
}
function addPropertyTag(input) {
  const raw = String(input || '').trim();
  if (!raw) return true;
  if (!/^#[^#\s]{1,40}$/.test(raw)) { $('#reader-property-message').textContent = '标签格式为 #标签名，输入后按回车生成。'; return false; }
  const tag = raw.slice(1);
  if (!propertyTags.includes(tag)) propertyTags.push(tag);
  $('#reader-property-message').textContent = ''; renderPropertyTags(); return true;
}
function openReaderPropertyEditor() {
  if (!state.reader) return;
  const form = $('#reader-property-form'); const folders = state.dashboard?.folders || [];
  form.elements.title.value = state.reader.title || ''; form.elements.summary.value = state.reader.summary || ''; propertyTags = state.reader.tags.map((tag) => tag.name);
  const folderValue = $('#reader-edit-folder-value'); const selectedFolder = state.reader.folders[0]?.id || ''; folderValue.value = selectedFolder;
  setSelectOptions($('#reader-edit-folders'), folderValue, [{ value: '', label: '不归入收藏夹' }, ...folders.map((folder) => ({ value: folder.id, label: folder.name }))]);
  $('#reader-new-folder').value = ''; $('#reader-tag-input').value = ''; $('#reader-property-message').textContent = ''; renderPropertyTags(); dialog('reader-property-dialog');
}
function syncReaderState(item) {
  const readButton = $('#reader-read'); readButton.classList.toggle('active', item.is_read); readButton.setAttribute('aria-label', item.is_read ? '标记为未读' : '标记为已读'); readButton.setAttribute('title', item.is_read ? '标记为未读' : '标记为已读'); readButton.innerHTML = '<i class="ti ti-check"></i>';
  $('#reader-favorite').classList.toggle('active', item.is_favorite); $('#reader-archive').classList.toggle('active', item.is_archived);
}
function propertyPills(entries, emptyLabel, prefix = '') { return entries.length ? entries.map((entry) => `<span>${prefix}${escapeHtml(entry.name)}</span>`).join('') : `<em>${emptyLabel}</em>`; }
function renderReaderProperties(item) {
  const text = $('#reader-content').textContent.replace(/\s+/g, ' ').trim(); const chinese = (text.match(/[\u3400-\u9fff]/g) || []).length; const words = text.replace(/[\u3400-\u9fff]/g, ' ').trim().split(/\s+/).filter(Boolean).length; const count = chinese + words;
  $('#reader-prop-title').textContent = item.title || '未命名文章'; $('#reader-prop-summary').textContent = item.summary || '未添加描述'; $('#reader-prop-source').href = item.url; $('#reader-prop-source').textContent = domain(item.url); $('#reader-prop-saved').textContent = readerDate(item.created_at); $('#reader-prop-words').textContent = `${count.toLocaleString('zh-CN')} 字`; $('#reader-prop-duration').textContent = `约 ${Math.max(1, Math.ceil(count / 400))} 分钟`;
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
  $('#reader-page').classList.add('hidden'); $('#application').classList.remove('reader-active'); state.reader = null; document.title = '纸笺 · 稍后阅读'; loadContent(); window.scrollTo({ top: 0, behavior: 'instant' });
}
async function openItem(itemId, { updateRoute = true, restoreProgress = true } = {}) {
  try {
    if (state.reader && state.reader.id !== itemId) await saveReaderProgress(true);
    state.reader = await request(`/api/items/${itemId}`); const item = state.reader;
    void request(`/api/items/${itemId}`, { method: 'PATCH', body: JSON.stringify({ last_opened: true }) }).then((updated) => { if (state.reader?.id === itemId) state.reader = updated; }).catch(() => {});
    $('#reader-meta').textContent = `${domain(item.url)} · 已保存网页`;
    $('#reader-title').textContent = item.title; $('#reader-bar-title').textContent = item.title; document.title = `${item.title} · 纸笺`;
    renderReaderContent(item.fetch_status === 'ready' ? item.html_snapshot : '', item.fetch_error); renderReaderProperties(item); applyReaderDisplay();
    const notice = $('#fetch-notice'); notice.classList.toggle('hidden', item.fetch_status !== 'failed'); $('#fetch-notice-text').textContent = item.fetch_status === 'failed' ? `快照抓取失败：${item.fetch_error}。原文链接仍已保存。` : '';
    renderHighlights(); $('#reader-page').classList.remove('hidden'); $('#application').classList.add('reader-active'); if (updateRoute) setReaderRoute(item.id); window.scrollTo({ top: 0, behavior: 'instant' });
    if (restoreProgress) restoreReaderProgress(item.reading_progress); else updateReaderProgress();
  } catch (error) { toast(error.message); }
}
function articleTextNodes() {
  const walker = document.createTreeWalker($('#reader-content'), NodeFilter.SHOW_TEXT, { acceptNode: (node) => node.nodeValue.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode); return nodes;
}
function pointAtArticleOffset(offset) {
  let passed = 0;
  for (const node of articleTextNodes()) {
    const next = passed + node.nodeValue.length;
    if (offset <= next) return { node, offset: Math.max(0, offset - passed) };
    passed = next;
  }
  return null;
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
  const offsets = highlightSelectionOffsets(range); const rect = range.getBoundingClientRect(); const popover = $('#highlight-popover');
  pendingHighlightSelection = { text, ...offsets }; popover.classList.remove('hidden');
  const width = Math.min(390, window.innerWidth - 28); popover.style.width = `${width}px`; popover.style.left = `${Math.min(Math.max(14, rect.left), window.innerWidth - width - 14)}px`; popover.style.top = `${Math.min(window.innerHeight - 236, Math.max(14, rect.bottom + 12))}px`;
}
function jumpToHighlight(highlightId) {
  const target = $(`.reader-highlight[data-highlight-id="${highlightId}"]`);
  if (!target) return toast('该高亮无法在当前正文中定位。');
  target.scrollIntoView({ behavior: 'smooth', block: 'center' }); target.classList.add('is-target'); setTimeout(() => target.classList.remove('is-target'), 1400);
}
function showHighlightDetail(highlightId) {
  const highlight = state.reader?.highlights.find((entry) => entry.id === highlightId); if (!highlight) return;
  $('#highlight-detail-note').textContent = highlight.note || '未填写笔记。'; $('#highlight-detail-text').textContent = highlight.text; dialog('highlight-detail-dialog');
}
function renderHighlights() {
  const highlights = state.reader?.highlights || [];
  $('#highlight-list').innerHTML = highlights.map((highlight) => `<article class="highlight-entry"><button class="highlight-entry-main" type="button" data-show-highlight="${highlight.id}" aria-label="查看笔记详情：${escapeHtml((highlight.note || highlight.text).slice(0, 60))}"><p class="highlight-note">${escapeHtml(highlight.note || '未填写笔记。')}</p><span class="highlight-quote">${escapeHtml(highlight.text)}</span></button><div class="highlight-meta"><span>高亮于 ${readerDate(highlight.created_at)}</span><span class="highlight-actions"><button class="highlight-jump" type="button" data-jump-highlight="${highlight.id}" aria-label="跳转至文中高亮" title="跳转至文中高亮"><i class="ti ti-location"></i></button><button class="delete-link" type="button" data-delete-highlight="${highlight.id}" aria-label="删除笔记" title="删除笔记"><i class="ti ti-trash"></i></button></span></div></article>`).join('') || '<p class="setting-copy">尚未添加高亮笔记。</p>';
  $$('[data-jump-highlight]').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); jumpToHighlight(button.dataset.jumpHighlight); }));
  $$('[data-show-highlight]').forEach((entry) => entry.addEventListener('click', () => showHighlightDetail(entry.dataset.showHighlight)));
  $$('[data-delete-highlight]').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); pendingHighlightDelete = button.dataset.deleteHighlight; dialog('highlight-delete-dialog'); }));
}
async function updateItem(changes, refresh = true) {
  const updated = await request(`/api/items/${state.reader.id}`, { method: 'PATCH', body: JSON.stringify(changes) }); state.reader = updated;
  syncReaderState(updated);
  if (refresh) await loadContent();
}
async function loadTokens() { const tokens = await request('/api/tokens'); $('#token-list').innerHTML = tokens.length ? tokens.map((token) => `<div><strong>${escapeHtml(token.name)}${token.revoked_at ? '（已撤销）' : ''}</strong><span>${token.scopes.join(', ')} · 创建于 ${shortDate(token.created_at)}${token.last_used_at ? ` · 最近使用 ${shortDate(token.last_used_at)}` : ''}</span>${token.revoked_at ? '' : `<button data-revoke-token="${token.id}">撤销</button>`}</div>`).join('') : '<div><span>还没有 Token</span></div>';
  $$('[data-revoke-token]').forEach((button) => button.addEventListener('click', () => { pendingTokenRevoke = button.dataset.revokeToken; dialog('token-revoke-dialog'); })); }
async function loadUsers() { if (state.user.role !== 'admin') return; const users = await request('/api/users'); $('#user-list').innerHTML = users.map((user) => `<div><strong>${escapeHtml(user.username)}${user.disabled ? '（已禁用）' : ''}</strong><span>${user.role === 'admin' ? '管理员' : '普通用户'} · ${shortDate(user.created_at)}</span>${user.id === state.user.id ? '' : `<button data-toggle-user="${user.id}" data-disabled="${user.disabled}">${user.disabled ? '启用' : '禁用'}</button>`}</div>`).join(''); $$('[data-toggle-user]').forEach((button) => button.addEventListener('click', async () => { const disabled = button.dataset.disabled !== 'true'; try { await request(`/api/users/${button.dataset.toggleUser}`, { method: 'PATCH', body: JSON.stringify({ disabled }) }); toast(disabled ? '用户已禁用。' : '用户已启用。'); loadUsers(); } catch (error) { toast(error.message); } })); }
function setSettingsNav(sectionId) { $$('[data-settings-section]').forEach((button) => button.classList.toggle('active', button.dataset.settingsSection === sectionId)); }
function closeSettingsPage() { $('#settings-page').classList.add('hidden'); $('#application').classList.remove('settings-active'); window.scrollTo({ top: 0, behavior: 'instant' }); }
async function openSettings() {
  $('#account-line').textContent = `${state.user.username} · ${state.user.role === 'admin' ? '管理员' : '普通用户'}`;
  const isAdmin = state.user.role === 'admin'; $('#admin-section').classList.toggle('hidden', !isAdmin); $('#admin-nav').classList.toggle('hidden', !isAdmin); $('#new-token').classList.add('hidden');
  await loadTokens(); await loadUsers(); setSettingsNav('settings-account'); $('#settings-page').classList.remove('hidden'); $('#application').classList.add('settings-active'); window.scrollTo({ top: 0, behavior: 'instant' });
}
function downloadExport(format = 'json') { window.location.assign(`/api/export?format=${encodeURIComponent(format)}`); }
async function initialize() {
  document.body.dataset.authState = 'checking';
  try { state.user = await request('/api/auth/me'); const preferences = await request('/api/preferences'); readerDisplay = { ...readerDisplayDefaults, ...(preferences.readerDisplay || {}) }; document.body.dataset.view = preferences.homepageView === 'cards' ? 'cards' : 'list'; $$('.vt-btn').forEach((button) => { const active = button.dataset.view === document.body.dataset.view; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }); applyReaderDisplay(); $('#login-screen').classList.add('hidden'); $('#application').classList.remove('hidden'); await loadContent(); const readerId = readerIdFromLocation(); if (readerId) await openItem(readerId, { updateRoute: false, restoreProgress: true }); document.body.dataset.authState = 'authenticated'; } catch { $('#application').classList.add('hidden'); $('#login-screen').classList.remove('hidden'); document.body.dataset.authState = 'unauthenticated'; }
}

$('#login-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { state.user = await request('/api/auth/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) }); $('#login-message').textContent = ''; await initialize(); } catch (error) { $('#login-message').textContent = error.message; } });
async function saveUrl(url, { tags = [], folderId = '' } = {}) { const result = await request('/api/items', { method: 'POST', body: JSON.stringify({ url, tags, folderId }) }); toast(result.duplicate ? '该链接已存在，已打开现有条目。' : result.item.fetch_status === 'failed' ? '链接已保存，但抓取失败，可从原文打开。' : '已保存并生成阅读快照。'); await loadContent(); await openItem(result.item.id); return result; }
$$('[data-open-save]').forEach((button) => button.addEventListener('click', () => dialog('save-dialog')));
$('#quick-save-form').addEventListener('submit', async (event) => { event.preventDefault(); const formElement = event.currentTarget; const submit = formElement.querySelector('[type="submit"]'); const url = new FormData(formElement).get('url'); submit.disabled = true; try { await saveUrl(url); formElement.reset(); } catch (error) { toast(error.message); } finally { submit.disabled = false; } });
$('#save-form').addEventListener('submit', async (event) => { event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement); const submit = formElement.querySelector('[type="submit"]'); submit.disabled = true; $('#save-message').textContent = '正在抓取网页并生成安全快照…'; try { await saveUrl(form.get('url'), { tags: String(form.get('tags')).split(/[，,]/).map((tag) => tag.trim()).filter(Boolean), folderId: form.get('folderId') }); closeDialog('save-dialog'); formElement.reset(); } catch (error) { $('#save-message').textContent = error.message; } finally { submit.disabled = false; } });
$('#import-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const urls = String(form.get('urls')).split(/\r?\n/).map((url) => url.trim()).filter(Boolean); $('#import-message').textContent = `正在处理 ${urls.length} 条链接…`; try { const result = await request('/api/import', { method: 'POST', body: JSON.stringify({ urls, tags: String(form.get('tags')).split(/[，,]/).map((tag) => tag.trim()).filter(Boolean) }) }); $('#import-message').textContent = `已完成：${result.successful}/${result.total} 条。`; toast(`批量导入完成：${result.successful}/${result.total} 条成功。`); await loadContent(); } catch (error) { $('#import-message').textContent = error.message; } });
$('#settings-import-button').addEventListener('click', () => dialog('import-dialog')); $('#settings-export-json-button').addEventListener('click', () => downloadExport('json')); $('#settings-export-csv-button').addEventListener('click', () => downloadExport('csv')); $('#new-folder-button').addEventListener('click', () => dialog('folder-dialog')); $('#folder-form').addEventListener('submit', async (event) => { event.preventDefault(); const formElement = event.currentTarget; try { await request('/api/folders', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(formElement))) }); closeDialog('folder-dialog'); formElement.reset(); toast('收藏夹已创建。'); await loadContent(); } catch (error) { $('#folder-message').textContent = error.message; } });
$('#settings-button').addEventListener('click', openSettings); $$('[data-open-settings]').forEach((button) => button.addEventListener('click', openSettings)); $('#wx-button').addEventListener('click', () => dialog('wx-dialog'));
$('#settings-back').addEventListener('click', closeSettingsPage);
$$('[data-settings-section]').forEach((button) => button.addEventListener('click', () => { const sectionId = button.dataset.settingsSection; document.querySelector(`#${sectionId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); setSettingsNav(sectionId); }));
let articleSearchTimer;
$('#article-search').addEventListener('input', (event) => { const query = event.currentTarget.value.trim(); clearTimeout(articleSearchTimer); articleSearchTimer = setTimeout(() => { state.search = query; loadContent(); }, 220); });
$$('[data-close]').forEach((button) => button.addEventListener('click', () => closeDialog(button.dataset.close)));
document.addEventListener('pointerdown', (event) => { $$('.select-control.is-open').forEach((control) => { if (!control.contains(event.target)) closeSelect(control); }); const popover = $('#highlight-popover'); if (!popover.classList.contains('hidden') && !popover.contains(event.target) && !$('#reader-content').contains(event.target)) closeHighlightPopover(); });
$$('.nav-link').forEach((button) => button.addEventListener('click', () => { state.status = button.dataset.status; state.tag = ''; state.folderId = ''; $$('.nav-link').forEach((item) => item.classList.toggle('active', item === button)); loadContent(); }));
$$('.vt-btn').forEach((button) => button.addEventListener('click', () => { document.body.dataset.view = button.dataset.view; $$('.vt-btn').forEach((item) => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); }); void savePreferences({ homepageView: button.dataset.view }); }));
$('#reader-back').addEventListener('click', closeReaderPage);
$('#reader-refetch').addEventListener('click', async (event) => { const button = event.currentTarget; if (!state.reader) return; button.disabled = true; try { const item = await request(`/api/items/${state.reader.id}/refetch`, { method: 'POST' }); state.reader = item; await loadContent(); await openItem(item.id); toast(item.fetch_status === 'ready' ? '网页已重新抓取。' : '重新抓取失败，请查看提示或打开原文。'); } catch (error) { toast(error.message); } finally { button.disabled = false; } });
$('#reader-read').addEventListener('click', () => updateItem({ is_read: !state.reader.is_read })); $('#reader-favorite').addEventListener('click', () => updateItem({ is_favorite: !state.reader.is_favorite })); $('#reader-archive').addEventListener('click', () => updateItem({ is_archived: !state.reader.is_archived })); $('#reader-print').addEventListener('click', () => window.open(`/print?id=${encodeURIComponent(state.reader.id)}`, '_blank', 'noopener'));
$('#reader-mode-button').addEventListener('click', () => { readerDisplay.mode = readerDisplay.mode === 'classic' ? 'minimal' : 'classic'; saveReaderDisplay(); applyReaderDisplay(); });
$('#reader-appearance-button').addEventListener('click', () => { const panel = $('#reader-appearance'); const willOpen = panel.classList.contains('hidden'); panel.classList.toggle('hidden', !willOpen); $('#reader-appearance-button').setAttribute('aria-expanded', String(willOpen)); });
$('#reader-appearance-close').addEventListener('click', closeReaderAppearance);
$$('[data-reader-font]').forEach((button) => button.addEventListener('click', () => { readerDisplay.font = Number(button.dataset.readerFont); saveReaderDisplay(); applyReaderDisplay(); }));
$('#reader-font-family').addEventListener('change', (event) => { readerDisplay.family = event.currentTarget.value; saveReaderDisplay(); applyReaderDisplay(); });
$$('[data-reader-width]').forEach((button) => button.addEventListener('click', () => { readerDisplay.width = button.dataset.readerWidth; saveReaderDisplay(); applyReaderDisplay(); }));
$$('[data-reader-line]').forEach((button) => button.addEventListener('click', () => { readerDisplay.line = button.dataset.readerLine; saveReaderDisplay(); applyReaderDisplay(); }));
$('#reader-property-edit-toggle').addEventListener('click', openReaderPropertyEditor);
$('#reader-new-folder-button').addEventListener('click', async () => { const input = $('#reader-new-folder'); const name = input.value.trim(); if (!name) return; const button = $('#reader-new-folder-button'); button.disabled = true; try { const folder = await request('/api/folders', { method: 'POST', body: JSON.stringify({ name }) }); const folders = [...(state.dashboard?.folders || []), folder]; state.dashboard = { ...state.dashboard, folders }; const value = $('#reader-edit-folder-value'); value.value = folder.id; setSelectOptions($('#reader-edit-folders'), value, [{ value: '', label: '不归入收藏夹' }, ...folders.map((entry) => ({ value: entry.id, label: entry.name }))]); input.value = ''; await loadContent(); toast('收藏夹已创建。'); } catch (error) { $('#reader-property-message').textContent = error.message; } finally { button.disabled = false; } });
$('#reader-tag-input').addEventListener('keydown', (event) => { if (event.key !== 'Enter') return; event.preventDefault(); if (addPropertyTag(event.currentTarget.value)) event.currentTarget.value = ''; });
$('#reader-property-form').addEventListener('submit', async (event) => { event.preventDefault(); if (!state.reader) return; const pending = $('#reader-tag-input').value.trim(); if (pending && !addPropertyTag(pending)) return; const form = new FormData(event.currentTarget); const folderId = $('#reader-edit-folder-value').value; const folderIds = folderId ? [folderId] : []; const button = event.currentTarget.querySelector('[type="submit"]'); button.disabled = true; try { const item = await request(`/api/items/${state.reader.id}`, { method: 'PATCH', body: JSON.stringify({ title: form.get('title'), summary: form.get('summary'), tags: propertyTags, folderIds }) }); state.reader = item; $('#reader-title').textContent = item.title; $('#reader-bar-title').textContent = item.title; document.title = `${item.title} · 纸笺`; renderReaderProperties(item); closeDialog('reader-property-dialog'); await loadContent(); toast('文章属性已保存。'); } catch (error) { $('#reader-property-message').textContent = error.message; } finally { button.disabled = false; } });
$('#home-delete-confirm').addEventListener('click', async () => { const itemId = pendingItemDelete; if (!itemId) return; const button = $('#home-delete-confirm'); button.disabled = true; try { await request(`/api/items/${itemId}`, { method: 'DELETE' }); closeDialog('home-delete-dialog'); pendingItemDelete = null; await loadContent(); toast('文章已删除。'); } catch (error) { toast(error.message); } finally { button.disabled = false; } });
$('#new-highlight-button').addEventListener('click', () => toast('请在正文中选择一段文字后添加笔记。'));
$('#reader-content').addEventListener('mouseup', () => { setTimeout(() => { const selection = window.getSelection(); if (!selection?.rangeCount || selection.isCollapsed) return; openHighlightPopover(selection.getRangeAt(0)); }, 0); });
$('#reader-content').addEventListener('keyup', (event) => { if (!event.shiftKey && !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return; const selection = window.getSelection(); if (selection?.rangeCount && !selection.isCollapsed) openHighlightPopover(selection.getRangeAt(0)); });
$('#reader-content').addEventListener('click', (event) => { const mark = event.target.closest('.reader-highlight'); if (mark) showHighlightDetail(mark.dataset.highlightId); });
$('#highlight-cancel').addEventListener('click', closeHighlightPopover);
$('#highlight-popover').addEventListener('submit', async (event) => { event.preventDefault(); if (!pendingHighlightSelection || !state.reader) return; const form = new FormData(event.currentTarget); try { const highlight = await request(`/api/items/${state.reader.id}/highlights`, { method: 'POST', body: JSON.stringify({ text: pendingHighlightSelection.text, note: form.get('note'), start_offset: pendingHighlightSelection.start, end_offset: pendingHighlightSelection.end }) }); state.reader.highlights.unshift(highlight); closeHighlightPopover(); renderReaderContent(state.reader.html_snapshot); renderHighlights(); await loadContent(); toast('高亮笔记已保存。'); } catch (error) { toast(error.message); } });
$('#highlight-delete-confirm').addEventListener('click', async () => { const highlightId = pendingHighlightDelete; if (!highlightId || !state.reader) return; const button = $('#highlight-delete-confirm'); button.disabled = true; try { await request(`/api/items/${state.reader.id}/highlights/${highlightId}`, { method: 'DELETE' }); state.reader.highlights = state.reader.highlights.filter((highlight) => highlight.id !== highlightId); renderReaderContent(state.reader.html_snapshot); renderHighlights(); await loadContent(); closeDialog('highlight-delete-dialog'); pendingHighlightDelete = null; toast('高亮笔记已删除。'); } catch (error) { toast(error.message); } finally { button.disabled = false; } });
$('#token-revoke-confirm').addEventListener('click', async () => { const tokenId = pendingTokenRevoke; if (!tokenId) return; const button = $('#token-revoke-confirm'); button.disabled = true; try { await request(`/api/tokens/${tokenId}`, { method: 'DELETE' }); closeDialog('token-revoke-dialog'); pendingTokenRevoke = null; toast('Token 已撤销。'); await loadTokens(); } catch (error) { toast(error.message); } finally { button.disabled = false; } });
$('#password-form').addEventListener('submit', async (event) => { event.preventDefault(); const formElement = event.currentTarget; try { await request('/api/auth/password', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(formElement))) }); formElement.reset(); $('#password-message').textContent = ''; toast('密码已更新。'); } catch (error) { $('#password-message').textContent = error.message; } });
$('#token-form').addEventListener('submit', async (event) => { event.preventDefault(); const formElement = event.currentTarget; try { const result = await request('/api/tokens', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(formElement))) }); const value = $('#new-token'); value.textContent = `请立即保存，仅展示一次：${result.token}`; value.classList.remove('hidden'); formElement.reset(); loadTokens(); } catch (error) { toast(error.message); } });
$('#user-form').addEventListener('submit', async (event) => { event.preventDefault(); const formElement = event.currentTarget; try { await request('/api/users', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(formElement))) }); formElement.reset(); setSelectOptions($('#user-form .select-control'), $('#user-form select[name="role"]'), [{ value: 'user', label: '普通用户' }, { value: 'admin', label: '管理员' }]); toast('用户已创建。'); loadUsers(); } catch (error) { toast(error.message); } });
upgradeRoleSelect();
upgradeReaderFontSelect();
applyReaderDisplay();
window.addEventListener('scroll', updateReaderProgress, { passive: true });
window.addEventListener('pagehide', () => { if (state.reader) saveReaderProgress(true); });
window.addEventListener('hashchange', () => { const readerId = readerIdFromLocation(); if (readerId && readerId !== state.reader?.id) openItem(readerId, { updateRoute: false, restoreProgress: true }); else if (!readerId && state.reader) closeReaderPage({ updateRoute: false }); });
initialize();
