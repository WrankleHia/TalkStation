const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const API_BASE = 'http://127.0.0.1:3210';
const DATA_VERSION = '2';
const SOCKET_RECONNECT_DELAY = 2500;
const TOAST_DURATION = 2200;
const MAX_IMAGE_SIZE = 15 * 1024 * 1024; // 15MB
const MAX_FILE_SIZE = 40 * 1024 * 1024; // 40MB
const MAX_VOICE_SECONDS = 60;

let authToken = localStorage.getItem('linktalk_token') || '';
let liveSocket = null;
let pendingFriendRequests = [];
let session = null; // 当前登录用户信息
let listFilter = 'all';

// 本地持久化状态
let state = JSON.parse(localStorage.getItem('linktalk_state') || 'null') || {
  conversations: [],
  openTabs: [],
  activeId: null,
  mutedConversationIds: [],
  conversationOrder: []
};
state.mutedConversationIds ||= [];
state.conversationOrder ||= [];
state.conversations = (state.conversations || []).filter(Boolean);

// 音频播放全局
let playingAudio = null;
let playingButton = null;
let mediaRecorder = null;
let recordStart = 0;
let recordTimer = null;
let voiceChunks = [];

// 弹窗组件
let messageMenu = null;
let imageViewer = null;
const saveState = () => {
  localStorage.setItem('linktalk_state', JSON.stringify(state));
};

const escapeHtml = (s = '') => {
  return s.replace(/[&<>'"]/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[c]));
};

const toast = (text) => {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), TOAST_DURATION);
};

const now = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

const formatTime = (timestamp) => {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
};


const previewMessage = (message) => {
  if (!message) return '暂无消息';
  if (message.recalledAt) return '[消息已撤回]';
  switch (message.type) {
    case 'image': return '[图片]';
    case 'file': return `[文件] ${message.fileName}`;
    case 'voice': return '[语音]';
    default: return message.content;
  }
};


function normalizeMessage(rawMsg) {
  return {
    serverId: rawMsg.id,
    from: rawMsg.senderId === session?.id ? 'me' : 'other',
    sender: rawMsg.sender?.name,
    senderAvatar: rawMsg.sender?.avatar,
    text: rawMsg.content,
    time: formatTime(rawMsg.createdAt),
    createdAt: rawMsg.createdAt,
    kind: rawMsg.type === 'text' ? undefined : rawMsg.type,
    url: rawMsg.fileUrl,
    fileName: rawMsg.fileName,
    duration: rawMsg.duration,
    recalledAt: rawMsg.recalledAt
  };
}

/**
 * Blob转base64 DataURL
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
const blobToDataUrl = (blob) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const response = await fetch(API_BASE + path, {
    ...options,
    headers
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `请求失败 (${response.status})`);
  }
  return data;
}

if (localStorage.getItem('linktalk_data_version') !== DATA_VERSION) {
  localStorage.removeItem('linktalk_state');
  localStorage.removeItem('linktalk_token');
  localStorage.setItem('linktalk_data_version', DATA_VERSION);
  authToken = '';
}

//用户身份更新
function updateIdentity(name, guest = false) {
  $('#current-name').textContent = name;
  $('#identity-label').textContent = guest ? '游客 · 功能受限' : '在线';

  $$('.me').forEach(el => {
    const textNode = [...el.childNodes].find(node => node.nodeType === Node.TEXT_NODE);
    if (textNode) {
      textNode.nodeValue = guest ? '游' : (name?.[0] || '我');
    }
  });
}

// 登录逻辑
async function login(name, guest = false, credentials = null) {
  try {
    let result;
    if (guest) {
      result = await api('/api/auth/guest', {
        method: 'POST',
        body: '{}'
      });
    } else {
      result = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(credentials)
      });
    }

    authToken = result.token;
    localStorage.setItem('linktalk_token', authToken);
    session = { ...result.user, guest };

    if (!guest) {
      await syncFromServer();
      await refreshFriendRequests();
    }
    connectSocket();
  } catch (error) {
    if (!guest) {
      toast(error.message);
      return;
    }
    session = { name, guest: true };
  }

  name = session.name;
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  updateIdentity(name, guest);
  render();

  if (guest) {
    toast('已进入游客模式，登录后可使用聊天功能');
  }
}

async function syncFromServer() {
  const { conversations } = await api('/api/conversations');
  const normalized = [];

  for (const c of conversations) {
    const { messages } = await api(`/api/conversations/${c.id}/messages`);
    const colorPool = ['blue', 'pink', 'orange', 'green'];

    normalized.push({
      id: c.id,
      name: c.name,
      avatar: c.avatar,
      color: c.type === 'group' ? 'purple' : colorPool[normalized.length % 4],
      type: c.type === 'group' ? 'group' : 'friend',
      members: c.members.length,
      online: c.type === 'direct' && c.members.some(x => x.id !== session?.id && x.status === 'online'),
      preview: previewMessage(c.lastMessage),
      time: c.lastMessage ? formatTime(c.lastMessage.createdAt) : '',
      unread: 0,
      messages: messages.map(normalizeMessage)
    });
  }

  // 按用户拖拽保存的顺序排序会话
  const savedOrder = state.conversationOrder;
  normalized.sort((a, b) => {
    const ai = savedOrder.indexOf(a.id);
    const bi = savedOrder.indexOf(b.id);
    if (ai < 0 && bi < 0) return 0;
    if (ai < 0) return 1;
    if (bi < 0) return -1;
    return ai - bi;
  });

  state.conversations = normalized;
  if (!state.conversations.some(x => x.id === state.activeId)) {
    state.activeId = normalized[0]?.id || null;
  }

  // 清理已经不存在会话的tab
  state.openTabs = state.openTabs.filter(id => normalized.some(x => x.id === id));
  if (state.activeId && !state.openTabs.includes(state.activeId)) {
    state.openTabs.push(state.activeId);
  }
  saveState();
}

function connectSocket() {
  liveSocket?.close();
  liveSocket = new WebSocket(`ws://127.0.0.1:3210/ws?token=${encodeURIComponent(authToken)}`);

  liveSocket.onmessage = (e) => {
    try {
      const { event, data } = JSON.parse(e.data);
      handleSocketEvent(event, data);
    } catch { }
  };

  liveSocket.onclose = () => {
    if (session && !session.guest) {
      setTimeout(connectSocket, SOCKET_RECONNECT_DELAY);
    }
  };
}

//处理websocket推送事件

function handleSocketEvent(event, data) {
  switch (event) {
    case 'message': {
      const conversation = state.conversations.find(x => x.id === data.conversationId);
      if (!conversation) break;
      // 去重
      const existMsg = conversation.messages.some(x => x.serverId === data.id);
      if (existMsg) break;

      conversation.messages.push(normalizeMessage(data));
      conversation.preview = previewMessage(data);
      conversation.time = formatTime(data.createdAt);
      if (state.activeId !== conversation.id) {
        conversation.unread = (conversation.unread || 0) + 1;
      }
      saveState();
      render();
      break;
    }
    case 'message_recalled': {
      const conversation = state.conversations.find(x => x.id === data.conversationId);
      const msg = conversation?.messages.find(x => x.serverId === data.id);
      if (!msg) break;
      msg.recalledAt = data.recalledAt;
      msg.text = '';
      conversation.preview = '[消息已撤回]';
      saveState();
      render();
      break;
    }
    case 'conversation_created':
    case 'friend_accepted':
      syncFromServer().then(render);
      break;
    case 'friend_request':
      refreshFriendRequests();
      toast(`${data.from.name} 请求添加你为好友`);
      break;
  }
}

// ===================== 游客权限校验 =====================
function requireLogin(actionName) {
  if (!session?.guest) return true;
  showModal(`
    <div class="guest-lock">
      <div class="lock-icon">🔒</div>
      <h2>登录后使用${actionName}</h2>
      <p>游客模式仅支持浏览。注册或登录账号，即可添加好友、聊天和传输文件。</p>
      <button class="primary wide" onclick="backToLogin()">立即登录</button>
    </div>
  `);
  return false;
}

window.backToLogin = () => {
  closeModal();
  logout();
};

function logout() {
  session = null;
  authToken = '';
  localStorage.removeItem('linktalk_token');
  liveSocket?.close();
  liveSocket = null;
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
}

function render() {
  renderList();
  renderTabs();
  renderChat();
}

//渲染左侧会话列表
function renderList(filterKeyword = '') {
  const view = $('.rail-btn.active')?.dataset.view || 'messages';
  let list = [...state.conversations];

  // 侧边视图过滤
  if (view === 'contacts') list = list.filter(x => x.type === 'friend');
  if (view === 'groups') list = list.filter(x => x.type === 'group');
  if (view === 'files') list = list.filter(x => x.messages.some(m => m.kind === 'file' || m.kind === 'image'));

  // 顶部筛选标签
  if (listFilter === 'unread') list = list.filter(x => (x.unread || 0) > 0);
  if (listFilter === 'group') list = list.filter(x => x.type === 'group');

  // 搜索过滤
  if (filterKeyword) {
    const kw = filterKeyword.toLowerCase();
    list = list.filter(x =>
      x.name.toLowerCase().includes(kw) || x.preview.includes(kw)
    );
  }

  const container = $('#conversation-list');
  if (!list.length) {
    container.innerHTML = getEmptyListHtml();
    return;
  }

  container.innerHTML = list.map((c, index) => buildConversationItemHtml(c, index)).join('');
  bindConversationListEvents(container);
}

function getEmptyListHtml() {
  if (listFilter === 'unread') {
    return `<div class="list-empty"><span>⌁</span><strong>没有未读消息</strong><p>切换到“全部”查看其他会话</p></div>`;
  }
  if (listFilter === 'group') {
    return `<div class="list-empty"><span>⌁</span><strong>还没有群聊</strong><p>切换到“全部”查看其他会话</p></div>`;
  }
  return `<div class="list-empty"><span>⌁</span><strong>这里还很安静</strong><p>点击右上角 ＋ 添加好友</p></div>`;
}

function buildConversationItemHtml(c, index) {
  return `
    <div class="conversation ${c.id === state.activeId ? 'active' : ''}"
         draggable="true"
         style="--i:${index}"
         data-id="${c.id}">
      <div class="avatar ${c.color}">
        ${c.avatar}
        ${c.online ? '<span class="online-dot"></span>' : ''}
      </div>
      <div class="conv-body">
        <div class="conv-top">
          <strong>${escapeHtml(c.name)}</strong>
          <time>${c.time}</time>
        </div>
        <div class="conv-bottom">
          <p>${escapeHtml(c.preview)}</p>
          ${c.unread ? `<span class="badge">${c.unread}</span>` : ''}
        </div>
      </div>
    </div>
  `;
}

function bindConversationListEvents(container) {
  $$('.conversation').forEach(el => {
    el.onclick = () => openChat(el.dataset.id);

    el.ondragstart = (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', el.dataset.id);
      requestAnimationFrame(() => el.classList.add('dragging'));
    };

    el.ondragover = (e) => {
      e.preventDefault();
      const dragged = container.querySelector('.conversation.dragging');
      if (!dragged || dragged === el) return;
      const after = e.clientY > el.getBoundingClientRect().top + el.offsetHeight / 2;
      container.insertBefore(dragged, after ? el.nextSibling : el);
    };

    el.ondragend = () => {
      el.classList.remove('dragging');
      const visibleIds = [...container.querySelectorAll('.conversation')].map(x => x.dataset.id);
      const visibleSet = new Set(visibleIds);
      const reordered = visibleIds
        .map(id => state.conversations.find(c => c.id === id))
        .filter(Boolean);

      let cursor = 0;
      state.conversations = state.conversations
        .map(c => visibleSet.has(c.id) ? reordered[cursor++] : c)
        .filter(Boolean);
      state.conversationOrder = state.conversations.map(c => c.id);
      saveState();
      renderList($('#search').value);
    };
  });
}

/**
 * 渲染顶部Tab栏
 */
function renderTabs() {
  const bar = $('#chat-tabs');
  bar.innerHTML = state.openTabs
    .map(id => {
      const c = state.conversations.find(x => x.id === id);
      if (!c) return '';
      return `
        <button class="chat-tab ${id === state.activeId ? 'active' : ''}" draggable="true" data-id="${id}">
          <i class="tab-dot"></i>
          <span>${escapeHtml(c.name)}</span>
          <i class="tab-close" data-close="${id}">×</i>
        </button>
      `;
    })
    .join('');

  bindTabEvents(bar);
  initTopBarTilt();
}

function bindTabEvents(bar) {
  $$('.chat-tab').forEach(t => {
    t.onclick = (e) => {
      if (e.target.dataset.close) {
        return closeTab(e.target.dataset.close);
      }
      openChat(t.dataset.id);
    };

    t.ondragstart = (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', t.dataset.id);
      requestAnimationFrame(() => t.classList.add('dragging'));
    };

    t.ondragend = () => {
      t.classList.remove('dragging');
      $$('.chat-tab').forEach(x => x.classList.remove('drag-over'));
      state.openTabs = [...bar.querySelectorAll('.chat-tab')].map(x => x.dataset.id);
      saveState();
      renderTabs();
    };

    t.ondragover = (e) => {
      e.preventDefault();
      const dragged = bar.querySelector('.chat-tab.dragging');
      if (!dragged || dragged === t) return;
      const after = e.clientX > t.getBoundingClientRect().left + t.offsetWidth / 2;
      bar.insertBefore(dragged, after ? t.nextSibling : t);
      $$('.chat-tab').forEach(x => x.classList.remove('drag-over'));
      t.classList.add('drag-over');
    };

    t.ondrop = (e) => {
      e.preventDefault();
      $$('.chat-tab').forEach(x => x.classList.remove('drag-over'));
    };
  });
}

/**
 * Tab 悬浮3D倾斜效果
 */
function initTopBarTilt() {
  $$('.chat-tab').forEach(tab => {
    let frame = 0;
    tab.onpointermove = (e) => {
      if (tab.classList.contains('dragging') || e.buttons) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = tab.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width - 0.5;
        const y = (e.clientY - rect.top) / rect.height - 0.5;
        tab.style.transform = `perspective(520px) rotateX(${-y * 5}deg) rotateY(${x * 7}deg) translateY(-1px)`;
        tab.style.setProperty('--tilt-x', `${50 + x * 35}%`);
        tab.style.setProperty('--tilt-y', `${50 + y * 45}%`);
      });
    };
    tab.onpointerleave = () => {
      cancelAnimationFrame(frame);
      if (!tab.classList.contains('dragging')) tab.style.transform = '';
    };
    const previousDragStart = tab.ondragstart;
    tab.ondragstart = (e) => {
      tab.style.transform = '';
      previousDragStart(e);
    };
  });
}

function openChat(id) {
  const c = state.conversations.find(x => x.id === id);
  if (!c) return;
  if (!state.openTabs.includes(id)) state.openTabs.push(id);
  state.activeId = id;
  c.unread = 0;
  saveState();
  render();
}

function closeTab(id) {
  state.openTabs = state.openTabs.filter(x => x !== id);
  if (state.activeId === id) {
    state.activeId = state.openTabs.at(-1) || null;
  }
  saveState();
  render();
}

/**
 * 渲染聊天消息面板
 */
function renderChat() {
  const c = state.conversations.find(x => x.id === state.activeId);
  const hasConversation = !!c;

  $('#chat').classList.toggle('hidden', !hasConversation);
  $('#empty-chat').classList.toggle('hidden', hasConversation);
  if (!c) return;

  $('#chat-name').textContent = c.name;
  $('#chat-avatar').textContent = c.avatar;
  $('#chat-avatar').className = `avatar ${c.color}`;
  $('#chat-status').textContent = c.type === 'group' ? `${c.members} 位成员` : c.online ? '在线' : '离线';

  $('#messages').innerHTML = `<div class="date-sep">今天</div>`
    + c.messages.map(m => messageHtml(m, c)).join('');

  // 滚动到底部
  $('#messages').scrollTop = $('#messages').scrollHeight;

  // 绑定消息内元素事件
  $$('#messages [data-image-url]').forEach(el => {
    el.onclick = () => showImagePreview(el.dataset.imageUrl);
  });
  $$('#messages [data-file-url]').forEach(el => {
    el.onclick = async () => {
      el.disabled = true;
      toast('正在准备文件…');
      try {
        if (!window.desktop?.openUploadedFile) {
          throw new Error('桌面功能尚未加载，请完全退出后重新启动应用');
        }
        await window.desktop.openUploadedFile(el.dataset.fileUrl, el.dataset.fileName);
        toast('已使用默认应用打开');
      } catch (error) {
        toast(error.message || '无法打开文件');
      } finally {
        el.disabled = false;
      }
    };
  });
  $$('#messages [data-audio]').forEach(el => el.onclick = () => playVoice(el));
  $$('#messages .message.mine[data-message-id]').forEach(el => {
    el.oncontextmenu = (e) => {
      e.preventDefault();
      showMessageMenu(e.clientX, e.clientY, el.dataset.messageId);
    };
  });
}

/**
 * 播放语音消息
 */
function playVoice(button) {
  if (playingAudio) {
    playingAudio.pause();
    playingAudio = null;
    if (playingButton) playingButton.textContent = '▶';
    if (playingButton === button) {
      playingButton = null;
      return;
    }
  }
  const audio = new Audio(button.dataset.audio);
  playingAudio = audio;
  playingButton = button;
  button.textContent = '■';
  audio.play().catch(() => toast('语音播放失败'));

  audio.onended = audio.onerror = () => {
    button.textContent = '▶';
    playingAudio = null;
    playingButton = null;
  };
}

function messageHtml(m, c) {
  if (m.recalledAt) {
    const tip = m.from === 'me' ? '你撤回了一条消息' : `${escapeHtml(m.sender || c.name)}撤回了一条消息`;
    return `<div class="recalled-message">${tip}</div>`;
  }

  let body = escapeHtml(m.text || '').replace(/\n/g, '<br>');
  if (m.kind === 'image') {
    body = `<button class="image-open" data-image-url="${escapeHtml(m.url || '')}">
      <img src="${escapeHtml(m.url || '')}" alt="发送的图片">
    </button>`;
  }
  if (m.kind === 'file') {
    body = `<button class="file-card"
      data-file-url="${escapeHtml(m.url || '')}"
      data-file-name="${escapeHtml(m.fileName || '文件')}">
        <span class="file-icon">⌑</span>
        <div>
          <strong>${escapeHtml(m.fileName)}</strong>
          <small>点击使用默认应用打开</small>
        </div>
      </button>`;
  }
  if (m.kind === 'voice') {
    if (m.url) {
      body = `<div class="voice-bubble">
        <button class="voice-play" data-audio="${escapeHtml(m.url)}">▶</button>
        <span class="voice-wave">▮▯▮▮▯▮</span>
        <span>${m.duration || 1}″</span>
      </div>`;
    } else {
      body = `<div class="voice-bubble"><span>语音文件不可用</span></div>`;
    }
  }

  const avatar = m.from === 'me'
    ? (session?.avatar || session?.name?.[0] || '我')
    : (m.senderAvatar || m.sender?.[0] || c.avatar);

  return `
    <div class="message ${m.from === 'me' ? 'mine' : ''}"
      ${m.serverId ? `data-message-id="${m.serverId}"` : ''}>
      ${m.from === 'me' ? '' : `<div class="avatar ${c.color}">${avatar}</div>`}
      <div class="bubble-wrap">
        ${m.sender ? `<p class="sender">${escapeHtml(m.sender)}</p>` : ''}
        <div class="bubble ${m.kind || ''}">${body}</div>
        <div class="msg-time">${m.time}</div>
      </div>
      ${m.from === 'me' ? `<div class="avatar me">${avatar}</div>` : ''}
    </div>
  `;
}

// 消息右键菜单
function showMessageMenu(x, y, messageId) {
  messageMenu?.remove();
  messageMenu = document.createElement('div');
  messageMenu.className = 'message-menu';
  messageMenu.innerHTML = '<button>↩ 撤回消息</button>';
  document.body.appendChild(messageMenu);

  const left = Math.min(x, window.innerWidth - 145);
  const top = Math.min(y, window.innerHeight - 55);
  messageMenu.style.left = `${left}px`;
  messageMenu.style.top = `${top}px`;

  messageMenu.querySelector('button').onclick = () => recallMessage(messageId);
}

async function recallMessage(messageId) {
  messageMenu?.remove();
  messageMenu = null;
  try {
    const { message } = await api(`/api/messages/${messageId}/recall`, {
      method: 'POST',
      body: '{}'
    });
    const c = state.conversations.find(x => x.id === message.conversationId);
    const localMsg = c?.messages.find(x => x.serverId === message.id);
    if (localMsg) {
      localMsg.recalledAt = message.recalledAt;
      localMsg.text = '';
      c.preview = '[消息已撤回]';
      saveState();
      render();
    }
    toast('消息已撤回');
  } catch (error) {
    toast(error.message);
  }
}

// 图片预览弹窗
function showImagePreview(url) {
  imageViewer?.remove();
  let scale = 1;
  imageViewer = document.createElement('div');
  imageViewer.className = 'image-viewer';
  imageViewer.innerHTML = `
    <div class="image-viewer-toolbar">
      <button data-action="minus" title="缩小">−</button>
      <span>100%</span>
      <button data-action="plus" title="放大">＋</button>
      <button data-action="close" title="关闭">×</button>
    </div>
    <div class="image-viewer-stage">
      <img src="${escapeHtml(url)}" alt="图片预览">
    </div>
  `;
  document.body.appendChild(imageViewer);

  const img = imageViewer.querySelector('img');
  const label = imageViewer.querySelector('span');
  const applyScale = () => {
    img.style.transform = `scale(${scale})`;
    label.textContent = `${Math.round(scale * 100)}%`;
  };

  imageViewer.querySelector('[data-action=minus]').onclick = () => {
    scale = Math.max(0.5, scale - 0.25);
    applyScale();
  };
  imageViewer.querySelector('[data-action=plus]').onclick = () => {
    scale = Math.min(3, scale + 0.25);
    applyScale();
  };
  imageViewer.querySelector('[data-action=close]').onclick = closeImagePreview;
  img.onclick = () => {
    scale = scale === 1 ? 1.75 : 1;
    applyScale();
  };
  imageViewer.onclick = (e) => {
    if (e.target.classList.contains('image-viewer-stage')) closeImagePreview();
  };
  imageViewer.onwheel = (e) => {
    e.preventDefault();
    scale = Math.min(3, Math.max(0.5, scale + (e.deltaY < 0 ? 0.15 : -0.15)));
    applyScale();
  };
}

function closeImagePreview() {
  imageViewer?.remove();
  imageViewer = null;
}

// 发送消息
async function sendMessage(payload) {
  if (!requireLogin('聊天')) return;
  const c = state.conversations.find(x => x.id === state.activeId);
  if (!c) return;

  const m = typeof payload === 'string' ? { text: payload } : payload;
  if (!m.text && !m.kind) return;

  try {
    const body = {
      type: m.kind || 'text',
      content: m.text || '',
      fileName: m.fileName,
      fileUrl: m.url,
      duration: m.duration
    };
    const { message } = await api(`/api/conversations/${c.id}/messages`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    const normalized = normalizeMessage(message);
    c.messages.push(normalized);
    c.preview = previewMessage(message);
    c.time = formatTime(message.createdAt);
    saveState();
    renderChat();
    renderList();
  } catch (error) {
    // 离线本地
    m.from = 'me';
    m.time = now();
    c.messages.push(m);
    c.preview = m.text || '[消息]';
    c.time = m.time;
    saveState();
    renderChat();
    renderList();
    toast('服务器未连接，消息仅保存在本机');
  }
}

function showModal(html) {
  $('#modal-content').innerHTML = html;
  $('#modal').classList.remove('hidden');
}
function closeModal() {
  $('#modal').classList.add('hidden');
}

// 好友相关
async function refreshFriendRequests() {
  if (!session || session.guest) return;
  try {
    const data = await api('/api/friends');
    pendingFriendRequests = data.requests || [];
    const badge = $('#request-badge');
    badge.textContent = pendingFriendRequests.length;
    badge.classList.toggle('hidden', !pendingFriendRequests.length);
  } catch { }
}

function requestListHtml() {
  if (!pendingFriendRequests.length) return '';
  return `
    <div class="request-section">
      <div class="request-title">
        <strong>好友申请</strong>
        <span>${pendingFriendRequests.length} 条待处理</span>
      </div>
      ${pendingFriendRequests.map(r => `
        <div class="friend-request">
          <div class="avatar blue">${escapeHtml(r.fromUser?.avatar || '?')}</div>
          <div>
            <strong>${escapeHtml(r.fromUser?.name || '未知用户')}</strong>
            <p>${escapeHtml(r.message || '请求添加你为好友')}</p>
          </div>
          <button class="accept-request" data-request-id="${r.id}">接受</button>
        </div>
      `).join('')}
    </div>
  `;
}

function bindRequestActions() {
  $$('.accept-request').forEach(btn => {
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = '处理中';
      try {
        const { conversation } = await api(`/api/friends/request/${btn.dataset.requestId}/accept`, {
          method: 'POST',
          body: '{}'
        });
        await refreshFriendRequests();
        await syncFromServer();
        state.activeId = conversation.id;
        if (!state.openTabs.includes(conversation.id)) state.openTabs.push(conversation.id);
        saveState();
        closeModal();
        render();
        toast('已添加好友，可以开始聊天了');
      } catch (error) {
        btn.disabled = false;
        btn.textContent = '接受';
        toast(error.message);
      }
    };
  });
}

function showAdd() {
  if (!requireLogin('好友与群聊功能')) return;
  refreshFriendRequests().then(() => {
    showModal(`
      <h2>联系人</h2>
      <p>处理好友申请，或发起新的连接。</p>
      ${requestListHtml()}
      <div class="modal-option">
        <button id="choose-friend">＋<br>添加好友</button>
        <button id="choose-group">♧<br>创建群聊</button>
      </div>
    `);
    bindRequestActions();
    $('#choose-friend').onclick = showAddFriend;
    $('#choose-group').onclick = showCreateGroup;
  });
}

function showAddFriend() {
  showModal(`
    <h2>添加好友</h2>
    <p>输入对方的 TalkStation 账号</p>
    <label>好友账号</label>
    <input id="friend-account" placeholder="请输入对方账号">
    <label>验证消息</label>
    <textarea id="verify-msg">你好，我想添加你为好友。</textarea>
    <button id="confirm-friend" class="primary wide">发送好友申请</button>
  `);

  $('#confirm-friend').onclick = async () => {
    const account = $('#friend-account').value.trim();
    if (!account) return toast('请输入好友账号');
    try {
      await api('/api/friends/request', {
        method: 'POST',
        body: JSON.stringify({
          account,
          message: $('#verify-msg').value
        })
      });
      closeModal();
      toast(`好友申请已发送给 ${account}`);
    } catch (error) {
      toast(error.message);
    }
  };
}

async function showCreateGroup() {
  try {
    const { friends } = await api('/api/friends');
    showModal(`
      <h2>创建群聊</h2>
      <p>选择至少两位好友加入群聊</p>
      <label>群聊名称</label>
      <input id="group-name" value="新的群聊">
      <label>选择成员</label>
      <div class="member-select">
        ${friends.map(f => `<label><input type="checkbox" value="${f.id}"> ${f.name}</label>`).join('')}
      </div>
      <button id="confirm-group" class="primary wide">创建群聊</button>
    `);

    $('#confirm-group').onclick = async () => {
      const memberIds = $$('#modal input[type=checkbox]:checked').map(x => x.value);
      if (memberIds.length < 2) return toast('请至少选择两位好友');
      const name = $('#group-name').value.trim() || '新的群聊';
      try {
        const { conversation } = await api('/api/conversations/group', {
          method: 'POST',
          body: JSON.stringify({ name, memberIds })
        });
        await syncFromServer();
        state.activeId = conversation.id;
        if (!state.openTabs.includes(conversation.id)) state.openTabs.push(conversation.id);
        saveState();
        closeModal();
        render();
        toast('群聊创建成功');
      } catch (error) {
        toast(error.message);
      }
    };
  } catch (error) {
    toast(error.message);
  }
}

// 文件上传
async function uploadData(name, data) {
  let mime, base64;
  if (typeof data === 'string') {
    const comma = data.indexOf(',');
    if (comma < 0) throw new Error('无法读取文件数据');
    mime = data.slice(5, comma).split(';')[0];
    base64 = data.slice(comma + 1);
  } else {
    ({ mime, base64 } = data || {});
  }
  if (!base64) throw new Error('文件读取失败');

  return api('/api/upload', {
    method: 'POST',
    body: JSON.stringify({ name, mime, base64 })
  });
}

//文件选择框

function chooseFile(type) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    if (type === 'image') {
      input.accept = 'image/png,image/jpeg,image/gif,image/webp';
    }
    input.style.display = 'none';
    document.body.appendChild(input);
    let settled = false;

    const finish = (file) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file || null);
    };
    input.onchange = () => finish(input.files?.[0]);
    window.addEventListener('focus', () => setTimeout(() => finish(input.files?.[0]), 400), { once: true });
    input.click();
  });
}

async function uploadPickedFile(type) {
  const actionName = type === 'image' ? '图片发送' : '文件发送';
  if (!requireLogin(actionName)) return;

  const button = type === 'image' ? $('#image-btn') : $('#file-btn');
  try {
    const file = await chooseFile(type);
    if (!file) return;

    const limit = type === 'image' ? MAX_IMAGE_SIZE : MAX_FILE_SIZE;
    if (file.size > limit) {
      toast(`${type === 'image' ? '图片' : '文件'}不能超过 ${limit / 1024 / 1024} MB`);
      return;
    }

    button.disabled = true;
    toast('正在上传，请稍候…');
    const data = await blobToDataUrl(file);
    const uploaded = await uploadData(file.name, data);
    await sendMessage({
      kind: type,
      fileName: uploaded.name,
      url: uploaded.url
    });
    toast('上传完成');
  } catch (error) {
    console.error('Upload failed:', error);
    toast(error.message || '上传失败，请确认服务器正在运行');
  } finally {
    button.disabled = false;
  }
}

// 语音录制
async function startVoiceRecording() {
  if (!requireLogin('语音发送')) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voiceChunks = [];
    let mimeType = '';
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
      mimeType = 'audio/webm;codecs=opus';
    }
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size) voiceChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      clearTimeout(recordTimer);
      const duration = Math.max(1, Math.min(MAX_VOICE_SECONDS, Math.round((Date.now() - recordStart) / 1000)));
      const blob = new Blob(voiceChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      mediaRecorder = null;
      $('#voice-btn').textContent = '♬';
      $('#voice-btn').classList.remove('recording');

      try {
        toast('正在发送语音…');
        const data = await blobToDataUrl(blob);
        const uploaded = await uploadData(`voice-${Date.now()}.webm`, data);
        await sendMessage({
          kind: 'voice',
          duration,
          url: uploaded.url,
          fileName: uploaded.name
        });
        toast('语音已发送');
      } catch (error) {
        toast(error.message);
      }
    };

    mediaRecorder.start(250);
    recordStart = Date.now();
    $('#voice-btn').textContent = '■';
    $('#voice-btn').classList.add('recording');
    toast('正在录音，再次点击结束（最长 60 秒）');
    recordTimer = setTimeout(stopVoiceRecording, MAX_VOICE_SECONDS * 1000);
  } catch (error) {
    if (error.name === 'NotAllowedError') {
      toast('请在系统设置中允许 TalkStation 使用麦克风');
    } else {
      toast('无法启动麦克风');
    }
  }
}

function stopVoiceRecording() {
  if (mediaRecorder?.state === 'recording') {
    mediaRecorder.stop();
  }
}

// 聊天记录搜索
function showChatSearch(c) {
  showModal(`
    <h2>查找聊天记录</h2>
    <p>在与 ${escapeHtml(c.name)} 的对话中搜索</p>
    <div class="record-search">
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m16 16 4 4"/></svg>
      <input id="record-search-input" placeholder="输入关键词" autofocus>
    </div>
    <div id="record-search-results" class="record-search-results">
      <div class="search-hint">输入内容开始搜索</div>
    </div>
  `);

  const input = $('#record-search-input');
  const results = $('#record-search-results');

  const runSearch = () => {
    const q = input.value.trim().toLocaleLowerCase();
    if (!q) {
      results.innerHTML = '<div class="search-hint">输入内容开始搜索</div>';
      return;
    }
    const found = c.messages.filter(m => {
      if (m.recalledAt) return false;
      const fullText = `${m.text || ''} ${m.fileName || ''} ${m.sender || ''}`.toLocaleLowerCase();
      return fullText.includes(q);
    });

    if (!found.length) {
      results.innerHTML = '<div class="search-hint">没有找到相关消息</div>';
      return;
    }
    results.innerHTML = found.map(m => `
      <button class="record-result" data-message-id="${m.serverId || ''}">
        <strong>${escapeHtml(m.from === 'me' ? '我' : m.sender || c.name)}</strong>
        <span>${escapeHtml(m.text || m.fileName || (m.kind === 'image' ? '[图片]' : m.kind === 'voice' ? '[语音]' : '[消息]'))}</span>
        <time>${m.time}</time>
      </button>
    `).join('');

    $$('.record-result').forEach(btn => {
      btn.onclick = () => {
        closeModal();
        const target = document.querySelector(`.message[data-message-id="${CSS.escape(btn.dataset.messageId)}"]`);
        target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target?.classList.add('message-highlight');
        setTimeout(() => target?.classList.remove('message-highlight'), 1600);
      };
    });
  };

  input.oninput = runSearch;
  setTimeout(() => input.focus(), 50);
}

// ===================== 会话菜单（免打扰、搜索记录） =====================
function showConversationMenu() {
  const c = state.conversations.find(x => x.id === state.activeId);
  if (!c) return;
  const muted = state.mutedConversationIds.includes(c.id);

  showModal(`
    <h2>${escapeHtml(c.name)}</h2>
    <p>${c.type === 'group' ? `${c.members} 位群成员` : (c.online ? '当前在线' : '当前离线')}</p>
    <div class="modal-option conversation-options">
      <button id="search-records-btn"><span>⌕</span>查找聊天记录</button>
      <button id="mute-chat-btn" class="${muted ? 'enabled' : ''}">
        <span>${muted ? '🔕' : '♩'}</span>${muted ? '已开启免打扰' : '消息免打扰'}
      </button>
    </div>
    <button class="guest wide" id="close-chat-info">关闭</button>
  `);

  $('#search-records-btn').onclick = () => showChatSearch(c);
  $('#mute-chat-btn').onclick = () => {
    const index = state.mutedConversationIds.indexOf(c.id);
    if (index >= 0) {
      state.mutedConversationIds.splice(index, 1);
      toast('已关闭消息免打扰');
    } else {
      state.mutedConversationIds.push(c.id);
      toast('已开启消息免打扰');
    }
    saveState();
    showConversationMenu();
  };
  $('#close-chat-info').onclick = closeModal;
}

// 页面全局事件绑定
$('#more-btn').onclick = showConversationMenu;
$('#profile-btn').onclick = () => showModal(`
  <h2>${session?.name || '用户'}</h2>
  <p>TalkStation ID：TS-${session?.id?.slice(-8) || 'USER'}</p>
  <label>个性签名</label>
  <input value="保持热爱，奔赴山海">
  <button class="primary wide" onclick="document.querySelector('.modal-close').click();">保存资料</button>
`);

$('#settings-btn').onclick = () => showModal(`
  <h2>设置</h2>
  <p>自定义你的 TalkStation 使用体验</p>
  <label>通知设置</label>
  <div class="member-select">
    <label><input type="checkbox" checked> 新消息通知</label>
    <label><input type="checkbox" checked> 声音提醒</label>
  </div>
  <label>隐私与安全</label>
  <div class="member-select">
    <label><input type="checkbox" checked> 允许好友搜索</label>
    <label><input type="checkbox"> 自动下载文件</label>
  </div>
  <button class="primary wide" onclick="document.querySelector('.modal-close').click();">完成</button>
`);

// 登录注册表单切换
$$('[data-auth-tab]').forEach(btn => {
  btn.onclick = () => {
    $$('[data-auth-tab]').forEach(x => x.classList.toggle('active', x === btn));
    $('#login-form').classList.toggle('hidden', btn.dataset.authTab !== 'login');
    $('#register-form').classList.toggle('hidden', btn.dataset.authTab !== 'register');
  };
});

$('#login-form').onsubmit = (e) => {
  e.preventDefault();
  login('', false, {
    account: $('#login-account').value.trim(),
    password: $('#login-password').value
  });
};
$('#guest-login').onclick = () => login('游客', true);

$('#register-form').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('#reg-name').value.trim();
  if ($('#reg-password').value !== $('#reg-confirm').value) {
    return toast('两次输入的密码不一致');
  }
  try {
    const result = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name,
        account: $('#reg-account').value.trim(),
        password: $('#reg-password').value
      })
    });
    authToken = result.token;
    localStorage.setItem('linktalk_token', authToken);
    session = { ...result.user, guest: false };
    await syncFromServer();
    await refreshFriendRequests();
    connectSocket();
    $('#auth').classList.add('hidden');
    $('#app').classList.remove('hidden');
    updateIdentity(name, false);
    render();
    toast('注册成功，欢迎加入 TalkStation');
  } catch (error) {
    toast(error.message);
  }
};

// 密码显示/隐藏
$$('.eye').forEach(x => x.onclick = () => {
  const input = x.previousElementSibling;
  input.type = input.type === 'password' ? 'text' : 'password';
});

$('#logout-btn').onclick = logout;
$('#add-btn').onclick = showAdd;
$('.modal-close').onclick = closeModal;
$('#modal').onclick = e => {
  if (e.target === $('#modal')) closeModal();
};
$('#empty-add-btn').onclick = showAdd;

// 左侧视图切换（消息/联系人/群聊/文件）
$$('.rail-btn[data-view]').forEach(btn => {
  btn.onclick = () => {
    $$('.rail-btn[data-view]').forEach(x => x.classList.toggle('active', x === btn));
    const map = {
      messages: ['消息', '最近会话'],
      contacts: ['联系人', '我的好友'],
      groups: ['群聊', '已加入的群聊'],
      files: ['传输记录', '图片与文件']
    };
    $('#view-title').textContent = map[btn.dataset.view][0];
    $('#status-text').textContent = map[btn.dataset.view][1];
    renderList($('#search').value);
  };
});

$$('.filter-tabs button').forEach(btn => {
  btn.onclick = () => {
    listFilter = btn.dataset.filter;
    $$('.filter-tabs button').forEach(x => x.classList.toggle('active', x === btn));
    renderList($('#search').value);
  };
});

$('#search').oninput = e => renderList(e.target.value);
$('#send-btn').onclick = () => {
  const input = $('#message-input');
  const text = input.value.trim();
  if (text) {
    sendMessage(text);
    input.value = '';
  }
};

$('#message-input').onkeydown = e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#send-btn').click();
  }
};

// Emoji面板
const emojis = '😀 😃 😂 😊 😍 😎 🤔 😭 😡 👍 👏 🎉 ❤️ 🌟 🔥'.split(' ');
$('#emoji-panel').innerHTML = emojis.map(x => `<button>${x}</button>`).join('');
$('#emoji-btn').onclick = () => $('#emoji-panel').classList.toggle('hidden');
$$('#emoji-panel button').forEach(b => {
  b.onclick = () => {
    $('#message-input').value += b.textContent;
    $('#emoji-panel').classList.add('hidden');
  };
});

$('#image-btn').onclick = () => uploadPickedFile('image');
$('#file-btn').onclick = () => uploadPickedFile('file');
$('#voice-btn').onclick = () => {
  if (mediaRecorder?.state === 'recording') stopVoiceRecording();
  else startVoiceRecording();
};

// 全局快捷键 点击关闭菜单
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    $('#search').focus();
  }

  if (e.key === 'Escape') {
    if (imageViewer) closeImagePreview();
    else closeModal();
  }
});

document.addEventListener('click', e => {
  if (messageMenu && !messageMenu.contains(e.target)) {
    messageMenu.remove();
    messageMenu = null;
  }
});
