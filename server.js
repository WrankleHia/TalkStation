const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 3210;
const MAX_BODY_SIZE = 64 * 1024 * 1024;
const RECALL_WINDOW_MS = 2 * 60 * 1000;

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

const sessions = new Map();
const sockets = new Map();

const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.webm': 'audio/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
};


function createId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedPassword) {
  if (!storedPassword?.includes(':')) return false;
  const [salt, storedHash] = storedPassword.split(':');
  const actualHash = crypto.scryptSync(password, salt, 64);
  const expectedHash = Buffer.from(storedHash, 'hex');
  return actualHash.length === expectedHash.length
    && crypto.timingSafeEqual(actualHash, expectedHash);
}

function emptyDatabase() {
  return { users: [], friendRequests: [], conversations: [], messages: [] };
}

function loadDatabase() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(emptyDatabase(), null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

let database = loadDatabase();
let saveTimer;

function saveDatabase() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(DB_FILE, JSON.stringify(database, null, 2));
  }, 50);
}


function sendJson(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  });
  response.end(JSON.stringify(data));
}

function parseBody(request, limit = MAX_BODY_SIZE) {
  return new Promise((resolve, reject) => {
    let rawBody = '';
    request.on('data', (chunk) => {
      rawBody += chunk;
      if (rawBody.length > limit) {
        reject(new Error('请求内容过大'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(rawBody ? JSON.parse(rawBody) : {});
      } catch {
        reject(new Error('JSON 格式错误'));
      }
    });
    request.on('error', reject);
  });
}

function matchRoute(pathname, pattern) {
  const pathParts = pathname.split('/').filter(Boolean);
  const patternParts = pattern.split('/').filter(Boolean);
  if (pathParts.length !== patternParts.length) return null;

  const params = {};
  for (let index = 0; index < pathParts.length; index += 1) {
    if (patternParts[index].startsWith(':')) {
      params[patternParts[index].slice(1)] = decodeURIComponent(pathParts[index]);
    } else if (patternParts[index] !== pathParts[index]) {
      return null;
    }
  }
  return params;
}

function authenticatedUser(request) {
  const token = (request.headers.authorization || '').replace(/^Bearer /, '');
  const userId = sessions.get(token);
  return database.users.find((user) => user.id === userId);
}

function requireAuth(request, response) {
  const user = authenticatedUser(request);
  if (!user) sendJson(response, 401, { error: '请先登录' });
  return user;
}


function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    account: user.account,
    name: user.name,
    avatar: user.avatar,
    status: user.status || 'online',
  };
}

function messageView(message) {
  const sender = database.users.find((user) => user.id === message.senderId);
  return { ...message, sender: publicUser(sender) };
}

function conversationView(conversation, currentUserId) {
  const members = conversation.members
    .map((userId) => database.users.find((user) => user.id === userId))
    .filter(Boolean);
  const otherUser = conversation.type === 'direct'
    ? members.find((user) => user.id !== currentUserId)
    : null;
  const lastMessage = [...database.messages]
    .reverse()
    .find((message) => message.conversationId === conversation.id);

  return {
    id: conversation.id,
    type: conversation.type,
    name: conversation.type === 'direct'
      ? otherUser?.name || '未知用户'
      : conversation.name,
    avatar: conversation.type === 'direct'
      ? otherUser?.avatar || '?'
      : conversation.avatar || conversation.name[0],
    members: members.map(publicUser),
    lastMessage: lastMessage ? messageView(lastMessage) : null,
  };
}

function findConversation(conversationId, userId) {
  return database.conversations.find(
    (conversation) => conversation.id === conversationId
      && conversation.members.includes(userId),
  );
}

function findDirectConversation(firstUserId, secondUserId) {
  return database.conversations.find(
    (conversation) => conversation.type === 'direct'
      && conversation.members.includes(firstUserId)
      && conversation.members.includes(secondUserId),
  );
}


async function register(request, response) {
  const body = await parseBody(request);
  const account = String(body.account || '').trim();
  const name = String(body.name || '').trim();
  const password = body.password || '';

  if (!name || !account || !password) {
    return sendJson(response, 400, { error: '请完整填写注册信息' });
  }
  if (password.length < 6) {
    return sendJson(response, 400, { error: '密码至少需要 6 位' });
  }
  if (database.users.some(
    (user) => user.account.toLocaleLowerCase() === account.toLocaleLowerCase(),
  )) {
    return sendJson(response, 409, { error: '账号已存在' });
  }

  const user = {
    id: createId('u'),
    account,
    name,
    avatar: name[0],
    password: hashPassword(password),
    friends: [],
    status: 'online',
  };
  database.users.push(user);
  saveDatabase();

  const token = createId('token');
  sessions.set(token, user.id);
  return sendJson(response, 201, { token, user: publicUser(user) });
}

async function login(request, response) {
  const body = await parseBody(request);
  const account = String(body.account || '').trim().toLocaleLowerCase();
  const user = database.users.find(
    (candidate) => candidate.account.toLocaleLowerCase() === account,
  );

  if (!user || !verifyPassword(body.password || '', user.password)) {
    return sendJson(response, 401, { error: '账号或密码错误' });
  }

  const token = createId('token');
  sessions.set(token, user.id);
  user.status = 'online';
  saveDatabase();
  return sendJson(response, 200, { token, user: publicUser(user) });
}

function guestLogin(_request, response) {
  const guest = {
    id: createId('guest'),
    account: 'guest',
    name: '游客',
    avatar: '游',
    guest: true,
  };
  const token = createId('token');
  sessions.set(token, guest.id);
  return sendJson(response, 200, { token, user: guest });
}


function listFriends(_request, response, user) {
  const friends = (user.friends || [])
    .map((userId) => database.users.find((candidate) => candidate.id === userId))
    .filter(Boolean)
    .map(publicUser);
  const requests = database.friendRequests
    .filter((item) => item.to === user.id && item.status === 'pending')
    .map((item) => ({
      ...item,
      fromUser: publicUser(database.users.find((candidate) => candidate.id === item.from)),
    }));
  return sendJson(response, 200, { friends, requests });
}

async function sendFriendRequest(request, response, user) {
  const body = await parseBody(request);
  const account = String(body.account || '').trim().toLocaleLowerCase();
  const target = database.users.find(
    (candidate) => candidate.account.toLocaleLowerCase() === account,
  );

  if (!target || target.id === user.id) {
    return sendJson(response, 404, { error: '未找到该用户' });
  }
  if (user.friends.includes(target.id)) {
    return sendJson(response, 409, { error: '你们已经是好友' });
  }

  const exists = database.friendRequests.some(
    (item) => item.from === user.id
      && item.to === target.id
      && item.status === 'pending',
  );
  if (!exists) {
    database.friendRequests.push({
      id: createId('fr'),
      from: user.id,
      to: target.id,
      message: body.message || '你好，我想添加你为好友。',
      status: 'pending',
      createdAt: Date.now(),
    });
    saveDatabase();
  }

  broadcast([target.id], 'friend_request', { from: publicUser(user) });
  return sendJson(response, 201, { ok: true });
}

function acceptFriendRequest(_request, response, user, params) {
  const friendRequest = database.friendRequests.find(
    (item) => item.id === params.id && item.to === user.id,
  );
  if (!friendRequest) return sendJson(response, 404, { error: '申请不存在' });

  const requestingUser = database.users.find(
    (candidate) => candidate.id === friendRequest.from,
  );
  if (!requestingUser) return sendJson(response, 404, { error: '申请用户不存在' });

  friendRequest.status = 'accepted';
  if (!user.friends.includes(requestingUser.id)) user.friends.push(requestingUser.id);
  if (!requestingUser.friends.includes(user.id)) requestingUser.friends.push(user.id);

  let conversation = findDirectConversation(user.id, requestingUser.id);
  if (!conversation) {
    conversation = {
      id: createId('c'),
      type: 'direct',
      members: [user.id, requestingUser.id],
      createdAt: Date.now(),
    };
    database.conversations.push(conversation);
  }
  saveDatabase();

  broadcast([requestingUser.id], 'friend_accepted', {
    user: publicUser(user),
    conversation: conversationView(conversation, requestingUser.id),
  });
  return sendJson(response, 200, {
    conversation: conversationView(conversation, user.id),
  });
}


function listConversations(_request, response, user) {
  const conversations = database.conversations
    .filter((conversation) => conversation.members.includes(user.id))
    .map((conversation) => conversationView(conversation, user.id));
  return sendJson(response, 200, { conversations });
}

async function createDirectConversation(request, response, user) {
  const body = await parseBody(request);
  if (!user.friends.includes(body.userId)) {
    return sendJson(response, 403, { error: '只能与好友发起聊天' });
  }

  let conversation = findDirectConversation(user.id, body.userId);
  if (!conversation) {
    conversation = {
      id: createId('c'),
      type: 'direct',
      members: [user.id, body.userId],
      createdAt: Date.now(),
    };
    database.conversations.push(conversation);
    saveDatabase();
  }
  return sendJson(response, 200, {
    conversation: conversationView(conversation, user.id),
  });
}

async function createGroupConversation(request, response, user) {
  const body = await parseBody(request);
  const members = [...new Set([user.id, ...(body.memberIds || [])])];

  if (members.length < 3) {
    return sendJson(response, 400, { error: '群聊至少需要 3 位成员' });
  }
  if (!members.slice(1).every((userId) => user.friends.includes(userId))) {
    return sendJson(response, 403, { error: '只能邀请好友加入群聊' });
  }

  const name = String(body.name || '').trim() || '新的群聊';
  const conversation = {
    id: createId('g'),
    type: 'group',
    name,
    avatar: name[0],
    members,
    createdBy: user.id,
    createdAt: Date.now(),
  };
  database.conversations.push(conversation);
  saveDatabase();

  broadcast(
    members.filter((userId) => userId !== user.id),
    'conversation_created',
    conversationView(conversation, user.id),
  );
  return sendJson(response, 201, {
    conversation: conversationView(conversation, user.id),
  });
}

function listMessages(_request, response, user, url, params) {
  const conversation = findConversation(params.id, user.id);
  if (!conversation) return sendJson(response, 404, { error: '会话不存在' });

  const before = Number(url.searchParams.get('before')) || Infinity;
  const messages = database.messages
    .filter((item) => item.conversationId === conversation.id && item.createdAt < before)
    .slice(-100)
    .map(messageView);
  return sendJson(response, 200, { messages });
}

async function sendMessage(request, response, user, params) {
  const conversation = findConversation(params.id, user.id);
  if (!conversation) return sendJson(response, 404, { error: '会话不存在' });

  const body = await parseBody(request);
  if (!['text', 'image', 'file', 'voice'].includes(body.type)) {
    return sendJson(response, 400, { error: '不支持的消息类型' });
  }
  if (body.type === 'text' && !String(body.content || '').trim()) {
    return sendJson(response, 400, { error: '消息不能为空' });
  }

  const message = {
    id: createId('m'),
    conversationId: conversation.id,
    senderId: user.id,
    type: body.type,
    content: body.content || '',
    fileName: body.fileName || null,
    fileUrl: body.fileUrl || null,
    duration: body.duration || null,
    createdAt: Date.now(),
  };
  database.messages.push(message);
  saveDatabase();

  const view = messageView(message);
  broadcast(
    conversation.members.filter((userId) => userId !== user.id),
    'message',
    view,
  );
  return sendJson(response, 201, { message: view });
}

function recallMessage(_request, response, user, params) {
  const message = database.messages.find((item) => item.id === params.id);
  if (!message) return sendJson(response, 404, { error: '消息不存在' });

  const conversation = findConversation(message.conversationId, user.id);
  if (!conversation) return sendJson(response, 403, { error: '无权操作此消息' });
  if (message.senderId !== user.id) {
    return sendJson(response, 403, { error: '只能撤回自己发送的消息' });
  }
  if (Date.now() - message.createdAt > RECALL_WINDOW_MS) {
    return sendJson(response, 400, { error: '消息发送超过 2 分钟，无法撤回' });
  }
  if (message.recalledAt) return sendJson(response, 409, { error: '消息已经撤回' });

  message.recalledAt = Date.now();
  message.content = '';
  saveDatabase();

  const view = messageView(message);
  broadcast(conversation.members, 'message_recalled', view);
  return sendJson(response, 200, { message: view });
}


function extractUpload(body) {
  let { mime, base64 } = body;
  if (!base64 && typeof body.data === 'string') {
    const commaIndex = body.data.indexOf(',');
    const metadata = body.data.slice(0, commaIndex);
    if (commaIndex > 0 && metadata.includes(';base64')) {
      mime = metadata.slice(5).split(';')[0];
      base64 = body.data.slice(commaIndex + 1);
    }
  }
  return { mime, base64 };
}

async function uploadFile(request, response) {
  const body = await parseBody(request);
  if (!body.name) return sendJson(response, 400, { error: '缺少文件名称' });

  const { mime, base64 } = extractUpload(body);
  if (!base64 || !/^[A-Za-z0-9+/=\r\n]+$/.test(base64)) {
    return sendJson(response, 400, { error: '文件数据格式错误' });
  }

  const buffer = Buffer.from(base64.replace(/[\r\n]/g, ''), 'base64');
  if (!buffer.length) return sendJson(response, 400, { error: '文件内容为空' });

  const safeName = path.basename(body.name).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
  const storedName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safeName}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, storedName), buffer);

  return sendJson(response, 201, {
    url: `http://${HOST}:${DEFAULT_PORT}/uploads/${encodeURIComponent(storedName)}`,
    name: safeName,
    type: mime || 'application/octet-stream',
    size: buffer.length,
  });
}


async function handleApi(request, response) {
  if (request.method === 'OPTIONS') return sendJson(response, 204, {});

  const url = new URL(request.url, `http://${HOST}`);
  const { pathname } = url;

  try {
    if (request.method === 'GET' && pathname === '/api/health') {
      return sendJson(response, 200, {
        ok: true,
        name: 'TalkStation Server',
        time: new Date().toISOString(),
      });
    }
    if (request.method === 'POST' && pathname === '/api/auth/register') {
      return await register(request, response);
    }
    if (request.method === 'POST' && pathname === '/api/auth/login') {
      return await login(request, response);
    }
    if (request.method === 'POST' && pathname === '/api/auth/guest') {
      return guestLogin(request, response);
    }

    const user = requireAuth(request, response);
    if (!user) return undefined;

    if (request.method === 'GET' && pathname === '/api/me') {
      return sendJson(response, 200, { user: publicUser(user) });
    }
    if (request.method === 'GET' && pathname === '/api/users/search') {
      const query = (url.searchParams.get('q') || '').toLocaleLowerCase();
      const users = database.users
        .filter((candidate) => candidate.id !== user.id)
        .filter((candidate) => candidate.account.toLocaleLowerCase().includes(query)
          || candidate.name.toLocaleLowerCase().includes(query))
        .map(publicUser);
      return sendJson(response, 200, { users });
    }
    if (request.method === 'GET' && pathname === '/api/friends') {
      return listFriends(request, response, user);
    }
    if (request.method === 'POST' && pathname === '/api/friends/request') {
      return await sendFriendRequest(request, response, user);
    }

    let params = matchRoute(pathname, '/api/friends/request/:id/accept');
    if (request.method === 'POST' && params) {
      return acceptFriendRequest(request, response, user, params);
    }

    if (request.method === 'GET' && pathname === '/api/conversations') {
      return listConversations(request, response, user);
    }
    if (request.method === 'POST' && pathname === '/api/conversations/direct') {
      return await createDirectConversation(request, response, user);
    }
    if (request.method === 'POST' && pathname === '/api/conversations/group') {
      return await createGroupConversation(request, response, user);
    }

    params = matchRoute(pathname, '/api/conversations/:id/messages');
    if (request.method === 'GET' && params) {
      return listMessages(request, response, user, url, params);
    }
    if (request.method === 'POST' && params) {
      return await sendMessage(request, response, user, params);
    }

    params = matchRoute(pathname, '/api/messages/:id/recall');
    if (request.method === 'POST' && params) {
      return recallMessage(request, response, user, params);
    }
    if (request.method === 'POST' && pathname === '/api/upload') {
      return await uploadFile(request, response);
    }

    return sendJson(response, 404, { error: '接口不存在' });
  } catch (error) {
    console.error(error);
    return sendJson(response, 500, { error: error.message || '服务器内部错误' });
  }
}


function websocketFrame(text) {
  const payload = Buffer.from(text);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

function broadcast(userIds, event, data) {
  const frame = websocketFrame(JSON.stringify({ event, data }));
  for (const userId of userIds) {
    for (const socket of sockets.get(userId) || []) {
      try {
        socket.write(frame);
      } catch {
        // Closed sockets are removed
      }
    }
  }
}

function upgradeWebsocket(request, socket) {
  const url = new URL(request.url, `http://${HOST}`);
  const userId = sessions.get(url.searchParams.get('token'));
  const clientKey = request.headers['sec-websocket-key'];
  if (!userId || !clientKey) return socket.destroy();

  const acceptKey = crypto
    .createHash('sha1')
    .update(`${clientKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');

  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    '',
    '',
  ].join('\r\n'));

  if (!sockets.has(userId)) sockets.set(userId, new Set());
  sockets.get(userId).add(socket);
  socket.write(websocketFrame(JSON.stringify({ event: 'connected', data: { userId } })));

  const removeSocket = () => sockets.get(userId)?.delete(socket);
  socket.on('close', removeSocket);
  socket.on('error', removeSocket);
  return undefined;
}


function serveUpload(request, response, url) {
  if (request.method !== 'GET' || !url.pathname.startsWith('/uploads/')) return false;

  const fileName = path.basename(decodeURIComponent(url.pathname.slice(9)));
  const filePath = path.join(UPLOAD_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    response.writeHead(404);
    response.end('Not found');
    return true;
  }

  const mime = MIME_TYPES[path.extname(fileName).toLowerCase()]
    || 'application/octet-stream';
  response.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': mime,
    'Content-Disposition': `inline; filename="${encodeURIComponent(fileName)}"`,
  });
  fs.createReadStream(filePath).pipe(response);
  return true;
}

function startServer(port = DEFAULT_PORT) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${HOST}`);
    if (!serveUpload(request, response, url)) handleApi(request, response);
  });

  server.on('upgrade', (request, socket) => {
    if (request.url.startsWith('/ws')) upgradeWebsocket(request, socket);
    else socket.destroy();
  });

  server.on('error', (error) => {
    if (error.code !== 'EADDRINUSE') console.error(error);
  });

  server.listen(port, HOST, () => {
    console.log(`TalkStation server running at http://${HOST}:${port}`);
  });
  return server;
}

if (require.main === module) {
  startServer(Number(process.env.PORT) || DEFAULT_PORT);
}

module.exports = { startServer };
