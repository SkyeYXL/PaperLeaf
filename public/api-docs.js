const baseUrl = window.location.origin.replace(/\/$/, '');
const tokenInput = document.querySelector('#api-token');
const tokenPlaceholder = 'pl_请在上方填写Token';
const currentModule = document.querySelector('[data-api-module]')?.dataset.apiModule || '';

const pages = [['overview', 'PaperLeaf API', '/api-docs.html'], ['token', '认证与 Token', '/api-docs-token.html'], ['bookmarks', '文章', '/api-docs-bookmarks.html'], ['highlights', '高亮笔记', '/api-docs-highlights.html'], ['tags', '标签', '/api-docs-tags.html'], ['collections', '收藏夹', '/api-docs-collections.html'], ['timeline', '时间轴', '/api-docs-timeline.html'], ['data', '数据导入与导出', '/api-docs-data.html'], ['responses', '返回代码', '/api-docs-responses.html']];
const errors = {
  INVALID_TOKEN: [401, 'Token 无效、已撤销或没有所需权限。', 'Token 缺失、无效、已撤销、所属用户被禁用或权限不足。'],
  NOT_FOUND: [404, '未找到目标资源。', '路径参数对应的资源不存在，或不属于当前 Token 用户。'],
  METHOD_NOT_ALLOWED: [405, '不支持的接口操作。', '当前路径不支持所使用的 HTTP 方法。'],
  INTERNAL_ERROR: [500, '请求未完成，请稍后重试。', '服务在抓取或内部处理时发生未预期异常。'],
  INVALID_HIGHLIGHT: [400, '高亮内容不能为空。', '高亮原文为空或不符合长度限制。'],
  INVALID_NOTE_TITLE: [400, '笔记标题为 1-120 字符。', '笔记标题为空或超过 120 字符。'],
  INVALID_NOTE: [400, '笔记正文为 1-1000 字符。', '笔记正文为空或超过 1,000 字符。'],
  INVALID_NOTE_VERSION: [400, '缺少笔记更新时间。', '请求没有提供 updatedAt。'],
  INVALID_TAG: [400, '标签名称为 1-40 个非空白字符，且不能包含空格或控制字符。', '标签名称不符合规则。'],
  INVALID_COLLECTION: [400, '收藏夹名称为 1-9 个字符，且不能包含控制字符。', '收藏夹名称不符合规则。'],
  DUPLICATE_TAG: [409, '已存在同名标签。', '当前用户已存在相同名称的标签。'],
  DUPLICATE_COLLECTION: [409, '已存在同名收藏夹。', '当前用户已存在相同名称的收藏夹。'],
  NOTE_CONFLICT: [409, '笔记已在其他位置更新。', 'updatedAt 已过期，需重新读取后再提交。'],
  FORBIDDEN: [403, '完整服务数据仅限管理员操作。', 'Token 有效，但所属用户不是管理员。'],
  INVALID_BACKUP: [400, '请选择有效的完整服务备份文件，并确认覆盖当前全部服务数据。', '备份格式、确认标识、管理员账号或表结构不符合要求。'],
  TOKEN_KEY_MANAGED: [400, '当前服务使用环境变量管理 Token 加密密钥，不能导入含独立密钥的备份。', '运行时密钥策略与备份不兼容。'],
  MISSING_TOKEN_KEY: [400, '该备份缺少 Token 加密密钥，无法安全恢复 API Token。', '备份有 Token 却没有可恢复密钥。'],
  IMPORT_FAILED: [400, '导入失败。', '导入事务或外键校验失败。']
};
const f = (field, type, description, required = '是') => [field, type, required, description];
const p = (name, place, type, required, fallback, description) => [name, place, type, required, fallback, description];
const e = (id, method, path, title, description, scope, params, response, fields, errorCodes, options = {}) => ({ id, method, path, title, description, scope, params, response, fields, errorCodes, ...options });
const pagination = [p('page', 'Query', 'Integer', '否', '1', '页码，从 1 开始。'), p('pageSize', 'Query', 'Integer', '否', '100', '每页数量，范围 1–100；时间轴上限为 12。')];
const bookmark = [f('data.id', 'String', '文章 ID，格式为 itm_…。'), f('data.url', 'String', '原始网页地址。'), f('data.title', 'String', '文章标题。'), f('data.summary', 'String', '抓取或编辑后的摘要。'), f('data.is_read / is_archived / is_favorite', 'Boolean', '阅读、归档和收藏状态。'), f('data.reading_progress', 'Number', '阅读进度，范围为 0–1。'), f('data.tags', 'Array<Tag>', '关联标签。'), f('data.folders', 'Array<Collection>', '关联收藏夹。'), f('data.highlights', 'Array<Highlight>', '详情接口返回该文章的高亮笔记。', '详情接口')];
const highlight = [f('data.id', 'String', '高亮笔记 ID，格式为 hlt_…。'), f('data.item_id', 'String', '所属文章 ID。'), f('data.text', 'String', '高亮原文。'), f('data.title', 'String', '笔记标题。'), f('data.note', 'String', '笔记正文。'), f('data.updated_at', 'String', 'ISO 8601 更新时间；更新时作为 updatedAt 原样提交。'), f('data.article', 'Object', '所属文章摘要，含 id、title 与 url。')];

const endpointDocs = {
  token: [e('verify-token', 'GET', '/api/v1/me', '验证 Token', '确认服务地址、Token 与认证头均正确，并读取 Token 所属用户名。', '有效 Token', [], { data: { username: 'admin' } }, [f('data.username', 'String', 'Token 所属用户名。')], ['INVALID_TOKEN', 'INTERNAL_ERROR'])],
  bookmarks: [
    e('list-bookmarks', 'GET', '/api/v1/bookmarks', '获取文章列表', '读取当前用户保存的文章，并按状态、标签、收藏夹或关键词筛选。', 'items:read', [p('status', 'Query', 'String', '否', '—', 'unread、archived 或 favorite。'), p('tag', 'Query', 'String', '否', '—', '标签名称。'), p('folderId', 'Query', 'String', '否', '—', '收藏夹 ID。'), p('q', 'Query', 'String', '否', '—', '标题或摘要关键词。'), ...pagination], { data: { items: [{ id: 'itm_…', title: '示例文章' }], page: 1, pageSize: 20, total: 1 } }, [f('data.items', 'Array<Bookmark>', '当前页文章数组。'), f('data.page / pageSize / total', 'Integer', '分页信息。'), ...bookmark.map((row) => f(`data.items[].${row[0].replace('data.', '')}`, row[1], row[3], '元素'))], ['INVALID_TOKEN', 'METHOD_NOT_ALLOWED', 'INTERNAL_ERROR'], { query: '?page=1&pageSize=20&status=unread' }),
    e('create-bookmark', 'POST', '/api/v1/bookmarks', '保存文章', '抓取公开网页并创建一篇独立文章；同一 URL 可重复保存。', 'items:write', [p('url', 'Body', 'String', '是', '—', '公开网页 URL。'), p('title', 'Body', 'String', '否', '—', '自定义标题，最多 300 字符。'), p('tags', 'Body', 'Array<String>', '否', '[]', '标签名称数组。'), p('folderIds', 'Body', 'Array<String>', '否', '[]', '要关联的收藏夹 ID 数组。')], { data: { duplicate: false, item: { id: 'itm_…', title: '示例文章', url: 'https://www.example.com/' } } }, [f('data.duplicate', 'Boolean', '创建新文章时为 false。'), f('data.item', 'Bookmark', '新建文章。'), ...bookmark.map((row) => f(`data.item.${row[0].replace('data.', '')}`, row[1], row[3], '对象'))], ['INVALID_TOKEN', 'METHOD_NOT_ALLOWED', 'INTERNAL_ERROR'], { body: { url: 'https://www.example.com/', title: '示例文章', tags: ['阅读'], folderIds: [] } }),
    e('get-bookmark', 'GET', '/api/v1/bookmarks/{bookmarkId}', '获取文章详情', '读取一篇文章及其标签、收藏夹和高亮笔记。', 'items:read', [p('bookmarkId', 'Path', 'String', '是', '—', '文章 ID，可从创建或列表响应取得。')], { data: { id: 'itm_…', title: '示例文章', tags: [], folders: [], highlights: [] } }, bookmark, ['INVALID_TOKEN', 'NOT_FOUND', 'METHOD_NOT_ALLOWED', 'INTERNAL_ERROR']),
    e('update-bookmark', 'PATCH', '/api/v1/bookmarks/{bookmarkId}', '更新文章', '更新阅读、归档、收藏、标题、摘要、标签和收藏夹；仅传入需要修改的字段。', 'items:write', [p('bookmarkId', 'Path', 'String', '是', '—', '文章 ID。'), p('is_read', 'Body', 'Boolean', '否', '—', '是否已读。'), p('is_archived', 'Body', 'Boolean', '否', '—', '是否归档。'), p('is_favorite', 'Body', 'Boolean', '否', '—', '是否收藏。'), p('last_opened', 'Body', 'Boolean', '否', '—', '传入 true 时记录打开时间。'), p('reading_progress', 'Body', 'Number', '否', '—', '阅读进度，服务会限制为 0–1。'), p('title', 'Body', 'String', '否', '—', '标题，最多 300 字符。'), p('summary', 'Body', 'String', '否', '—', '摘要，最多 2,000 字符。'), p('tags', 'Body', 'Array<String>', '否', '—', '完整替换标签名称数组。'), p('collectionIds', 'Body', 'Array<String>', '否', '—', '完整替换收藏夹 ID 数组。')], { data: { id: 'itm_…', is_read: true, is_favorite: true } }, bookmark, ['INVALID_TOKEN', 'NOT_FOUND', 'METHOD_NOT_ALLOWED', 'INTERNAL_ERROR'], { body: { is_read: true, is_favorite: true, tags: ['阅读'], collectionIds: [] } }),
    e('favorite-bookmark', 'POST', '/api/v1/bookmarks/{bookmarkId}/favorite', '收藏文章', '将指定文章设为收藏；重复调用保持收藏状态不变。', 'items:write', [p('bookmarkId', 'Path', 'String', '是', '—', '文章 ID。')], { data: { id: 'itm_…', is_favorite: true } }, bookmark, ['INVALID_TOKEN', 'NOT_FOUND', 'METHOD_NOT_ALLOWED', 'INTERNAL_ERROR']),
    e('archive-bookmark', 'POST', '/api/v1/bookmarks/{bookmarkId}/archive', '归档文章', '将指定文章设为归档；重复调用保持归档状态不变。', 'items:write', [p('bookmarkId', 'Path', 'String', '是', '—', '文章 ID。')], { data: { id: 'itm_…', is_archived: true } }, bookmark, ['INVALID_TOKEN', 'NOT_FOUND', 'METHOD_NOT_ALLOWED', 'INTERNAL_ERROR']),
    e('refetch-bookmark', 'POST', '/api/v1/bookmarks/{bookmarkId}/refetch', '重新抓取文章', '从原始 URL 重新抓取内容并刷新本地阅读快照。', 'items:write', [p('bookmarkId', 'Path', 'String', '是', '—', '文章 ID。')], { data: { id: 'itm_…', fetch_status: 'ready' } }, [...bookmark, f('data.fetch_status', 'String', 'ready 表示抓取并归档成功；失败时包含 fetch_error。')], ['INVALID_TOKEN', 'NOT_FOUND', 'METHOD_NOT_ALLOWED', 'INTERNAL_ERROR']),
    e('delete-bookmark', 'DELETE', '/api/v1/bookmarks/{bookmarkId}', '删除文章', '删除文章、关联高亮笔记及本地归档文件；此操作不可恢复。', 'items:write', [p('bookmarkId', 'Path', 'String', '是', '—', '文章 ID。')], { data: { deleted: true } }, [f('data.deleted', 'Boolean', '始终为 true，表示删除完成。')], ['INVALID_TOKEN', 'NOT_FOUND', 'METHOD_NOT_ALLOWED', 'INTERNAL_ERROR'])
  ],
  highlights: [
    e('list-highlights', 'GET', '/api/v1/highlights', '获取高亮笔记列表', '读取同时填写了标题和正文的高亮笔记，并支持文章与笔记检索。', 'items:read', [p('articleStatus', 'Query', 'String', '否', 'all', 'active、archived 或 all。'), p('articleQ', 'Query', 'String', '否', '—', '文章标题关键词。'), p('noteQ', 'Query', 'String', '否', '—', '笔记标题、正文或高亮原文关键词。'), p('noteField', 'Query', 'String', '否', 'note', '传入 highlight 时仅检索高亮原文。'), ...pagination], { data: { notes: [{ id: 'hlt_…', title: '阅读笔记' }], page: 1, pageSize: 20, total: 1 } }, [f('data.notes', 'Array<Highlight>', '当前页高亮笔记数组。'), f('data.page / pageSize / total', 'Integer', '分页信息。'), ...highlight.map((row) => f(`data.notes[].${row[0].replace('data.', '')}`, row[1], row[3], '元素'))], ['INVALID_TOKEN', 'METHOD_NOT_ALLOWED', 'INTERNAL_ERROR'], { query: '?page=1&pageSize=20' }),
    e('create-highlight', 'POST', '/api/v1/bookmarks/{bookmarkId}/highlights', '创建高亮笔记', '在指定文章中保存选中文本、笔记标题和正文。', 'items:write', [p('bookmarkId', 'Path', 'String', '是', '—', '所属文章 ID。'), p('text', 'Body', 'String', '是', '—', '高亮原文，最多 4,000 字符。'), p('title', 'Body', 'String', '是', '—', '笔记标题，1–120 字符。'), p('note', 'Body', 'String', '是', '—', '笔记正文，1–1,000 字符。')], { data: { id: 'hlt_…', title: '阅读笔记', note: '这是一条笔记。', text: '这是一段高亮文字。' } }, highlight, ['INVALID_HIGHLIGHT', 'INVALID_NOTE_TITLE', 'INVALID_NOTE', 'INVALID_TOKEN', 'NOT_FOUND', 'METHOD_NOT_ALLOWED', 'INTERNAL_ERROR'], { body: { text: '这是一段高亮文字。', title: '阅读笔记', note: '这是一条笔记。' } }),
    e('get-highlight', 'GET', '/api/v1/highlights/{highlightId}', '获取高亮笔记详情', '读取一条高亮笔记和所属文章摘要。', 'items:read', [p('highlightId', 'Path', 'String', '是', '—', '高亮笔记 ID。')], { data: { id: 'hlt_…', title: '阅读笔记', note: '这是一条笔记。', article: { id: 'itm_…' } } }, highlight, ['INVALID_TOKEN', 'NOT_FOUND', 'METHOD_NOT_ALLOWED', 'INTERNAL_ERROR']),
    e('update-highlight', 'PATCH', '/api/v1/highlights/{highlightId}', '更新高亮笔记', '使用乐观并发控制更新笔记标题和正文。', 'items:write', [p('highlightId', 'Path', 'String', '是', '—', '高亮笔记 ID。'), p('title', 'Body', 'String', '是', '—', '笔记标题，1–120 字符。'), p('note', 'Body', 'String', '是', '—', '笔记正文，1–1,000 字符。'), p('updatedAt', 'Body', 'String', '是', '—', '读取详情时返回的原始 updated_at。')], { data: { id: 'hlt_…', title: '更新后的标题', note: '更新后的笔记' } }, highlight, ['INVALID_NOTE_TITLE', 'INVALID_NOTE', 'INVALID_NOTE_VERSION', 'INVALID_TOKEN', 'NOT_FOUND', 'METHOD_NOT_ALLOWED', 'NOTE_CONFLICT', 'INTERNAL_ERROR'], { body: { title: '更新后的标题', note: '更新后的笔记', updatedAt: '2026-08-26T00:00:00.000Z' } }),
    e('delete-highlight', 'DELETE', '/api/v1/highlights/{highlightId}', '删除高亮笔记', '删除高亮笔记及其时间轴关联。', 'items:write', [p('highlightId', 'Path', 'String', '是', '—', '高亮笔记 ID。')], { data: { deleted: true } }, [f('data.deleted', 'Boolean', '始终为 true，表示删除完成。')], ['INVALID_TOKEN', 'NOT_FOUND', 'METHOD_NOT_ALLOWED', 'INTERNAL_ERROR'])
  ],
  tags: [
    e('list-tags', 'GET', '/api/v1/tags', '获取标签列表', '读取标签及其关联文章数量。', 'items:read', [p('q', 'Query', 'String', '否', '—', '标签名称或文章标题关键词。'), ...pagination], { data: { tags: [{ id: 'tag_…', name: '阅读', count: 1 }], page: 1, pageSize: 50, total: 1 } }, [f('data.tags', 'Array<Tag>', '标签数组。'), f('data.tags[].id / name', 'String', '标签 ID 和名称。'), f('data.tags[].count', 'Integer', '关联文章数量。'), f('data.page / pageSize / total', 'Integer', '分页信息。')], ['INVALID_TOKEN', 'METHOD_NOT_ALLOWED', 'INTERNAL_ERROR'], { query: '?page=1&pageSize=50' }),
    e('get-tag', 'GET', '/api/v1/tags/{tagId}', '获取标签详情', '读取标签及关联文章。', 'items:read', [p('tagId', 'Path', 'String', '是', '—', '标签 ID。'), ...pagination], { data: { id: 'tag_…', name: '阅读', items: [] } }, [f('data.id / name / created_at', 'String', '标签标识、名称和创建时间。'), f('data.items', 'Array<Bookmark>', '标签下的文章。'), f('data.total / page / pageSize', 'Integer', '分页信息。')], ['INVALID_TOKEN', 'NOT_FOUND', 'METHOD_NOT_ALLOWED', 'INTERNAL_ERROR']),
    e('update-tag', 'PATCH', '/api/v1/tags/{tagId}', '重命名标签', '修改标签名称。', 'items:write', [p('tagId', 'Path', 'String', '是', '—', '标签 ID。'), p('name', 'Body', 'String', '是', '—', '1–40 个非空白字符，不能含空格或控制字符。')], { data: { id: 'tag_…', name: '稍后阅读' } }, [f('data.id', 'String', '标签 ID。'), f('data.name', 'String', '更新后的标签名称。'), f('data.created_at', 'String', '创建时间。')], ['INVALID_TAG', 'INVALID_TOKEN', 'NOT_FOUND', 'METHOD_NOT_ALLOWED', 'DUPLICATE_TAG', 'INTERNAL_ERROR'], { body: { name: '稍后阅读' } })
  ],
  collections: [
    e('list-collections', 'GET', '/api/v1/collections', '获取收藏夹列表', '读取收藏夹及其文章数量。', 'items:read', [p('q', 'Query', 'String', '否', '—', '收藏夹名称或文章标题关键词。'), ...pagination], { data: { folders: [{ id: 'fld_…', name: '待读', count: 2 }], page: 1, pageSize: 50, total: 1 } }, [f('data.folders', 'Array<Collection>', '收藏夹数组。'), f('data.folders[].id / name', 'String', '收藏夹 ID 和名称。'), f('data.folders[].sort_order / count', 'Integer', '排序值和关联文章数量。'), f('data.page / pageSize / total', 'Integer', '分页信息。')], ['INVALID_TOKEN', 'METHOD_NOT_ALLOWED', 'INTERNAL_ERROR'], { query: '?page=1&pageSize=50' }),
    e('create-collection', 'POST', '/api/v1/collections', '创建收藏夹', '创建一个新的收藏夹。', 'items:write', [p('name', 'Body', 'String', '是', '—', '名称，长度为 1–9 个字符。'), p('sortOrder', 'Body', 'Integer', '否', '0', '排序值。')], { data: { id: 'fld_…', name: '待读', sort_order: 0 } }, [f('data.id', 'String', '收藏夹 ID。'), f('data.name', 'String', '收藏夹名称。'), f('data.sort_order', 'Integer', '排序值。'), f('data.created_at', 'String', '创建时间。')], ['INVALID_COLLECTION', 'INVALID_TOKEN', 'METHOD_NOT_ALLOWED', 'DUPLICATE_COLLECTION', 'INTERNAL_ERROR'], { body: { name: '待读', sortOrder: 0 } }),
    e('get-collection', 'GET', '/api/v1/collections/{collectionId}', '获取收藏夹详情', '读取收藏夹及其中文章。', 'items:read', [p('collectionId', 'Path', 'String', '是', '—', '收藏夹 ID。'), ...pagination], { data: { id: 'fld_…', name: '待读', items: [] } }, [f('data.id / name / sort_order / created_at', 'String', '收藏夹基本信息。'), f('data.items', 'Array<Bookmark>', '收藏夹中的文章。'), f('data.total / page / pageSize', 'Integer', '分页信息。')], ['INVALID_TOKEN', 'NOT_FOUND', 'METHOD_NOT_ALLOWED', 'INTERNAL_ERROR']),
    e('update-collection', 'PATCH', '/api/v1/collections/{collectionId}', '重命名收藏夹', '修改收藏夹名称。', 'items:write', [p('collectionId', 'Path', 'String', '是', '—', '收藏夹 ID。'), p('name', 'Body', 'String', '是', '—', '名称，长度为 1–9 个字符。')], { data: { id: 'fld_…', name: '已读' } }, [f('data.id', 'String', '收藏夹 ID。'), f('data.name', 'String', '更新后的名称。'), f('data.sort_order / created_at', 'Integer / String', '排序值和创建时间。')], ['INVALID_COLLECTION', 'INVALID_TOKEN', 'NOT_FOUND', 'METHOD_NOT_ALLOWED', 'DUPLICATE_COLLECTION', 'INTERNAL_ERROR'], { body: { name: '已读' } }),
    e('delete-collection', 'DELETE', '/api/v1/collections/{collectionId}', '删除收藏夹', '删除收藏夹，但不会删除其中文章。', 'items:write', [p('collectionId', 'Path', 'String', '是', '—', '收藏夹 ID。')], { data: { deleted: true, removed: 2 } }, [f('data.deleted', 'Boolean', '始终为 true。'), f('data.removed', 'Integer', '删除的文章关联数量。')], ['INVALID_TOKEN', 'NOT_FOUND', 'METHOD_NOT_ALLOWED', 'INTERNAL_ERROR']),
    e('remove-bookmark-from-collection', 'DELETE', '/api/v1/collections/{collectionId}/bookmarks/{bookmarkId}', '移出收藏夹', '仅将一篇文章移出指定收藏夹。', 'items:write', [p('collectionId', 'Path', 'String', '是', '—', '收藏夹 ID。'), p('bookmarkId', 'Path', 'String', '是', '—', '文章 ID。')], { data: { removed: true } }, [f('data.removed', 'Boolean', '始终为 true，表示关联已移除。')], ['INVALID_TOKEN', 'NOT_FOUND', 'METHOD_NOT_ALLOWED', 'INTERNAL_ERROR'])
  ],
  timeline: [e('list-timeline', 'GET', '/api/v1/timeline', '获取时间轴', '读取文章、高亮笔记、收藏和归档活动，并按日期分组。', 'items:read', [p('types', 'Query', 'String', '否', '—', '逗号分隔：article、note、created、favorite、archive、highlight、noteUpdated 或 archived。'), p('articleStatus', 'Query', 'String', '否', 'all', 'active、archived 或 all。'), p('q', 'Query', 'String', '否', '—', '文章、URL 或笔记关键词。'), p('page', 'Query', 'Integer', '否', '1', '日期分组页码。'), p('pageSize', 'Query', 'Integer', '否', '12', '每页日期组数，范围 1–12。')], { data: { items: [], total: 0, dayTotal: 0, hasMore: false, stats: { events: 0, articles: 0, notes: 0, archivedArticles: 0 } } }, [f('data.items', 'Array<TimelineEvent>', '当前页日期组中的事件。'), f('data.items[].event_type / occurred_at', 'String', '事件类型和发生时间。'), f('data.items[].article / highlight', 'Object | null', '关联文章与高亮笔记摘要。'), f('data.total / dayTotal', 'Integer', '事件总数和日期分组总数。'), f('data.hasMore', 'Boolean', '是否还有下一页日期组。'), f('data.stats', 'Object', '事件、文章、笔记和已归档文章计数。')], ['INVALID_TOKEN', 'METHOD_NOT_ALLOWED', 'INTERNAL_ERROR'], { query: '?types=article,note&page=1&pageSize=12' })],
  data: [
    e('export-data', 'GET', '/api/v1/data/export', '导出完整数据', '下载完整服务 JSON 备份；不包含浏览器会话或文章本地归档文件。', '管理员 + items:read', [], { format: 'paperleaf-service-backup', version: '0.0.3', exportedAt: '2026-08-26T00:00:00.000Z', system: { archiveNotice: '文章本地归档文件不会随 JSON 导出或在导入时自动删除。' }, tables: { users: [], items: [], tags: [] } }, [f('format', 'String', '固定为 paperleaf-service-backup。'), f('version', 'String', '生成备份的服务版本。'), f('exportedAt', 'String', 'ISO 8601 导出时间。'), f('system', 'Object', 'Token 密钥管理与归档文件说明。'), f('tables', 'Object', '用户、文章、标签、收藏夹、高亮、Token、偏好与时间轴等数据库表。')], ['INVALID_TOKEN', 'FORBIDDEN', 'INTERNAL_ERROR']),
    e('import-data', 'POST', '/api/v1/data/import', '导入完整数据', '覆盖导入完整服务备份；成功后当前网页会话失效。', '管理员 + items:write', [p('备份 JSON', 'Body', 'Object', '是', '—', '由导出接口生成的完整备份。'), p('confirmReplace', 'Body', 'Boolean', '是', 'true', '必须为 true，确认覆盖当前服务数据。')], { data: { imported: true, counts: { users: 1, items: 1 }, message: '完整服务数据已恢复。请使用备份中的账号重新登录。' } }, [f('data.imported', 'Boolean', '导入成功时为 true。'), f('data.counts', 'Object', '各导入数据表的行数。'), f('data.message', 'String', '导入完成与重新登录提示。')], ['INVALID_BACKUP', 'TOKEN_KEY_MANAGED', 'MISSING_TOKEN_KEY', 'IMPORT_FAILED', 'INVALID_TOKEN', 'FORBIDDEN', 'INTERNAL_ERROR'], { file: 'paperleaf-service-backup-with-confirm.json' })
  ]
};

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const token = () => tokenInput?.value.trim() || tokenPlaceholder;
const methodClass = (method) => `method-${method.toLowerCase()}`;
const key = (entry, type) => `${currentModule}:${entry.id}:${type}`;
const pathWithQuery = (entry) => `${entry.path}${entry.query || ''}`;
const json = (value) => JSON.stringify(value, null, 2);
const listExamples = {
  'list-bookmarks': { items: [{ id: 'itm_001', title: '第一篇示例文章', url: 'https://example.com/one' }, { id: 'itm_002', title: '第二篇示例文章', url: 'https://example.com/two' }, { id: 'itm_003', title: '第三篇示例文章', url: 'https://example.com/three' }, '……'] },
  'list-highlights': { notes: [{ id: 'hlt_001', title: '第一条阅读笔记' }, { id: 'hlt_002', title: '第二条阅读笔记' }, { id: 'hlt_003', title: '第三条阅读笔记' }, '……'] },
  'list-tags': { tags: [{ id: 'tag_001', name: '阅读', count: 3 }, { id: 'tag_002', name: '技术', count: 2 }, { id: 'tag_003', name: '稍后阅读', count: 1 }, '……'] },
  'list-collections': { folders: [{ id: 'fld_001', name: '待读', count: 3 }, { id: 'fld_002', name: '技术', count: 2 }, { id: 'fld_003', name: '归档', count: 1 }, '……'] },
  'list-timeline': { items: [{ id: 'evt_001', event_type: 'item_created', occurred_at: '2026-08-26T08:00:00.000Z' }, { id: 'evt_002', event_type: 'highlight_created', occurred_at: '2026-08-26T09:00:00.000Z' }, { id: 'evt_003', event_type: 'item_favorited', occurred_at: '2026-08-26T10:00:00.000Z' }, '……'] }
};
function successExample(entry) { const output = structuredClone(entry.response); if (listExamples[entry.id]) Object.assign(output.data, listExamples[entry.id]); return output; }

function curlCode(entry) {
  const lines = ['curl --silent --show-error --location', `  --request ${entry.method}`, `  --url "${baseUrl}${pathWithQuery(entry)}"`, `  --header "Authorization: Bearer ${token()}"`];
  if (entry.body || entry.file) lines.push('  --header "Content-Type: application/json"');
  if (entry.body) lines.push(`  --data '${JSON.stringify(entry.body)}'`);
  if (entry.file) lines.push(`  --data-binary @${entry.file}`);
  return lines.join(' \\\n');
}
function codeBlock(label, codeKey, language = '') { return `<div class="code-example"><header><strong>${label}</strong><button class="copy-code" type="button" data-copy="${codeKey}">复制</button></header><pre><code data-code="${codeKey}" data-language="${language}"></code></pre></div>`; }
function table(headers, rows) { return `<div class="table-scroll"><table><thead><tr>${headers.map((item) => `<th>${item}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((item) => `<td>${escapeHtml(item)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`; }
function parameterTable(params) { return params.length ? table(['参数', '位置', '类型', '必填', '默认值', '说明'], params) : '<p class="empty-note">无业务请求参数；仍须提供 <code>Authorization: Bearer &lt;token&gt;</code> 请求头。</p>'; }
function errorTable(codes) { return table(['状态码', '业务代码', '返回消息说明', '含义'], codes.map((code) => { const [status, message, description] = errors[code]; return [status, code, message, description]; })); }
function endpoint(entry) {
  const requestFormat = [`${entry.method} ${entry.path} HTTP/1.1`, `Host: ${baseUrl.replace(/^https?:\/\//, '')}`, 'Authorization: Bearer <token>', ...(entry.body || entry.file ? ['Content-Type: application/json', '', entry.file ? `@${entry.file}` : json(entry.body)] : [])].join('\n');
  return `<section class="api-method" id="${entry.id}"><h2><span class="http-method ${methodClass(entry.method)}">${entry.method}</span><span>${entry.title}</span></h2><p class="endpoint-path">${entry.path}</p><p>${entry.description}</p><section class="method-detail"><h3>接口基本信息</h3><dl class="method-info"><div><dt>完整 URL</dt><dd><code>${baseUrl}${entry.path}</code></dd></div><div><dt>HTTP 方法</dt><dd><span class="http-method ${methodClass(entry.method)}">${entry.method}</span></dd></div><div><dt>所需权限</dt><dd><code>${entry.scope}</code></dd></div></dl></section><section class="method-detail"><h3>授权信息</h3><p>使用本页“Token 鉴权”中填写的 API Token。示例会自动写入 <code>Authorization: Bearer &lt;token&gt;</code>；Token 不会保存。</p></section><section class="method-detail"><h3>请求参数</h3>${parameterTable(entry.params)}</section><section class="method-detail"><h3>请求格式</h3>${codeBlock('HTTP', key(entry, 'format'), 'format')}</section><section class="method-detail"><h3>代码调用示例</h3><p class="code-help">服务地址和当前 Token 已自动写入代码。${entry.path.includes('{') ? ' 请先将路径中的大括号参数替换为列表或创建响应中的实际 ID。' : ''}</p>${codeBlock('cURL（Shell）', key(entry, 'curl'), 'curl')}</section><section class="method-detail"><h3>返回格式</h3>${table(['字段', '类型', '必有性', '说明'], entry.fields)}</section><section class="method-detail"><h3>返回示例</h3>${codeBlock('成功 · JSON', key(entry, 'success'), 'success')}</section><section class="method-detail"><h3>错误码</h3>${errorTable(entry.errorCodes)}</section></section>`;
}
function renderNavigation() {
  const nav = document.querySelector('.docs-nav'); if (!nav) return;
  const activePage = document.body.dataset.apiPage || 'overview';
  nav.innerHTML = pages.map(([id, title, href]) => {
    const methods = endpointDocs[id] || [];
    if (!methods.length) return `<a class="nav-page nav-page-single" href="${href}"${id === activePage ? ' aria-current="page"' : ''}>${title}</a>`;
    const listId = `nav-endpoints-${id}`;
    const expanded = id === activePage;
    return `<section class="nav-group" data-nav-group="${id}"><div class="nav-page-row"><a class="nav-page" href="${href}"${id === activePage ? ' aria-current="page"' : ''}>${title}</a><button class="nav-toggle" type="button" aria-label="${expanded ? '收起' : '展开'}${title}接口目录" aria-controls="${listId}" aria-expanded="${expanded}"><i class="ti ti-chevron-${expanded ? 'down' : 'right'}" aria-hidden="true"></i></button></div><div class="endpoint-list" id="${listId}"${expanded ? '' : ' hidden'}>${methods.map((entry) => `<a class="endpoint-link" data-endpoint="${entry.id}" data-endpoint-page="${id}" href="${href}#${entry.id}"><span class="endpoint-method ${methodClass(entry.method)}">${entry.method}</span><span class="endpoint-name">${entry.title}</span></a>`).join('')}</div></section>`;
  }).join('');
  nav.querySelectorAll('.nav-toggle').forEach((button) => button.addEventListener('click', () => {
    const list = document.getElementById(button.getAttribute('aria-controls'));
    if (!list) return;
    const expanded = button.getAttribute('aria-expanded') === 'true';
    list.hidden = expanded;
    button.setAttribute('aria-expanded', String(!expanded));
    button.setAttribute('aria-label', `${expanded ? '展开' : '收起'}${button.closest('.nav-group')?.querySelector('.nav-page')?.textContent || ''}接口目录`);
    button.querySelector('i')?.setAttribute('class', `ti ti-chevron-${expanded ? 'right' : 'down'}`);
  }));
}
function renderMethods() {
  const methods = endpointDocs[currentModule]; if (!methods) return;
  const summary = document.querySelector('[data-api-summary]'); if (summary) summary.innerHTML = table(['方法', '路径', '说明'], methods.map((entry) => [entry.method, entry.path, `${entry.title}：${entry.description}`]));
  const host = document.querySelector('[data-api-methods]'); if (host) host.innerHTML = methods.map(endpoint).join('');
}
function observeCurrentEndpoint() {
  const activePage = document.body.dataset.apiPage || 'overview';
  const links = [...document.querySelectorAll(`.endpoint-link[data-endpoint][data-endpoint-page="${activePage}"]`)]; if (!links.length || !('IntersectionObserver' in window)) return;
  const setCurrent = (id) => links.forEach((link) => { if (link.dataset.endpoint === id) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current'); });
  const observer = new IntersectionObserver((entries) => { const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]; if (visible) setCurrent(visible.target.id); }, { rootMargin: '-22% 0px -68% 0px', threshold: 0 });
  links.forEach((link) => { const section = document.getElementById(link.dataset.endpoint); if (section) observer.observe(section); });
}
function synchronizeStaticCopy() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = []; let node;
  while ((node = walker.nextNode())) if (!['SCRIPT', 'STYLE', 'CODE', 'PRE'].includes(node.parentElement?.tagName)) nodes.push(node);
  nodes.forEach((item) => { item.nodeValue = item.nodeValue.replaceAll('书签', '文章').replaceAll('填写 Token 后，本页所有 cURL、JavaScript 和 Python 示例会自动更新。', '填写 Token 后，本页所有 cURL（Shell）示例会自动更新。'); });
}
function alignGlobalResponseTable() {
  const table = document.querySelector('body[data-api-page="responses"] table'); if (!table) return;
  const header = table.querySelector('thead tr'); if (header?.children.length === 3) header.children[1].insertAdjacentHTML('afterend', '<th>返回消息说明</th>');
  table.querySelectorAll('tbody tr').forEach((row) => { if (row.children.length !== 3) return; const code = row.querySelector('code')?.textContent; const message = code && errors[code] ? errors[code][1] : row.cells[0].textContent === '201' ? '资源创建成功。' : '请求成功。'; row.cells[1].insertAdjacentHTML('afterend', `<td>${escapeHtml(message)}</td>`); });
}
function codeFor(node) {
  const [module, id, type] = node.dataset.code.split(':'); const entry = endpointDocs[module]?.find((item) => item.id === id); if (!entry) return '';
  if (type === 'curl') return curlCode(entry);
  if (type === 'format') return [`${entry.method} ${entry.path} HTTP/1.1`, `Host: ${baseUrl.replace(/^https?:\/\//, '')}`, 'Authorization: Bearer <token>', ...(entry.body || entry.file ? ['Content-Type: application/json', '', entry.file ? `@${entry.file}` : json(entry.body)] : [])].join('\n');
  if (type === 'success') return json(successExample(entry)); const failure = errors[type]; return failure ? json({ error: { code: type, message: failure[1] } }) : '';
}
function renderCode() { document.querySelectorAll('[data-service-origin]').forEach((node) => { node.textContent = baseUrl; }); document.querySelectorAll('code[data-code]').forEach((node) => { node.textContent = codeFor(node); }); }
async function copyText(value) { if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value); const textarea = document.createElement('textarea'); textarea.value = value; textarea.style.position = 'fixed'; textarea.style.opacity = '0'; document.body.append(textarea); textarea.select(); document.execCommand('copy'); textarea.remove(); }
synchronizeStaticCopy(); renderNavigation(); renderMethods(); renderCode(); alignGlobalResponseTable(); observeCurrentEndpoint();
if (tokenInput) tokenInput.type = 'text';
tokenInput?.addEventListener('input', () => { const status = document.querySelector('#token-status'); if (status) status.textContent = tokenInput.value.trim() ? 'Token 已写入本页全部示例代码；刷新或离开页面后不会保留。' : '未填写 Token；复制的示例会提示你先在此处填写。'; renderCode(); });
document.addEventListener('click', async (event) => { const button = event.target.closest('.copy-code'); if (!button) return; const code = button.dataset.copy ? document.querySelector(`code[data-code="${button.dataset.copy}"]`)?.textContent : button.closest('.code-example')?.querySelector('code')?.textContent; if (!code) return; const initial = button.textContent; try { await copyText(code); button.textContent = '已复制'; } catch { button.textContent = '复制失败'; } window.setTimeout(() => { button.textContent = initial; }, 1600); });
