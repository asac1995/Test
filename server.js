const path = require('path');
const express = require('express');
const http = require('http');
const Database = require('better-sqlite3');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const db = new Database(path.join(__dirname, 'data', 'nareal.db'));

const POST_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_POST_LENGTH = 300;
const MAX_COMMENT_LENGTH = 300;

function nowMs() {
  return Date.now();
}

function setupDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      replaced_by_post_id INTEGER,
      deleted_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      content TEXT NOT NULL,
      quoted_comment_id INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(post_id) REFERENCES posts(id)
    );

    CREATE INDEX IF NOT EXISTS idx_posts_active ON posts(expires_at, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_posts_device ON posts(device_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at);

    CREATE TABLE IF NOT EXISTS device_state (
      device_id TEXT PRIMARY KEY,
      last_seen_own_comments_at INTEGER NOT NULL DEFAULT 0
    );
  `);

  seedPostsIfNeeded();
}

function ensureDeviceState(deviceId) {
  if (!deviceId) return;
  db.prepare('INSERT OR IGNORE INTO device_state (device_id, last_seen_own_comments_at) VALUES (?, 0)').run(deviceId);
}

function cleanExpired() {
  const now = nowMs();
  db.prepare(`
    UPDATE posts
    SET deleted_at = ?
    WHERE deleted_at IS NULL AND expires_at <= ?
  `).run(now, now);
}

function getActivePostByDevice(deviceId) {
  cleanExpired();
  return db.prepare(`
    SELECT p.*, (
      SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id
    ) AS comment_count
    FROM posts p
    WHERE p.device_id = ?
      AND p.deleted_at IS NULL
      AND p.expires_at > ?
    ORDER BY p.created_at DESC
    LIMIT 1
  `).get(deviceId, nowMs());
}

function serializePost(row) {
  if (!row) return null;
  return {
    id: row.id,
    content: row.content,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    commentCount: row.comment_count || 0,
    isMine: Boolean(row.is_mine),
    hasUnread: Boolean(row.has_unread),
  };
}

function getUnreadCount(deviceId) {
  if (!deviceId) return 0;
  cleanExpired();
  const ownPost = getActivePostByDevice(deviceId);
  if (!ownPost) return 0;

  ensureDeviceState(deviceId);
  const state = db.prepare('SELECT last_seen_own_comments_at FROM device_state WHERE device_id = ?').get(deviceId);
  const lastSeen = state?.last_seen_own_comments_at || 0;

  return db.prepare(`
    SELECT COUNT(*) AS total
    FROM comments c
    WHERE c.post_id = ?
      AND c.device_id != ?
      AND c.created_at > ?
  `).get(ownPost.id, deviceId, lastSeen).total;
}

function seedPostsIfNeeded() {
  const total = db.prepare('SELECT COUNT(*) AS total FROM posts').get().total;
  if (total > 0) return;

  const createdAt = nowMs() - 1000 * 60 * 30;
  const expiresAt = createdAt + POST_TTL_MS;
  const samplePosts = [
    ['seed_device_1', 'Hoje decidi desligar o celular por 2 horas. Foi estranho e libertador ao mesmo tempo.'],
    ['seed_device_2', 'Tem alguém mais aqui tentando recomeçar sem contar para ninguém?'],
    ['seed_device_3', 'Pequena vitória do dia: bebi água, organizei minhas ideias e respirei fundo.']
  ];

  const insert = db.prepare(`
    INSERT INTO posts (device_id, content, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    samplePosts.forEach((post, index) => insert.run(post[0], post[1], createdAt + index * 1000, expiresAt + index * 1000));
  });
  tx();
}

setupDb();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(cookieParser());

app.get('/', (req, res) => {
  res.render('index', {
    maxPostLength: MAX_POST_LENGTH,
    maxCommentLength: MAX_COMMENT_LENGTH,
  });
});

app.get('/api/my-post', (req, res) => {
  const deviceId = String(req.query.deviceId || '').trim();
  if (!deviceId) return res.json({ post: null, unreadCount: 0 });

  ensureDeviceState(deviceId);
  const post = getActivePostByDevice(deviceId);
  return res.json({
    post: serializePost({ ...post, is_mine: 1 }),
    unreadCount: getUnreadCount(deviceId),
  });
});

app.get('/api/feed/random', (req, res) => {
  cleanExpired();
  const excludeIds = String(req.query.exclude || '')
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

  const deviceId = String(req.query.deviceId || '').trim();
  const params = [nowMs()];
  let where = 'p.deleted_at IS NULL AND p.expires_at > ?';

  if (excludeIds.length > 0) {
    where += ` AND p.id NOT IN (${excludeIds.map(() => '?').join(',')})`;
    params.push(...excludeIds);
  }

  const row = db.prepare(`
    SELECT p.*, (
      SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id
    ) AS comment_count,
    CASE WHEN p.device_id = ? THEN 1 ELSE 0 END AS is_mine
    FROM posts p
    WHERE ${where}
    ORDER BY RANDOM()
    LIMIT 1
  `).get(deviceId, ...params);

  if (!row) return res.json({ post: null });
  return res.json({ post: serializePost(row) });
});

app.post('/api/post', (req, res) => {
  cleanExpired();
  const deviceId = String(req.body.deviceId || '').trim();
  const content = String(req.body.content || '').trim();

  if (!deviceId) return res.status(400).json({ error: 'Dispositivo inválido.' });
  if (!content) return res.status(400).json({ error: 'Digite algo para publicar.' });
  if (content.length > MAX_POST_LENGTH) return res.status(400).json({ error: `Máximo de ${MAX_POST_LENGTH} caracteres.` });

  const createdAt = nowMs();
  const expiresAt = createdAt + POST_TTL_MS;

  const tx = db.transaction(() => {
    const previous = getActivePostByDevice(deviceId);
    const result = db.prepare(`
      INSERT INTO posts (device_id, content, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(deviceId, content, createdAt, expiresAt);

    if (previous) {
      db.prepare(`
        UPDATE posts
        SET replaced_by_post_id = ?, deleted_at = ?
        WHERE id = ?
      `).run(result.lastInsertRowid, createdAt, previous.id);
    }

    return result.lastInsertRowid;
  });

  const postId = tx();
  const post = db.prepare(`
    SELECT p.*, 0 AS comment_count, 1 AS is_mine
    FROM posts p WHERE p.id = ?
  `).get(postId);

  res.json({ post: serializePost(post) });
});

app.get('/api/comments/:postId', (req, res) => {
  const postId = Number(req.params.postId);
  const deviceId = String(req.query.deviceId || '').trim();

  if (!Number.isInteger(postId) || postId <= 0) return res.status(400).json({ error: 'Post inválido.' });

  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post || post.deleted_at || post.expires_at <= nowMs()) return res.status(404).json({ error: 'Post indisponível.' });

  const comments = db.prepare(`
    SELECT c.*, q.content AS quoted_content,
      CASE WHEN c.device_id = p.device_id THEN 1 ELSE 0 END AS is_author
    FROM comments c
    JOIN posts p ON p.id = c.post_id
    LEFT JOIN comments q ON q.id = c.quoted_comment_id
    WHERE c.post_id = ?
    ORDER BY c.created_at ASC
  `).all(postId);

  const unreadCount = deviceId ? getUnreadCount(deviceId) : 0;

  res.json({
    comments: comments.map((c) => ({
      id: c.id,
      content: c.content,
      createdAt: c.created_at,
      quotedCommentId: c.quoted_comment_id,
      quotedContent: c.quoted_content || null,
      isAuthor: Boolean(c.is_author),
    })),
    unreadCount,
  });
});

app.post('/api/comments/:postId', (req, res) => {
  const postId = Number(req.params.postId);
  const deviceId = String(req.body.deviceId || '').trim();
  const content = String(req.body.content || '').trim();
  const quotedCommentId = req.body.quotedCommentId ? Number(req.body.quotedCommentId) : null;

  if (!Number.isInteger(postId) || postId <= 0) return res.status(400).json({ error: 'Post inválido.' });
  if (!deviceId) return res.status(400).json({ error: 'Dispositivo inválido.' });
  if (!content) return res.status(400).json({ error: 'Comentário vazio.' });
  if (content.length > MAX_COMMENT_LENGTH) return res.status(400).json({ error: `Máximo de ${MAX_COMMENT_LENGTH} caracteres.` });

  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post || post.deleted_at || post.expires_at <= nowMs()) return res.status(404).json({ error: 'Post indisponível.' });

  if (quotedCommentId && !db.prepare('SELECT id FROM comments WHERE id = ? AND post_id = ?').get(quotedCommentId, postId)) {
    return res.status(400).json({ error: 'Comentário citado inválido.' });
  }

  const createdAt = nowMs();
  const result = db.prepare(`
    INSERT INTO comments (post_id, device_id, content, quoted_comment_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(postId, deviceId, content, quotedCommentId || null, createdAt);

  const comment = db.prepare(`
    SELECT c.*, CASE WHEN c.device_id = p.device_id THEN 1 ELSE 0 END AS is_author
    FROM comments c
    JOIN posts p ON p.id = c.post_id
    WHERE c.id = ?
  `).get(result.lastInsertRowid);

  const payload = {
    id: comment.id,
    postId,
    content: comment.content,
    createdAt: comment.created_at,
    quotedCommentId: comment.quoted_comment_id,
    isAuthor: Boolean(comment.is_author),
  };

  io.to(`post:${postId}`).emit('comment:new', payload);

  if (post.device_id !== deviceId) {
    const unreadCount = getUnreadCount(post.device_id);
    io.to(`device:${post.device_id}`).emit('notification:update', { unreadCount });
  }

  const commentCount = db.prepare('SELECT COUNT(*) AS total FROM comments WHERE post_id = ?').get(postId).total;
  io.to(`post:${postId}`).emit('comment:count', { postId, commentCount });

  res.json({ comment: payload, commentCount });
});

app.post('/api/notifications/read', (req, res) => {
  const deviceId = String(req.body.deviceId || '').trim();
  if (!deviceId) return res.status(400).json({ error: 'Dispositivo inválido.' });

  ensureDeviceState(deviceId);
  db.prepare('UPDATE device_state SET last_seen_own_comments_at = ? WHERE device_id = ?').run(nowMs(), deviceId);

  return res.json({ ok: true, unreadCount: 0 });
});

io.on('connection', (socket) => {
  socket.on('join:post', (postId) => {
    if (Number.isInteger(postId) || /^[0-9]+$/.test(String(postId))) {
      socket.join(`post:${Number(postId)}`);
    }
  });

  socket.on('leave:post', (postId) => {
    socket.leave(`post:${Number(postId)}`);
  });

  socket.on('join:device', (deviceId) => {
    if (typeof deviceId === 'string' && deviceId.trim()) {
      socket.join(`device:${deviceId.trim()}`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`NaReal online em http://localhost:${PORT}`);
});
