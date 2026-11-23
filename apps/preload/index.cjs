const { contextBridge, ipcRenderer } = require('electron');

/**
 * 把 Vue 的响应式 Proxy 转成纯数据再送 IPC
 *
 * ★ 结构化克隆不能处理 Proxy：渲染层直接传 ref/reactive 对象时，
 *   ipcRenderer.invoke 会抛 DataCloneError，而且往往被上层 if 吞掉，
 *   表现就是「点了按钮没反应」。统一在这里剥一层。
 */
function plain(v, channel) {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return v;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch (e) {
    // 不要静默返回 Proxy，否则上层只会看到 "An object could not be cloned."
    throw new Error(`IPC 参数无法序列化 (${channel}): ${e.message}`);
  }
}

const inv = (channel, ...args) => ipcRenderer.invoke(channel, ...args.map((a) => plain(a, channel)));

contextBridge.exposeInMainWorld('api', {
  account: {
    list: () => inv('account:list'),
    get: (id) => inv('account:get', id),
    update: (id, patch) => inv('account:update', id, patch),
    delete: (id) => inv('account:delete', id),
    reconnect: (id) => inv('account:reconnect', id),
  },

  // 登录：SDK 直接给 base64 二维码
  login: {
    start: (options) => inv('login:start', options),
    state: () => inv('login:state'),
    qr: () => inv('login:qr'),
    cancel: () => inv('login:cancel'),
    requestSms: (kind) => inv('login:requestSms', kind),
    submitSms: (code) => inv('login:submitSms', code),
    selectAccount: (payload) => inv('login:selectAccount', payload),
  },

  conv: {
    list: (accountId, opts) => inv('conv:list', accountId, opts),
    get: (accountId, peerUid) => inv('conv:get', accountId, peerUid),
    sync: (accountId) => inv('conv:sync', accountId),
    pin: (accountId, peerUid, pinned) => inv('conv:pin', accountId, peerUid, pinned),
    mute: (accountId, peerUid, muted) => inv('conv:mute', accountId, peerUid, muted),
  },

  contact: {
    members: (accountId, groupPeerUid) => inv('contact:members', accountId, groupPeerUid),
  },

  media: {
    open: (fileName) => inv('media:open', fileName),
  },

  msg: {
    list: (accountId, peerUid, opts) => inv('msg:list', accountId, peerUid, opts),
    history: (accountId, peerUid, cursor) => inv('msg:history', accountId, peerUid, cursor),
    send: (accountId, peerUid, text, options) => inv('msg:send', accountId, peerUid, text, options),
    sendImage: (accountId, peerUid, payload) => inv('msg:sendImage', accountId, peerUid, payload),
    sendFile: (accountId, peerUid, payload) => inv('msg:sendFile', accountId, peerUid, payload),
    retry: (accountId, messageId) => inv('msg:retry', accountId, messageId),
    forward: (accountId, messageId, targetPeerUid) => inv('msg:forward', accountId, messageId, targetPeerUid),
    recall: (accountId, messageId) => inv('msg:recall', accountId, messageId),
    delete: (accountId, messageId) => inv('msg:delete', accountId, messageId),
    react: (accountId, messageId, emoji, enabled) => inv('msg:react', accountId, messageId, emoji, enabled),
    markRead: (accountId, peerUid) => inv('msg:markRead', accountId, peerUid),
    readReceipt: (accountId, peerUid) => inv('msg:readReceipt', accountId, peerUid),
  },

  log: {
    list: (filters) => inv('log:list', filters),
    stats: (opts) => inv('log:stats', opts),
    accountReport: (opts) => inv('log:accountReport', opts),
    export: (filters) => inv('log:export', filters),
  },

  bc: {
    create: (payload) => inv('bc:create', payload),
    run: (taskId) => inv('bc:run', taskId),
    list: () => inv('bc:list'),
    get: (id) => inv('bc:get', id),
    results: (taskId) => inv('bc:results', taskId),
    pause: (id) => inv('bc:pause', id),
    resume: (id) => inv('bc:resume', id),
    cancel: (id) => inv('bc:cancel', id),
    retryFailed: (id) => inv('bc:retryFailed', id),
    estimate: (payload) => inv('bc:estimate', payload),
  },

  sender: {
    setDryRun: (v) => inv('sender:setDryRun', v),
    getDryRun: () => inv('sender:getDryRun'),
    resetCounters: () => inv('sender:resetCounters'),
  },

  risk: {
    status: (accountId) => inv('risk:status', accountId),
    reset: (accountId) => inv('risk:reset', accountId),
  },

  ic: {
    defaults: () => inv('ic:defaults'),
    templates: () => inv('ic:templates'),
    saveTemplates: (list) => inv('ic:saveTemplates', list),
    liveBrowser: () => inv('ic:liveBrowser'),
    harvestConfig: () => inv('ic:harvestConfig'),
    saveHarvestConfig: (patch) => inv('ic:saveHarvestConfig', patch),
    resetUsage: () => inv('ic:resetUsage'),
    parse: (raw, mode) => inv('ic:parse', raw, mode),
    create: (payload) => inv('ic:create', payload),
    harvest: (taskId) => inv('ic:harvest', taskId),
    startHarvest: (taskId, opts) => inv('ic:startHarvest', taskId, opts),
    targets: (taskId, opts) => inv('ic:targets', taskId, opts),
    keywords: (taskId) => inv('ic:keywords', taskId),
    review: (taskId, ids, action) => inv('ic:review', taskId, ids, action),
    approveAll: (taskId) => inv('ic:approveAll', taskId),
    get: (taskId) => inv('ic:get', taskId),
    refreshPresence: (taskId) => inv('ic:refreshPresence', taskId),
    list: () => inv('ic:list'),
    delete: (taskId) => inv('ic:delete', taskId),
    run: (taskId, opts) => inv('ic:run', taskId, opts),
  },

  lic: {
    status: () => inv('lic:status'),
    activate: (key) => inv('lic:activate', key),
    heartbeat: () => inv('lic:heartbeat'),
    deactivate: () => inv('lic:deactivate'),
    setServerUrl: (url) => inv('lic:setServerUrl', url),
  },

  upd: {
    status: () => inv('upd:status'),
    check: () => inv('upd:check'),
    download: () => inv('upd:download'),
    install: () => inv('upd:install'),
    reveal: () => inv('upd:reveal'),
  },

  cp: {
    list: (opts) => inv('cp:list', opts),
    get: (id) => inv('cp:get', id),
    videos: (opts) => inv('cp:videos', opts),
    keywords: () => inv('cp:keywords'),
    stats: () => inv('cp:stats'),
    jobs: (limit) => inv('cp:jobs', limit),
    job: (id) => inv('cp:job', id),
    startScan: (payload) => inv('cp:startScan', payload),
    cancelJob: (id) => inv('cp:cancelJob', id),
    resumeJob: (id) => inv('cp:resumeJob', id),
    deleteJob: (id) => inv('cp:deleteJob', id),
    refresh: (payload) => inv('cp:refresh', payload),
    excludeVideo: (awemeId, excluded) => inv('cp:excludeVideo', awemeId, excluded),
    addToLeads: (payload) => inv('cp:addToLeads', payload),
  },

  mt: {
    defaults: () => inv('mt:defaults'),
    scheduler: () => inv('mt:scheduler'),
    create: (taskId, cfg) => inv('mt:create', taskId, cfg),
    update: (taskId, patch) => inv('mt:update', taskId, patch),
    toggle: (taskId, enabled) => inv('mt:toggle', taskId, enabled),
    runNow: (taskId) => inv('mt:runNow', taskId),
    reset: (taskId) => inv('mt:reset', taskId),
    estimate: (cfg) => inv('mt:estimate', cfg),
  },



  card: {
    addLink: (opts) => inv('card:addLink', opts),
    list: (opts) => inv('card:list', opts),
    groups: () => inv('card:groups'),
    get: (id) => inv('card:get', id),
    update: (id, patch) => inv('card:update', id, patch),
    delete: (id, opts) => inv('card:delete', id, opts),
    send: (payload) => inv('card:send', payload),
  },

  px: {
    list: () => inv('px:list'),
    enabled: () => inv('px:enabled'),
    setEnabled: (v) => inv('px:setEnabled', v),
    create: (p) => inv('px:create', p),
    update: (id, patch) => inv('px:update', id, patch),
    delete: (id) => inv('px:delete', id),
    test: (id) => inv('px:test', id),
    bind: (accountId, proxyId) => inv('px:bind', accountId, proxyId),
    map: () => inv('px:map'),
    state: (accountId) => inv('px:state', accountId),
    apply: () => inv('px:apply'),
    debug: () => inv('px:debug'),
    relaunch: () => inv('px:relaunch'),
  },

  ar: {
    getConfig: () => inv('ar:getConfig'),
    saveConfig: (patch) => inv('ar:saveConfig', patch),
    listRules: () => inv('ar:listRules'),
    addRule: (r) => inv('ar:addRule', r),
    updateRule: (id, patch) => inv('ar:updateRule', id, patch),
    deleteRule: (id) => inv('ar:deleteRule', id),
    listDrafts: (opts) => inv('ar:listDrafts', opts),
    draftCount: (opts) => inv('ar:draftCount', opts),
    updateDraft: (id, patch) => inv('ar:updateDraft', id, patch),
    discardAllDrafts: (opts) => inv('ar:discardAllDrafts', opts),
    sendDraft: (id) => inv('ar:sendDraft', id),
    listLogs: (opts) => inv('ar:listLogs', opts),
    logCount: (opts) => inv('ar:logCount', opts),
    stats: (opts) => inv('ar:stats', opts),
    resetSession: (a, p) => inv('ar:resetSession', a, p),
    test: (payload) => inv('ar:test', payload),
    simulate: (payload) => inv('autoreply:simulate', payload),
  },

  sw: {
    groups: () => inv('sw:groups'),
    addGroup: (p) => inv('sw:addGroup', p),
    deleteGroup: (id) => inv('sw:deleteGroup', id),
    list: (f) => inv('sw:list', f),
    add: (p) => inv('sw:add', p),
    update: (id, patch) => inv('sw:update', id, patch),
    delete: (id) => inv('sw:delete', id),
    reload: () => inv('sw:reload'),
    preview: (text, scene) => inv('sw:preview', text, scene),
    rewrite: (text, scene, opts) => inv('sw:rewrite', text, scene, opts),
    templates: (opts) => inv('sw:templates', opts),
    stats: (opts) => inv('sw:stats', opts),
    clearHits: () => inv('sw:clearHits'),
  },

  app: {
    info: () => inv('app:info'),
    openDataDir: () => inv('app:openDataDir'),
    openLogs: () => inv('app:openLogs'),
    exportDiagnostics: () => inv('app:exportDiagnostics'),
    backupData: () => inv('app:backupData'),
    listBackups: () => inv('app:listBackups'),
    openBackups: () => inv('app:openBackups'),
    restoreData: (backupPath) => inv('app:restoreData', backupPath),
  },

  // 事件订阅（主进程 → 渲染层推送）
  on: (channel, cb) => {
    const allowed = [
      'login:qr', 'login:status', 'login:error', 'login:verification', 'login:done',
      'login:sms', 'login:voice', 'login:sms-required', 'login:accounts',
      'accounts:changed', 'message:new', 'message:recall', 'account:offline', 'account:reconnecting',
      'sender:progress', 'autoreply:event', 'monitor:event',
      'upd:event',
    ];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
