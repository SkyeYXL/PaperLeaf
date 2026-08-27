const byId = (id) => document.getElementById(id);
const defaultConfig = { server: 'http://127.0.0.1:3080', token: '' };
const draftStorage = chrome.storage.session || chrome.storage.local;
const draftKey = 'paperleafPopupDraft';
const blankPage = () => ({ title: '', url: '', selection: '', htmlSnapshot: '' });
const state = { view: 'capture', mode: 'link', page: blankPage(), tags: [], selectedTags: [], username: '', savedConfig: { ...defaultConfig }, savedItem: null, saving: false, saveProgress: 0 };

function showMessage(value = '', success = false) { const node = byId('message'); node.textContent = value; node.style.color = success ? '#5f6e35' : '#9c3b2e'; }
function normalizedServer(value) { return String(value || '').trim().replace(/\/$/, ''); }
function isHttpUrl(value) { return /^https?:\/\//i.test(value); }
function currentConfig() { return { server: normalizedServer(byId('server').value), token: byId('token').value.trim() }; }
function validConfig({ server, token }) { return isHttpUrl(server) && Boolean(token); }
function updateWebAppLink(server = currentConfig().server) { const target = normalizedServer(server); const url = new URL(isHttpUrl(target) ? target : defaultConfig.server); byId('open-web-app').href = `${url.href.replace(/\/$/, '')}/`; byId('web-app-server').textContent = url.host; byId('web-app-user').textContent = state.username || '当前用户'; }
function pageDraft() { return { title: byId('title').value, url: byId('url').value, tagInput: byId('tag-input').value }; }
function draftPayload() { return { view: state.view, mode: state.mode, selectedTags: state.selectedTags, page: pageDraft(), settings: currentConfig(), savedItem: state.savedItem }; }
function saveDraft() { return draftStorage.set({ [draftKey]: draftPayload() }); }
function setResultActionsDisabled(disabled) { ['saved-read', 'saved-favorite', 'saved-archive'].forEach((id) => { byId(id).disabled = disabled; }); }
function setSaveProgress(value) { state.saveProgress = Math.max(0, Math.min(100, Number(value) || 0)); byId('saved-progress-bar').style.width = `${state.saveProgress}%`; byId('saved-progress-track').setAttribute('aria-valuenow', String(state.saveProgress)); }
function renderResult() {
  const item = state.savedItem;
  byId('saved-title').textContent = item?.title || byId('title').value || '未命名网页';
  byId('saved-url').textContent = item?.url || byId('url').value || '—';
  const tags = (item?.tags || state.selectedTags).map((tag) => typeof tag === 'string' ? tag : tag?.name).filter(Boolean);
  byId('saved-tags').textContent = tags.length ? tags.map((tag) => `#${tag}`).join(' ') : '未添加标签';
  const progress = item?.fetch_status === 'failed' ? '链接已保存；网页抓取失败，可稍后重新抓取。' : item ? '已保存，文章已收录至PaperLeaf。' : '正在保存并归档网页…';
  byId('saved-progress').textContent = progress;
  setSaveProgress(item ? 100 : state.saveProgress || 12);
  [['saved-read', 'is_read', '标记为已读', '已标记为已读'], ['saved-favorite', 'is_favorite', '收藏', '已收藏'], ['saved-archive', 'is_archived', '归档', '已归档']].forEach(([id, key, defaultLabel, activeLabel]) => {
    const button = byId(id); const active = Boolean(item?.[key]); button.classList.toggle('active', active); button.textContent = active ? activeLabel : defaultLabel;
  });
  setResultActionsDisabled(!item || state.saving);
}
function setView(view, { persist = true } = {}) {
  state.view = view;
  const settings = view === 'settings'; const result = view === 'result';
  byId('capture-view').classList.toggle('hidden', settings || result);
  byId('settings-view').classList.toggle('hidden', !settings);
  byId('result-view').classList.toggle('hidden', !result);
  byId('connection-bar').classList.toggle('hidden', settings);
  byId('header-copy').textContent = settings ? '服务器与 Token 设置' : result ? '保存完成' : state.mode === 'selection' ? '保存网页选中文字' : '保存当前网页';
  if (result) renderResult();
  if (persist) void saveDraft();
}
function setMode(mode, { persist = true } = {}) {
  state.mode = mode; byId('selection-field').classList.toggle('hidden', mode !== 'selection');
  document.querySelectorAll('[data-mode]').forEach((button) => { const active = button.dataset.mode === mode; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); });
  byId('save').textContent = mode === 'selection' ? '保存选中文字' : '保存链接';
  if (state.view === 'capture') byId('header-copy').textContent = mode === 'selection' ? '保存网页选中文字' : '保存当前网页';
  byId('save').disabled = mode === 'selection' && !state.page.selection;
  if (persist) void saveDraft();
}
function addTag(value) {
  const raw = String(value || '').trim(); if (!raw) return true;
  if (!/^#[^#\s]{1,40}$/.test(raw)) { showMessage('标签格式为 #标签名，输入后按回车生成。'); return false; }
  const tag = raw.slice(1); if (!state.selectedTags.includes(tag)) state.selectedTags.push(tag); showMessage(''); renderTags(); void saveDraft(); return true;
}
function chooseTagSuggestion(name) {
  if (!state.selectedTags.includes(name)) state.selectedTags.push(name);
  byId('tag-input').value = ''; renderTags(); void saveDraft(); byId('tag-input').focus();
}
function renderTagSuggestions() {
  const input = byId('tag-input'); const suggestions = byId('tag-suggestions'); const keyword = input.value.trim().replace(/^#/, '').toLocaleLowerCase();
  const matches = keyword ? state.tags.filter(({ name }) => !state.selectedTags.includes(name) && name.toLocaleLowerCase().includes(keyword)).slice(0, 6) : [];
  suggestions.replaceChildren(); suggestions.classList.toggle('hidden', !matches.length);
  matches.forEach(({ name }) => { const button = document.createElement('button'); button.type = 'button'; button.role = 'option'; button.textContent = `#${name}`; button.addEventListener('mousedown', (event) => event.preventDefault()); button.addEventListener('click', () => chooseTagSuggestion(name)); suggestions.append(button); });
}
function renderTags() {
  const chips = byId('tag-chips'); const options = byId('tag-options'); chips.replaceChildren(); options.replaceChildren();
  state.selectedTags.forEach((tag) => { const chip = document.createElement('span'); chip.className = 'tag-chip'; chip.append(`#${tag}`); const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `移除标签 ${tag}`); remove.addEventListener('click', () => { state.selectedTags = state.selectedTags.filter((entry) => entry !== tag); renderTags(); void saveDraft(); }); chip.append(remove); chips.append(chip); });
  if (!state.tags.length) { byId('tag-status').textContent = '暂无已有标签'; renderTagSuggestions(); return; }
  byId('tag-status').textContent = `${state.tags.length} 个可选`;
  state.tags.forEach(({ name }) => { const button = document.createElement('button'); const active = state.selectedTags.includes(name); button.type = 'button'; button.className = `tag-option${active ? ' active' : ''}`; button.textContent = `#${name}`; button.setAttribute('aria-pressed', String(active)); button.addEventListener('click', () => { state.selectedTags = active ? state.selectedTags.filter((tag) => tag !== name) : [...state.selectedTags, name]; renderTags(); void saveDraft(); }); options.append(button); });
  renderTagSuggestions();
}
async function responseData(response) { const contentType = response.headers.get('content-type') || ''; const body = contentType.includes('application/json') ? await response.json() : null; if (!response.ok) throw new Error(body?.error?.message || `请求失败（${response.status}）。`); return body?.data ?? body; }
async function loadTags() { const config = currentConfig(); if (!validConfig(config)) { state.tags = []; state.username = ''; updateWebAppLink(); renderTags(); return; } byId('tag-status').textContent = '正在加载…'; try { const tagData = await responseData(await fetch(`${config.server}/api/v1/tags`, { headers: { Authorization: `Bearer ${config.token}` } })); state.tags = Array.isArray(tagData?.tags) ? tagData.tags : []; try { const userData = await responseData(await fetch(`${config.server}/api/v1/me`, { headers: { Authorization: `Bearer ${config.token}` } })); state.username = userData?.username || ''; } catch { state.username = ''; } updateWebAppLink(); renderTags(); } catch (error) { state.tags = []; state.username = ''; updateWebAppLink(); renderTags(); showMessage(`无法加载已有标签：${error.message}`); } }
async function loadPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isHttpUrl(tab.url)) { state.page = { ...blankPage(), url: tab?.url || '' }; byId('title').value = ''; byId('url').value = state.page.url; byId('selection').value = ''; showMessage('请停留在 HTTP 或 HTTPS 网页中使用小程序。'); return; }
  try { const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { const article = document.querySelector('.Post-RichText') || document.querySelector('article'); return { title: document.title, url: location.href, selection: window.getSelection()?.toString().trim().slice(0, 4000) || '', htmlSnapshot: article?.outerHTML.slice(0, 1_000_000) || '' }; } }); state.page = result || { ...blankPage(), title: tab.title || '', url: tab.url }; } catch { state.page = { ...blankPage(), title: tab.title || '', url: tab.url }; }
  byId('title').value = state.page.title || tab.title || ''; byId('url').value = state.page.url || tab.url || ''; byId('selection').value = state.page.selection;
}
async function refreshCurrentPageForSave() {
  const priorUrl = state.page.url;
  await loadPage();
  if (priorUrl && priorUrl !== state.page.url) { state.selectedTags = []; byId('tag-input').value = ''; renderTags(); }
}
function restoreCaptureDraft(draft) {
  if (!draft?.page) return;
  byId('title').value = draft.page.title ?? byId('title').value;
  byId('url').value = draft.page.url ?? byId('url').value;
  byId('tag-input').value = draft.page.tagInput || '';
}
async function saveSettings() {
  const config = currentConfig(); if (!validConfig(config)) return showMessage('请填写有效的服务器地址和 API Token。');
  await chrome.storage.local.set(config); state.savedConfig = { ...config }; updateWebAppLink(config.server); showMessage('配置已保存，正在加载已有标签…', true); setView('capture'); await loadTags();
}
function discardSettings() {
  byId('server').value = state.savedConfig.server; byId('token').value = state.savedConfig.token; updateWebAppLink(state.savedConfig.server); showMessage(''); setView('capture');
}
async function testConnection() { const config = currentConfig(); if (!validConfig(config)) return showMessage('请先填写有效的服务器地址和 API Token。'); const button = byId('test-connection'); button.disabled = true; showMessage('正在测试服务器与 Token…'); try { await responseData(await fetch(`${config.server}/api/v1/tags`, { headers: { Authorization: `Bearer ${config.token}` } })); showMessage('连接正常，API Token 可用。', true); } catch (error) { showMessage(`连通性测试失败：${error.message}`); } finally { button.disabled = false; } }
async function updateSavedItem(field) {
  const item = state.savedItem; const config = currentConfig(); if (!item || !validConfig(config)) return;
  const button = byId(field === 'is_read' ? 'saved-read' : field === 'is_favorite' ? 'saved-favorite' : 'saved-archive'); button.disabled = true;
  try { const result = await responseData(await fetch(`${config.server}/api/v1/bookmarks/${encodeURIComponent(item.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` }, body: JSON.stringify({ [field]: !Boolean(item[field]) }) })); state.savedItem = result; renderResult(); await saveDraft(); showMessage('文章状态已更新。', true); } catch (error) { showMessage(error.message || '文章状态更新失败。'); } finally { if (state.savedItem) renderResult(); }
}
async function saveCapture() {
  const config = currentConfig();
  if (!validConfig(config)) { setView('settings'); return showMessage('请先完成服务器地址和 API Token 配置。'); }
  await refreshCurrentPageForSave();
  const title = byId('title').value.trim(); const url = byId('url').value.trim(); const selection = state.page.selection;
  if (!isHttpUrl(url)) return showMessage('当前页面不是可保存的公开网页。'); if (state.mode === 'selection' && !selection) return;
  const pending = byId('tag-input').value.trim(); if (pending && !addTag(pending)) return; if (pending) byId('tag-input').value = '';
  state.saving = true; state.savedItem = null; state.saveProgress = 12; byId('save').disabled = true; setView('result'); showMessage(state.mode === 'selection' ? '正在保存选中文字…' : '正在保存并归档网页…');
  try {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` };
    const itemResult = await responseData(await fetch(`${config.server}/api/v1/items`, { method: 'POST', headers, body: JSON.stringify({ url, title, tags: state.selectedTags, htmlSnapshot: state.page.htmlSnapshot || undefined }) }));
    state.saveProgress = 72; renderResult();
    if (state.mode === 'selection') await responseData(await fetch(`${config.server}/api/v1/items/${encodeURIComponent(itemResult.item.id)}/highlights`, { method: 'POST', headers, body: JSON.stringify({ text: selection }) }));
    state.savedItem = itemResult.item; state.saveProgress = 100; renderResult(); await saveDraft(); showMessage(itemResult.item.fetch_status === 'failed' ? '链接已保存，但网页抓取失败。' : '', true); await loadTags();
  } catch (error) { state.savedItem = null; setView('capture'); showMessage(error.message || '网络连接失败。'); } finally { state.saving = false; byId('save').disabled = false; renderResult(); void saveDraft(); }
}
const eyeIcon = (visible) => visible ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"></path><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"></path><path d="M9.9 4.2A10.8 10.8 0 0 1 12 4c6.5 0 10 8 10 8a18.4 18.4 0 0 1-3 4.1M6.6 6.6C3.8 8.5 2 12 2 12s3.5 8 10 8a9.7 9.7 0 0 0 3.4-.6"></path></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"></path><circle cx="12" cy="12" r="2.5"></circle></svg>';
byId('open-settings').addEventListener('click', () => setView('settings'));
byId('close-settings').addEventListener('click', discardSettings);
byId('save-settings').addEventListener('click', saveSettings);
byId('test-connection').addEventListener('click', testConnection);
byId('save').addEventListener('click', saveCapture);
byId('save-another').addEventListener('click', () => { state.savedItem = null; setView('capture'); });
byId('saved-read').addEventListener('click', () => updateSavedItem('is_read'));
byId('saved-favorite').addEventListener('click', () => updateSavedItem('is_favorite'));
byId('saved-archive').addEventListener('click', () => updateSavedItem('is_archived'));
['title', 'url', 'tag-input'].forEach((id) => byId(id).addEventListener('input', () => { if (id === 'tag-input') renderTagSuggestions(); void saveDraft(); }));
['server', 'token'].forEach((id) => byId(id).addEventListener('input', () => { if (id === 'server') updateWebAppLink(); void saveDraft(); }));
byId('toggle-token').addEventListener('click', () => { const token = byId('token'); const visible = token.type === 'text'; token.type = visible ? 'password' : 'text'; const button = byId('toggle-token'); button.innerHTML = eyeIcon(!visible); button.setAttribute('aria-label', visible ? '查看 API Token' : '隐藏 API Token'); button.setAttribute('title', visible ? '查看 API Token' : '隐藏 API Token'); });
byId('tag-input').addEventListener('focus', renderTagSuggestions);
byId('tag-input').addEventListener('blur', () => window.setTimeout(() => byId('tag-suggestions').classList.add('hidden'), 120));
byId('tag-input').addEventListener('keydown', (event) => { if (event.key === 'ArrowDown') { const first = byId('tag-suggestions').querySelector('button'); if (first) { event.preventDefault(); first.focus(); } return; } if (event.key === 'Escape') { byId('tag-suggestions').classList.add('hidden'); return; } if (event.key !== 'Enter') return; event.preventDefault(); if (addTag(event.currentTarget.value)) { event.currentTarget.value = ''; renderTagSuggestions(); } });
document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
(async function setup() {
  const [saved, draftResult] = await Promise.all([chrome.storage.local.get(defaultConfig), draftStorage.get(draftKey)]);
  const draft = draftResult[draftKey]; state.savedConfig = { server: normalizedServer(saved.server), token: saved.token || '' };
  byId('server').value = draft?.view === 'settings' && draft.settings ? draft.settings.server : state.savedConfig.server;
  byId('token').value = draft?.view === 'settings' && draft.settings ? draft.settings.token : state.savedConfig.token;
  state.mode = draft?.mode === 'selection' ? 'selection' : 'link';
  updateWebAppLink(byId('server').value); await loadPage();
  const sameCapturePage = Boolean(draft?.page?.url && draft.page.url === state.page.url);
  state.selectedTags = sameCapturePage && Array.isArray(draft?.selectedTags) ? draft.selectedTags.filter((tag) => typeof tag === 'string') : [];
  state.savedItem = sameCapturePage && draft?.savedItem && typeof draft.savedItem === 'object' ? draft.savedItem : null;
  if (sameCapturePage) restoreCaptureDraft(draft);
  renderTags(); setMode(state.mode, { persist: false });
  if (draft?.view === 'result' && state.savedItem) { setView('result', { persist: false }); if (validConfig(currentConfig())) await loadTags(); return; }
  if (draft?.view === 'settings') { setView('settings', { persist: false }); return; }
  if (validConfig(state.savedConfig)) { setView('capture', { persist: false }); await loadTags(); } else { setView('settings', { persist: false }); showMessage('请先填写服务器地址和 API Token。'); }
}());
