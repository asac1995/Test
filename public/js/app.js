const socket = io();

const state = {
  deviceId: getOrCreateDeviceId(),
  viewed: [],
  currentIndex: -1,
  currentPost: null,
  quotedCommentId: null,
  unreadCount: 0,
};

const postText = document.getElementById('postText');
const timerEl = document.getElementById('timer');
const commentCountEl = document.getElementById('commentCount');
const postInput = document.getElementById('postInput');
const postChars = document.getElementById('postChars');
const publishBtn = document.getElementById('publishBtn');
const myPostBtn = document.getElementById('myPostBtn');
const notifBtn = document.getElementById('notifBtn');
const notifCount = document.getElementById('notifCount');
const openCommentsBtn = document.getElementById('openComments');
const commentModal = document.getElementById('commentModal');
const closeModalBtn = document.getElementById('closeModal');
const commentsList = document.getElementById('commentsList');
const commentInput = document.getElementById('commentInput');
const commentChars = document.getElementById('commentChars');
const sendComment = document.getElementById('sendComment');
const quotePreview = document.getElementById('quotePreview');
const swipeArea = document.getElementById('swipeArea');

let activePostRoom = null;
let touchStartY = null;

socket.emit('join:device', state.deviceId);
socket.on('notification:update', ({ unreadCount }) => updateUnreadCount(unreadCount));
socket.on('comment:new', () => {
  if (!state.currentPost || commentModal.classList.contains('hidden')) return;
  loadComments(state.currentPost.id);
});
socket.on('comment:count', ({ postId, commentCount }) => {
  if (state.currentPost?.id === postId) commentCountEl.textContent = commentCount;
  const found = state.viewed.find((p) => p.id === postId);
  if (found) found.commentCount = commentCount;
});

function getOrCreateDeviceId() {
  const key = 'nareal_device_id';
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

function formatLeft(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function postFontSize(content) {
  const len = content.length;
  if (len < 70) return '2rem';
  if (len < 140) return '1.6rem';
  if (len < 220) return '1.35rem';
  return '1.15rem';
}

function renderPost(post) {
  state.currentPost = post;
  postText.textContent = post.content;
  postText.style.fontSize = postFontSize(post.content);
  commentCountEl.textContent = post.commentCount || 0;
  if (activePostRoom) socket.emit('leave:post', activePostRoom);
  socket.emit('join:post', post.id);
  activePostRoom = post.id;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Erro inesperado.');
  return data;
}

async function loadNextPost(forceFetch = false) {
  if (!forceFetch && state.currentIndex < state.viewed.length - 1) {
    state.currentIndex += 1;
    renderPost(state.viewed[state.currentIndex]);
    return;
  }

  const exclude = state.viewed.map((p) => p.id).join(',');
  const data = await fetchJson(`/api/feed/random?deviceId=${encodeURIComponent(state.deviceId)}&exclude=${exclude}`);
  if (!data.post) {
    if (state.viewed.length > 0) return;
    postText.textContent = 'Sem posts ativos. Seja o primeiro a publicar no NaReal!';
    timerEl.textContent = '--:--:--';
    return;
  }
  state.viewed.push(data.post);
  state.currentIndex = state.viewed.length - 1;
  renderPost(data.post);
}

function loadPreviousPost() {
  if (state.currentIndex <= 0) return;
  state.currentIndex -= 1;
  renderPost(state.viewed[state.currentIndex]);
}

function updateTimer() {
  if (!state.currentPost) return;
  timerEl.textContent = `expira em ${formatLeft(state.currentPost.expiresAt - Date.now())}`;
}

function updateUnreadCount(count) {
  state.unreadCount = count;
  notifCount.textContent = count;
}

async function init() {
  const mine = await fetchJson(`/api/my-post?deviceId=${encodeURIComponent(state.deviceId)}`);
  updateUnreadCount(mine.unreadCount || 0);
  await loadNextPost(true);
}

publishBtn.addEventListener('click', async () => {
  const content = postInput.value.trim();
  if (!content) return;
  try {
    const data = await fetchJson('/api/post', {
      method: 'POST',
      body: JSON.stringify({ deviceId: state.deviceId, content }),
    });

    const idx = state.viewed.findIndex((p) => p.isMine);
    if (idx >= 0) state.viewed.splice(idx, 1);
    state.viewed.unshift({ ...data.post, isMine: true });
    state.currentIndex = 0;
    renderPost(state.viewed[0]);
    postInput.value = '';
    postChars.textContent = `0/${window.APP_CONFIG.maxPostLength}`;
  } catch (error) {
    alert(error.message);
  }
});

myPostBtn.addEventListener('click', async () => {
  const data = await fetchJson(`/api/my-post?deviceId=${encodeURIComponent(state.deviceId)}`);
  if (!data.post) return alert('Você ainda não publicou nenhum post ativo.');

  const existing = state.viewed.findIndex((p) => p.id === data.post.id);
  if (existing >= 0) {
    state.currentIndex = existing;
    renderPost(state.viewed[existing]);
  } else {
    state.viewed.unshift(data.post);
    state.currentIndex = 0;
    renderPost(data.post);
  }
  updateUnreadCount(data.unreadCount || 0);
});

notifBtn.addEventListener('click', async () => {
  await fetchJson('/api/notifications/read', {
    method: 'POST',
    body: JSON.stringify({ deviceId: state.deviceId }),
  });
  updateUnreadCount(0);
});

openCommentsBtn.addEventListener('click', async () => {
  if (!state.currentPost) return;
  commentModal.classList.remove('hidden');
  await loadComments(state.currentPost.id);
});

closeModalBtn.addEventListener('click', () => commentModal.classList.add('hidden'));

async function loadComments(postId) {
  const data = await fetchJson(`/api/comments/${postId}?deviceId=${encodeURIComponent(state.deviceId)}`);
  commentsList.innerHTML = '';
  data.comments.forEach((comment) => {
    const el = document.createElement('div');
    el.className = 'comment';

    const meta = document.createElement('div');
    meta.className = 'comment-meta';
    const dt = new Date(comment.createdAt).toLocaleString('pt-BR');
    meta.innerHTML = `<span>${dt}</span>${comment.isAuthor ? '<span class="tag-author">Autor do post</span>' : ''}`;

    const body = document.createElement('div');
    body.textContent = comment.content;

    const quoteBtn = document.createElement('button');
    quoteBtn.className = 'btn secondary small';
    quoteBtn.textContent = 'Citar';
    quoteBtn.addEventListener('click', () => {
      state.quotedCommentId = comment.id;
      quotePreview.classList.remove('hidden');
      quotePreview.textContent = `Respondendo comentário #${comment.id}: ${comment.content.slice(0, 90)}`;
    });

    el.append(meta, body);
    if (comment.quotedContent) {
      const quote = document.createElement('div');
      quote.className = 'quote';
      quote.textContent = `↳ ${comment.quotedContent}`;
      el.appendChild(quote);
    }
    el.appendChild(quoteBtn);
    commentsList.appendChild(el);
  });
  updateUnreadCount(data.unreadCount || 0);
}

sendComment.addEventListener('click', async () => {
  if (!state.currentPost) return;
  const content = commentInput.value.trim();
  if (!content) return;

  try {
    await fetchJson(`/api/comments/${state.currentPost.id}`, {
      method: 'POST',
      body: JSON.stringify({
        deviceId: state.deviceId,
        content,
        quotedCommentId: state.quotedCommentId,
      }),
    });
    commentInput.value = '';
    commentChars.textContent = `0/${window.APP_CONFIG.maxCommentLength}`;
    state.quotedCommentId = null;
    quotePreview.classList.add('hidden');
    await loadComments(state.currentPost.id);
  } catch (error) {
    alert(error.message);
  }
});

postInput.addEventListener('input', () => {
  postChars.textContent = `${postInput.value.length}/${window.APP_CONFIG.maxPostLength}`;
});
commentInput.addEventListener('input', () => {
  commentChars.textContent = `${commentInput.value.length}/${window.APP_CONFIG.maxCommentLength}`;
});

window.addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaY) < 50) return;
  if (e.deltaY > 0) loadNextPost();
  else loadPreviousPost();
}, { passive: true });

swipeArea.addEventListener('touchstart', (e) => {
  touchStartY = e.changedTouches[0].clientY;
}, { passive: true });

swipeArea.addEventListener('touchend', (e) => {
  if (touchStartY == null) return;
  const dy = e.changedTouches[0].clientY - touchStartY;
  if (dy < -50) loadNextPost();
  if (dy > 50) loadPreviousPost();
  touchStartY = null;
}, { passive: true });

setInterval(updateTimer, 1000);
init().catch((err) => {
  postText.textContent = err.message;
});
