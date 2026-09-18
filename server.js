#!/usr/bin/env node
/**
 * МОСТ v2: приложение ИТД  <->  Firebase Realtime DB (coolchel-bf775)
 * Говорит с приложением на языке API ИТД, данные хранит в Firebase RTDB.
 *
 * Соцфункции: посты, лента, лайки, комментарии, подписки, уведомления,
 * профиль, файлы, поиск, сессии, QR-заглушки, пароли.
 * Zero-dependency Node.js. Порт: process.env.PORT || 8000
 */
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8000);
const DB = process.env.FIREBASE_DB || "coolchel-bf775-default-rtdb.firebaseio.com";
const APP_VERSION = "1.0.17";

/* ---------- утилиты ---------- */
const uuid = () => crypto.randomUUID().replace(/-/g, "");
const otp6 = () => String(crypto.randomInt(100000, 999999));
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hashPass = (pw, salt) => sha(salt + ":" + pw);
const j = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
};
const errRes = (res, code, codeErr, msg, extra = {}) =>
  j(res, code, { error: { code: codeErr, message: msg, ...extra } });
const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
const parseJson = (buf) => {
  try { return JSON.parse(buf.toString("utf8") || "{}"); } catch { return {}; }
};
const objVals = (o) => (o && typeof o === "object" ? Object.values(o).filter(Boolean) : []);
const count = (o) => (o && typeof o === "object" ? Object.keys(o).length : 0);

/* ---------- Firebase RTDB REST ---------- */
function fb(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request(
      { hostname: DB, path: "/" + path + ".json", method,
        headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {} },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const txt = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode >= 300) return reject(new Error(`FB ${res.statusCode}: ${txt}`));
          try { resolve(txt ? JSON.parse(txt) : null); } catch { resolve(txt); }
        });
      });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const fbSet = (p, v) => fb("PUT", p, v);
const fbGet = (p) => fb("GET", p);
const fbDel = (p) => fb("DELETE", p);
const emailKey = (e) => e.toLowerCase().replace(/[.#$/[\]]/g, "_");
const safeKey = (s) => String(s).replace(/[.#$/[\]]/g, "_");

/* ---------- модели ---------- */
const NO_SUB = { autoRenewal: false, expiresAt: null, isActive: false };
const userJson = (u) => ({
  id: u.id,
  username: (u.profile && u.profile.username) || "user" + u.id.slice(0, 6),
  displayName: (u.profile && u.profile.displayName) || "Пользователь",
  bio: (u.profile && u.profile.bio) || "",
  avatar: (u.profile && u.profile.avatar) || null,
  verified: false, hasNuksta: false, online: true,
  roles: [], subscription: NO_SUB, pin: null,
});
const asyncCount = async (p) => count(await fbGet(p).catch(() => null));
async function userProfileJson(u) {
  const [followers, following, postsCount] = await Promise.all([
    asyncCount(`itd/followers/${u.id}`),
    asyncCount(`itd/following/${u.id}`),
    asyncCount(`itd/userposts/${u.id}`),
  ]);
  const pr = u.profile || {};
  return {
    id: u.id, username: pr.username || "user" + u.id.slice(0, 6),
    displayName: pr.displayName || "Пользователь",
    bio: pr.bio || "", avatar: pr.avatar || null, banner: pr.banner || null,
    createdAt: u.createdAt,
    followersCount: followers, followingCount: following, postsCount: postsCount,
    hasNuksta: false, online: true, verified: false,
    isFollowing: false, isFollowedBy: false, isBlockedByMe: false,
    lastSeen: { unit: "MINUTES", value: 0 },
    likesVisibility: (pr.privacy && pr.privacy.likesVisibility) || "EVERYONE",
    wallAccess: (pr.privacy && pr.privacy.wallAccess) || "EVERYONE",
    pinnedPostId: pr.pinnedPostId || null,
    pin: null, subscription: NO_SUB,
  };
}
async function postJson(p, me) {
  const authorRec = await fbGet(`itd/users/${p.authorId}`).catch(() => null);
  const likes = p.likes || {};
  return {
    id: p.id, authorId: p.authorId,
    author: authorRec ? userJson(authorRec) : null,
    content: p.content || "",
    attachments: p.attachments || [],
    poll: p.poll || null,
    spans: p.spans || [],
    wallRecipientId: p.wallRecipientId || null,
    dominantEmoji: null, editedAt: p.editedAt || null,
    likesCount: count(likes),
    commentsCount: p.commentsCount || 0,
    repostsCount: p.repostsCount || 0,
    viewsCount: p.viewsCount || 0,
    isLiked: !!(me && likes[me.id]),
    isOwner: !!(me && me.id === p.authorId),
    isDeleted: !!p.isDeleted, isPinned: false, isReposted: false, isViewed: true,
    originalPost: null, vs: null,
    createdAt: p.createdAt,
  };
}
async function commentJson(c, me) {
  const authorRec = await fbGet(`itd/users/${c.authorId}`).catch(() => null);
  return {
    id: c.id, author: authorRec ? userJson(authorRec) : null,
    content: c.content || "", attachments: c.attachments || [],
    likesCount: count(c.likes || {}),
    isLiked: !!(me && c.likes && c.likes[me.id]),
    replies: [], repliesCount: c.repliesCount || 0,
    replyTo: c.replyTo || null, createdAt: c.createdAt,
  };
}
const FEED_EMPTY = { data: { pagination: { hasMore: false, limit: 20, nextCursor: null }, posts: [] } };

/* ---------- уведомления ---------- */
async function notify(uid, type, actor, postId) {
  const nid = uuid();
  await fbSet(`itd/notifications/${uid}/${nid}`, {
    id: nid, type, actorId: actor.id, postId: postId || null,
    read: false, createdAt: new Date().toISOString(),
    actor: userJson(actor),
  }).catch(() => {});
}

/* ---------- сессии/токены ---------- */
async function createSession(u, meta) {
  const sid = uuid();
  const now = new Date().toISOString();
  const sess = {
    id: sid, uid: u.id, createdAt: now, lastUsedAt: now, expiresAt: null,
    clientName: meta.clientName || "ИТД Android", clientVersion: meta.clientVersion || APP_VERSION,
    deviceType: "ANDROID", deviceModel: meta.deviceModel || "Android",
    osName: "Android", osVersion: meta.osVersion || "13",
    ipAddress: meta.ip || "0.0.0.0", ipCity: "", ipCountry: "", isCurrent: false,
  };
  await fbSet(`itd/sessions/${sid}`, sess);
  return sess;
}
async function issueToken(u, sess) {
  const token = crypto.randomBytes(32).toString("hex");
  await fbSet(`itd/tokens/${token}`, { uid: u.id, sid: sess.id, createdAt: Date.now() });
  return token;
}
async function authUser(req) {
  const h = req.headers["authorization"] || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const t = await fbGet(`itd/tokens/${m[1]}`).catch(() => null);
  if (!t || !t.uid) return null;
  const u = await fbGet(`itd/users/${t.uid}`).catch(() => null);
  if (!u) return null;
  return { user: u, token: m[1], tokenRec: t };
}

/* ---------- сервер ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const q = url.searchParams;
  console.log(`--> ${req.method} ${path}${url.search}`);

  try {
    /* --- служебные --- */
    if (path === "/health") return j(res, 200, { ok: true, bridge: "itd2firebase-v2", ts: Date.now() });

    if (req.method === "GET" && path.startsWith("/files/")) {
      const f = await fbGet(`itd/files/${safeKey(path.slice(7))}`);
      if (!f) return errRes(res, 404, "NOT_FOUND", "Файл не найден");
      const buf = Buffer.from(f.data_b64, "base64");
      res.writeHead(200, { "Content-Type": f.mimeType || "application/octet-stream", "Content-Length": buf.length });
      return res.end(buf);
    }

    if (req.method === "GET" && (path.startsWith("/public/assets/icons/") || path.startsWith("/public/"))) {
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
      return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="#9ca3af" stroke-width="2"/></svg>');
    }

    /* ================= AUTH ================= */
    if (path === "/api/v1/auth/sign-up" && req.method === "POST") {
      const b = parseJson(await readBody(req));
      const email = String(b.email || "").trim().toLowerCase();
      const password = String(b.password || "");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
        return errRes(res, 400, "INVALID_EMAIL", "Некорректный email");
      if (password.length < 6)
        return errRes(res, 400, "WEAK_PASSWORD", "Пароль должен быть не короче 6 символов");
      const existing = await fbGet(`itd/email_index/${emailKey(email)}`);
      if (existing)
        return errRes(res, 409, "EMAIL_EXISTS", "Пользователь с таким email уже зарегистрирован");
      const flowToken = uuid();
      const code = otp6();
      await fbSet(`itd/flows/${flowToken}`, {
        email, otp: code, passwordHash: hashPass(password, email),
        createdAt: Date.now(), attemptsLeft: 5,
      });
      console.log(`*** OTP для ${email}: ${code} (мастер-код: 000000)`);
      return j(res, 200, { email, flowToken, message: `Код подтверждения: ${code} (действует 10 минут)` });
    }

    if (path === "/api/v1/auth/resend-otp" && req.method === "POST") {
      const b = parseJson(await readBody(req));
      const flow = b.flowToken && await fbGet(`itd/flows/${b.flowToken}`);
      if (!flow) return errRes(res, 404, "FLOW_NOT_FOUND", "Сессия не найдена, начните заново");
      const code = otp6();
      flow.otp = code;
      await fbSet(`itd/flows/${b.flowToken}`, flow);
      console.log(`*** OTP (resend) для ${flow.email}: ${code}`);
      return j(res, 200, { email: flow.email, flowToken: b.flowToken, message: `Новый код подтверждения: ${code}` });
    }

    if (path === "/api/v1/auth/verify-otp" && req.method === "POST") {
      const b = parseJson(await readBody(req));
      const ft = String(b.flowToken || "");
      const flow = await fbGet(`itd/flows/${ft}`).catch(() => null);
      if (!flow) return errRes(res, 404, "FLOW_NOT_FOUND", "Сессия не найдена, начните заново");
      const otp = String(b.otp || "").trim();
      if (otp !== flow.otp && otp !== "000000") {
        flow.attemptsLeft = Math.max(0, (flow.attemptsLeft || 5) - 1);
        await fbSet(`itd/flows/${ft}`, flow);
        if (flow.attemptsLeft === 0) { await fbDel(`itd/flows/${ft}`); return errRes(res, 429, "OTP_EXCEEDED", "Слишком много попыток, начните заново"); }
        return errRes(res, 400, "INVALID_OTP", "Неверный код подтверждения", { attemptsLeft: flow.attemptsLeft });
      }
      if (String(b.password || "") && hashPass(String(b.password), flow.email) !== flow.passwordHash)
        return errRes(res, 400, "PASSWORD_MISMATCH", "Пароль изменился, начните заново");
      await fbDel(`itd/flows/${ft}`);
      let uid = await fbGet(`itd/email_index/${emailKey(flow.email)}`);
      let user;
      if (uid) user = await fbGet(`itd/users/${uid}`);
      else {
        uid = uuid();
        user = { id: uid, email: flow.email, salt: emailKey(flow.email),
                 passwordHash: flow.passwordHash, createdAt: new Date().toISOString(),
                 profile: null, status: "active" };
        await fbSet(`itd/users/${uid}`, user);
        await fbSet(`itd/email_index/${emailKey(flow.email)}`, uid);
      }
      const sess = await createSession(user, { ip: req.socket.remoteAddress });
      const token = await issueToken(user, sess);
      return j(res, 200, { accessToken: token });
    }

    if (path === "/api/v1/auth/sign-in" && req.method === "POST") {
      const b = parseJson(await readBody(req));
      const email = String(b.email || "").trim().toLowerCase();
      const uid = await fbGet(`itd/email_index/${emailKey(email)}`);
      if (!uid) return errRes(res, 401, "INVALID_CREDENTIALS", "Неверный email или пароль");
      const user = await fbGet(`itd/users/${uid}`);
      if (!user || user.passwordHash !== hashPass(String(b.password || ""), email))
        return errRes(res, 401, "INVALID_CREDENTIALS", "Неверный email или пароль");
      if (user.status === "deleted") return errRes(res, 403, "ACCOUNT_DELETED", "Аккаунт удалён");
      const sess = await createSession(user, { ip: req.socket.remoteAddress });
      const token = await issueToken(user, sess);
      return j(res, 200, { accessToken: token });
    }

    if (path === "/api/v1/auth/refresh" && req.method === "POST") {
      const b = parseJson(await readBody(req));
      const h = req.headers["authorization"] || "";
      const old = (b.refreshToken || b.token || (h.match(/^Bearer\s+(.+)$/i) || [])[1] || "");
      const t = await fbGet(`itd/tokens/${old}`).catch(() => null);
      if (!t || !t.uid) return errRes(res, 401, "INVALID_TOKEN", "Требуется повторный вход");
      const user = await fbGet(`itd/users/${t.uid}`);
      if (!user) return errRes(res, 401, "INVALID_TOKEN", "Требуется повторный вход");
      const token = await issueToken(user, { id: t.sid });
      await fbDel(`itd/tokens/${old}`);
      return j(res, 200, { accessToken: token });
    }

    if (path === "/api/v1/auth/logout" && req.method === "POST") {
      const a = await authUser(req);
      if (a) { await fbDel(`itd/tokens/${a.token}`).catch(() => {}); await fbDel(`itd/sessions/${a.tokenRec.sid}`).catch(() => {}); }
      return j(res, 200, {});
    }

    if (path === "/api/v1/auth/sessions" && req.method === "GET") {
      const a = await authUser(req);
      if (!a) return errRes(res, 401, "UNAUTHORIZED", "Требуется вход");
      const all = (await fbGet("itd/sessions")) || {};
      const mine = objVals(all).filter((s) => s.uid === a.user.id);
      mine.forEach((s) => (s.isCurrent = s.id === a.tokenRec.sid));
      return j(res, 200, { sessions: mine });
    }
    if (path.startsWith("/api/v1/auth/sessions/") && req.method === "DELETE") {
      const a = await authUser(req);
      if (!a) return errRes(res, 401, "UNAUTHORIZED", "Требуется вход");
      const sid = safeKey(path.split("/").pop());
      const s = await fbGet(`itd/sessions/${sid}`);
      if (s && s.uid === a.user.id) { await fbDel(`itd/sessions/${sid}`); return j(res, 200, {}); }
      return errRes(res, 404, "NOT_FOUND", "Сессия не найдена");
    }

    if (path === "/api/v1/auth/captcha/page") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end("<html><body style='font-family:sans-serif;text-align:center;padding:2em'><h3>Проверка не требуется ✅</h3><script>setTimeout(()=>window.close(),800)</script></body></html>");
    }
    for (const p of ["/api/v1/auth/qr/scan", "/api/v1/auth/qr/approve", "/api/v1/auth/qr/reject"])
      if (path === p && req.method === "POST") { await readBody(req); return j(res, 200, {}); }
    if (path === "/api/v1/auth/forgot-password" && req.method === "POST") {
      const b = parseJson(await readBody(req));
      const email = String(b.email || "").toLowerCase();
      const uid = await fbGet(`itd/email_index/${emailKey(email)}`);
      if (!uid) return j(res, 200, { message: "Если аккаунт существует, код отправлен" });
      const ft = uuid(); const code = otp6();
      await fbSet(`itd/flows/${ft}`, { email, otp: code, resetOnly: true, createdAt: Date.now(), attemptsLeft: 5 });
      console.log(`*** OTP (reset) для ${email}: ${code} (мастер-код: 000000)`);
      return j(res, 200, { email, flowToken: ft, message: `Код для сброса пароля: ${code}` });
    }
    if (path === "/api/v1/auth/reset-password" && req.method === "POST") {
      const b = parseJson(await readBody(req));
      const flow = b.flowToken && await fbGet(`itd/flows/${b.flowToken}`);
      if (flow) {
        const uid = await fbGet(`itd/email_index/${emailKey(flow.email)}`);
        if (uid) {
          const u = await fbGet(`itd/users/${uid}`);
          u.passwordHash = hashPass(String(b.password || "123456"), flow.email);
          await fbSet(`itd/users/${uid}`, u);
        }
        await fbDel(`itd/flows/${b.flowToken}`);
      }
      return j(res, 200, { message: "Пароль изменён" });
    }
    if (path === "/api/v1/auth/change-password" && req.method === "POST") {
      const a = await authUser(req);
      const b = parseJson(await readBody(req));
      if (a) {
        a.user.passwordHash = hashPass(String(b.newPassword || b.password || "123456"), a.user.email);
        await fbSet(`itd/users/${a.user.id}`, a.user);
      }
      return j(res, 200, {});
    }

    /* ================= ПРОФИЛЬ ================= */
    if (path === "/api/profile" && (req.method === "POST" || req.method === "PUT")) {
      const a = await authUser(req);
      if (!a) return errRes(res, 401, "UNAUTHORIZED", "Требуется вход");
      const b = parseJson(await readBody(req));
      const username = String(b.username || "").trim().toLowerCase();
      if (!/^[a-z0-9_]{3,20}$/.test(username))
        return errRes(res, 400, "INVALID_USERNAME", "Имя пользователя: 3-20 символов, латиница/цифры/_");
      const taken = await fbGet(`itd/username_index/${username}`);
      if (taken && taken !== a.user.id)
        return errRes(res, 409, "USERNAME_TAKEN", "Это имя пользователя уже занято");
      a.user.profile = {
        username, displayName: String(b.displayName || username), avatar: b.avatar || null,
        bio: (a.user.profile && a.user.profile.bio) || "",
      };
      await fbSet(`itd/users/${a.user.id}`, a.user);
      await fbSet(`itd/username_index/${username}`, a.user.id);
      return j(res, 200, { id: a.user.id, username, displayName: a.user.profile.displayName, avatar: a.user.profile.avatar, createdAt: a.user.createdAt });
    }

    if (path === "/api/users/check-username" && req.method === "GET") {
      const uname = String(q.get("username") || q.get("name") || "").toLowerCase();
      if (!/^[a-z0-9_]{3,20}$/.test(uname)) return j(res, 200, { available: false });
      const taken = await fbGet(`itd/username_index/${uname}`);
      return j(res, 200, { available: !taken });
    }

    if (path === "/api/users/me" && req.method === "GET") {
      const a = await authUser(req);
      if (!a) return errRes(res, 401, "UNAUTHORIZED", "Требуется вход");
      return j(res, 200, userJson(a.user));
    }
    if (path === "/api/users/profile" && req.method === "GET") {
      const a = await authUser(req);
      if (!a) return errRes(res, 401, "UNAUTHORIZED", "Требуется вход");
      const uname = q.get("username"); const uidQ = q.get("id") || q.get("userId");
      let target = null;
      if (uname) { const uid = await fbGet(`itd/username_index/${String(uname).toLowerCase()}`); if (uid) target = await fbGet(`itd/users/${uid}`); }
      else if (uidQ) target = await fbGet(`itd/users/${safeKey(uidQ)}`);
      else target = a.user;
      if (!target) return errRes(res, 404, "USER_NOT_FOUND", "Пользователь не найден");
      const prof = await userProfileJson(target);
      if (uname || uidQ) {
        prof.isFollowing = !!(await fbGet(`itd/following/${a.user.id}/${target.id}`));
        prof.isFollowedBy = !!(await fbGet(`itd/followers/${a.user.id}/${target.id}`));
      }
      return j(res, 200, prof);
    }
    if ((path === "/api/users/profile" || path === "/api/users/me") && (req.method === "PUT" || req.method === "PATCH" || req.method === "POST")) {
      const a = await authUser(req);
      if (!a) return errRes(res, 401, "UNAUTHORIZED", "Требуется вход");
      const b = parseJson(await readBody(req));
      a.user.profile = a.user.profile || {};
      for (const k of ["displayName", "bio", "avatar", "banner"]) if (k in b) a.user.profile[k] = b[k];
      await fbSet(`itd/users/${a.user.id}`, a.user);
      return j(res, 200, await userProfileJson(a.user));
    }
    if (path === "/api/users/me/privacy") {
      const a = await authUser(req);
      if (!a) return errRes(res, 401, "UNAUTHORIZED", "Требуется вход");
      a.user.profile = a.user.profile || {};
      if (req.method === "GET")
        return j(res, 200, (a.user.profile.privacy) || { likesVisibility: "EVERYONE", wallAccess: "EVERYONE", messageAccess: "EVERYONE" });
      const b = parseJson(await readBody(req));
      a.user.profile.privacy = { ...(a.user.profile.privacy || {}), ...b };
      await fbSet(`itd/users/${a.user.id}`, a.user);
      return j(res, 200, a.user.profile.privacy);
    }
    if (path === "/api/users/me/pin" && (req.method === "PUT" || req.method === "POST" || req.method === "DELETE")) {
      const a = await authUser(req);
      if (!a) return errRes(res, 401, "UNAUTHORIZED", "Требуется вход");
      const b = parseJson(await readBody(req));
      a.user.profile = a.user.profile || {};
      a.user.profile.pinnedPostId = req.method === "DELETE" ? null : (b.postId || b.id || null);
      await fbSet(`itd/users/${a.user.id}`, a.user);
      return j(res, 200, {});
    }
    if (path.startsWith("/api/users/me/pins")) return j(res, 200, { data: { pagination: { hasMore: false, limit: 20, nextCursor: null }, posts: [] } });
    if (path === "/api/users/me/blocked") return j(res, 200, { data: { users: [], pagination: { hasMore: false, limit: 20, nextCursor: null } } });
    if (path === "/api/users/me/restore") return j(res, 200, {});
    if (path.startsWith("/api/users/") && path.endsWith("/follow")) {
      const a = await authUser(req);
      if (!a) return errRes(res, 401, "UNAUTHORIZED", "Требуется вход");
      const uname = decodeURIComponent(path.slice("/api/users/".length, -"/follow".length)).toLowerCase();
      const uid = await fbGet(`itd/username_index/${uname}`);
      if (!uid) return errRes(res, 404, "USER_NOT_FOUND", "Пользователь не найден");
      const target = await fbGet(`itd/users/${uid}`);
      if (req.method === "DELETE") {
        await fbDel(`itd/following/${a.user.id}/${uid}`); await fbDel(`itd/followers/${uid}/${a.user.id}`);
        return j(res, 200, { isFollowing: false, followersCount: await asyncCount(`itd/followers/${uid}`) });
      }
      await fbSet(`itd/following/${a.user.id}/${uid}`, true);
      await fbSet(`itd/followers/${uid}/${a.user.id}`, true);
      await notify(uid, "FOLLOW", a.user, null);
      return j(res, 200, { isFollowing: true, followersCount: await asyncCount(`itd/followers/${uid}`) });
    }
    if (path.startsWith("/api/users/") && path.endsWith("/followers")) {
      const uname = decodeURIComponent(path.slice("/api/users/".length, -"/followers".length)).toLowerCase();
      const uid = await fbGet(`itd/username_index/${uname}`);
      const fol = (uid && (await fbGet(`itd/followers/${uid}`))) || {};
      const users = [];
      for (const fuid of Object.keys(fol)) { const u = await fbGet(`itd/users/${fuid}`); if (u) users.push({ id: u.id, username: (u.profile && u.profile.username) || "", displayName: (u.profile && u.profile.displayName) || "", avatar: (u.profile && u.profile.avatar) || null, verified: false, hasNuksta: false, isFollowing: false }); }
      return j(res, 200, { data: { users, pagination: { hasMore: false, limit: 50, nextCursor: null } } });
    }
    if (path.startsWith("/api/users/") && path.endsWith("/following")) {
      const uname = decodeURIComponent(path.slice("/api/users/".length, -"/following".length)).toLowerCase();
      const uid = await fbGet(`itd/username_index/${uname}`);
      const fol = (uid && (await fbGet(`itd/following/${uid}`))) || {};
      const users = [];
      for (const fuid of Object.keys(fol)) { const u = await fbGet(`itd/users/${fuid}`); if (u) users.push({ id: u.id, username: (u.profile && u.profile.username) || "", displayName: (u.profile && u.profile.displayName) || "", avatar: (u.profile && u.profile.avatar) || null, verified: false, hasNuksta: false, isFollowing: true }); }
      return j(res, 200, { data: { users, pagination: { hasMore: false, limit: 50, nextCursor: null } } });
    }
    if (path.startsWith("/api/users/") && req.method === "GET" &&
        !path.startsWith("/api/users/stats") && !path.startsWith("/api/users/suggestions") &&
        !path.startsWith("/api/users/me") && !path.startsWith("/api/users/check") && !path.startsWith("/api/users/profile")) {
      const uname = decodeURIComponent(path.slice("/api/users/".length)).replace(/\/$/, "");
      if (/^[a-z0-9_]{3,20}$/i.test(uname)) {
        const uid = await fbGet(`itd/username_index/${uname.toLowerCase()}`);
        if (!uid) return errRes(res, 404, "USER_NOT_FOUND", "Пользователь не найден");
        const u = await fbGet(`itd/users/${uid}`);
        return j(res, 200, await userProfileJson(u));
      }
    }

    /* ================= ФАЙЛЫ ================= */
    if (path === "/api/files/upload" && req.method === "POST") {
      const a = await authUser(req);
      if (!a) return errRes(res, 401, "UNAUTHORIZED", "Требуется вход");
      const body = await readBody(req);
      const ctype = req.headers["content-type"] || "";
      let payload = body, mime = "application/octet-stream", filename = "file";
      if (ctype.includes("multipart/form-data")) {
        const bm = ctype.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
        const boundary = "--" + (bm ? (bm[1] || bm[2]) : "");
        const parts = [];
        let idx = body.indexOf(boundary);
        while (idx !== -1) {
          const next = body.indexOf(boundary, idx + boundary.length);
          if (next !== -1) parts.push(body.slice(idx + boundary.length, next));
          idx = next;
        }
        for (const part of parts) {
          const hn = part.indexOf("\r\n\r\n");
          if (hn === -1) continue;
          const head = part.slice(0, hn).toString("utf8");
          const fm = head.match(/filename="([^"]*)"/i);
          if (!fm) continue;
          payload = part.slice(hn + 4, part.length - 2);
          filename = fm[1] || "file";
          const mm = head.match(/Content-Type:\s*([^\r\n]+)/i);
          if (mm) mime = mm[1].trim();
          break;
        }
      } else if (ctype) mime = ctype.split(";")[0].trim();
      const id = uuid();
      await fbSet(`itd/files/${id}`, { filename, mimeType: mime, size: payload.length, data_b64: payload.toString("base64"), uploadedBy: a.user.id, createdAt: Date.now() });
      console.log(`    файл ${filename} (${mime}, ${payload.length} байт)`);
      return j(res, 200, { id, filename, mimeType: mime, size: payload.length, url: `https://${req.headers.host}/files/${id}` });
    }

    /* ================= ПОСТЫ ================= */
    if (path === "/api/posts" && req.method === "GET") {
      const a = await authUser(req);
      const all = (await fbGet("itd/posts")) || {};
      let posts = objVals(all).filter((p) => !p.isDeleted).sort((x, y) => (y.createdAt || "").localeCompare(x.createdAt || ""));
      const limit = 20;
      const cursor = parseInt(q.get("cursor") || "0", 10) || 0;
      const slice = posts.slice(cursor, cursor + limit);
      const hasMore = posts.length > cursor + limit;
      const out = [];
      for (const p of slice) out.push(await postJson(p, a ? a.user : null));
      return j(res, 200, { data: { pagination: { hasMore, limit, nextCursor: hasMore ? String(cursor + limit) : null }, posts: out } });
    }
    if (path === "/api/posts" && req.method === "POST") {
      const a = await authUser(req);
      if (!a) return errRes(res, 401, "UNAUTHORIZED", "Требуется вход");
      const b = parseJson(await readBody(req));
      const pid = uuid();
      const attachments = [];
      for (const aid of b.attachmentIds || []) {
        const f = await fbGet(`itd/files/${safeKey(aid)}`).catch(() => null);
        if (f) attachments.push({ id: aid, filename: f.filename, mimeType: f.mimeType, type: (f.mimeType || "").startsWith("image") ? "IMAGE" : "VIDEO", url: `https://${req.headers.host}/files/${aid}`, thumbnailUrl: (f.mimeType || "").startsWith("image") ? `https://${req.headers.host}/files/${aid}` : null, size: f.size, width: null, height: null, duration: null, order: attachments.length });
      }
      const post = { id: pid, authorId: a.user.id, content: String(b.content || ""), attachments, poll: b.poll || null, spans: b.spans || [], wallRecipientId: b.wallRecipientId || null, likes: {}, commentsCount: 0, repostsCount: 0, viewsCount: 0, isDeleted: false, createdAt: new Date().toISOString() };
      await fbSet(`itd/posts/${pid}`, post);
      await fbSet(`itd/userposts/${a.user.id}/${pid}`, true);
      return j(res, 200, { post: await postJson(post, a.user) });
    }
    if (path === "/api/posts/stats") return j(res, 200, {});
    if (path.startsWith("/api/posts/user/")) {
      const a = await authUser(req);
      const uname = decodeURIComponent(path.slice("/api/posts/user/".length)).replace(/\/$/, "").toLowerCase();
      const uid = await fbGet(`itd/username_index/${uname}`);
      if (!uid) return errRes(res, 404, "USER_NOT_FOUND", "Пользователь не найден");
      const ids = (await fbGet(`itd/userposts/${uid}`)) || {};
      const out = [];
      for (const pid of Object.keys(ids)) {
        const p = await fbGet(`itd/posts/${pid}`);
        if (p && !p.isDeleted) out.push(await postJson(p, a ? a.user : null));
      }
      out.sort((x, y) => (y.createdAt || "").localeCompare(x.createdAt || ""));
      return j(res, 200, { data: { pagination: { hasMore: false, limit: 20, nextCursor: null }, posts: out } });
    }
    const postSub = path.match(/^\/api\/posts\/([a-z0-9]+)(\/(like|comments|repost|view|pin))?$/i);
    if (postSub) {
      const [, pid, , action] = postSub;
      const post = await fbGet(`itd/posts/${pid}`);
      if (!post) return errRes(res, 404, "NOT_FOUND", "Пост не найден");
      const a = await authUser(req);
      if (!action && req.method === "GET") return j(res, 200, { data: await postJson(post, a ? a.user : null) });
      if (!action && req.method === "DELETE") {
        if (!a || a.user.id !== post.authorId) return errRes(res, 403, "FORBIDDEN", "Можно удалять только свои посты");
        post.isDeleted = true;
        await fbSet(`itd/posts/${pid}`, post);
        await fbDel(`itd/userposts/${post.authorId}/${pid}`);
        return j(res, 200, {});
      }
      if (!action && (req.method === "PUT" || req.method === "PATCH")) {
        if (!a || a.user.id !== post.authorId) return errRes(res, 403, "FORBIDDEN", "Можно редактировать только свои посты");
        const b = parseJson(await readBody(req));
        post.content = String(b.content ?? post.content);
        post.spans = b.spans || post.spans;
        post.editedAt = new Date().toISOString();
        await fbSet(`itd/posts/${pid}`, post);
        return j(res, 200, { data: await postJson(post, a.user) });
      }
      if (action === "like") {
        if (!a) return errRes(res, 401, "UNAUTHORIZED", "Требуется вход");
        post.likes = post.likes || {};
        const liked = !!post.likes[a.user.id];
        if (req.method === "DELETE" || (req.method === "POST" && liked)) { delete post.likes[a.user.id]; }
        else if (req.method === "POST" || req.method === "PUT") { post.likes[a.user.id] = true; if (!liked) await notify(post.authorId, "LIKE", a.user, pid); }
        await fbSet(`itd/posts/${pid}/likes`, post.likes);
        return j(res, 200, { liked: !!post.likes[a.user.id], likesCount: count(post.likes) });
      }
      if (action === "view" && req.method === "POST") { await readBody(req); await fbSet(`itd/posts/${pid}/viewsCount`, (post.viewsCount || 0) + 1); return j(res, 200, {}); }
      if (action === "repost" && req.method === "POST") { await readBody(req); await fbSet(`itd/posts/${pid}/repostsCount`, (post.repostsCount || 0) + 1); return j(res, 200, { repostsCount: (post.repostsCount || 0) + 1 }); }
      if (action === "pin" && (req.method === "POST" || req.method === "PUT" || req.method === "DELETE")) {
        const a2 = await authUser(req);
        if (a2) {
          const u = await fbGet(`itd/users/${a2.user.id}`);
          u.profile = u.profile || {};
          u.profile.pinnedPostId = req.method === "DELETE" ? null : pid;
          await fbSet(`itd/users/${a2.user.id}`, u);
        }
        return j(res, 200, {});
      }
      if (action === "comments") {
        if (req.method === "GET") {
          const a2 = await authUser(req);
          const all = (await fbGet(`itd/comments/${pid}`)) || {};
          const comments = [];
          for (const c of objVals(all).sort((x, y) => (x.createdAt || "").localeCompare(y.createdAt || "")))
            comments.push(await commentJson(c, a2 ? a2.user : null));
          return j(res, 200, { data: { comments, hasMore: false, nextCursor: null, total: comments.length } });
        }
        if (req.method === "POST") {
          const a2 = await authUser(req);
          if (!a2) return errRes(res, 401, "UNAUTHORIZED", "Требуется вход");
          const b = parseJson(await readBody(req));
          const cid = uuid();
          const c = { id: cid, postId: pid, authorId: a2.user.id, content: String(b.content || ""), attachments: [], likes: {}, repliesCount: 0, replyTo: b.replyTo || b.replyToUserId || null, createdAt: new Date().toISOString() };
          await fbSet(`itd/comments/${pid}/${cid}`, c);
          await fbSet(`itd/posts/${pid}/commentsCount`, (post.commentsCount || 0) + 1);
          if (post.authorId !== a2.user.id) await notify(post.authorId, "COMMENT", a2.user, pid);
          return j(res, 200, { comment: await commentJson(c, a2.user) });
        }
      }
    }

    /* ================= УВЕДОМЛЕНИЯ ================= */
    if (path === "/api/notifications/count") {
      const a = await authUser(req);
      if (!a) return j(res, 200, { count: 0 });
      const n = (await fbGet(`itd/notifications/${a.user.id}`)) || {};
      return j(res, 200, { count: objVals(n).filter((x) => !x.read).length });
    }
    if (path === "/api/notifications/read-all" && req.method === "POST") {
      const a = await authUser(req);
      if (a) {
        const n = (await fbGet(`itd/notifications/${a.user.id}`)) || {};
        for (const k of Object.keys(n)) { n[k].read = true; }
        await fbSet(`itd/notifications/${a.user.id}`, n);
      }
      return j(res, 200, {});
    }
    if (path === "/api/notifications/settings") {
      if (req.method === "GET") return j(res, 200, {});
      await readBody(req); return j(res, 200, {});
    }
    if (path === "/api/notifications" && req.method === "GET") {
      const a = await authUser(req);
      if (!a) return j(res, 200, { hasMore: false, notifications: [] });
      const n = (await fbGet(`itd/notifications/${a.user.id}`)) || {};
      const notifications = objVals(n).sort((x, y) => (y.createdAt || "").localeCompare(x.createdAt || ""));
      return j(res, 200, { hasMore: false, notifications });
    }
    if (path === "/api/notifications/stream" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.write(": connected\n\n");
      const iv = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 20000);
      req.on("close", () => clearInterval(iv));
      return;
    }

    /* ================= УСТРОЙСТВА / ПЛАТФОРМА / ПОИСК ================= */
    if (path === "/api/devices" && req.method === "POST") {
      const b = parseJson(await readBody(req));
      await fbSet(`itd/devices/${safeKey(sha(String(b.token || uuid())))}`, { ...b, at: Date.now() });
      return j(res, 200, { id: uuid() });
    }
    if (path.startsWith("/api/devices/")) { await readBody(req); return j(res, 200, {}); }
    if (path === "/api/platform/version") return j(res, 200, { android: { latestVersion: APP_VERSION, minVersion: "1.0.0", updateUrl: null } });
    if (path === "/api/platform/announcements") return j(res, 200, { announcements: [] });
    if (path === "/api/search/" || path.startsWith("/api/search/")) {
      const query = decodeURIComponent(path.slice("/api/search/".length)).toLowerCase();
      const usersIdx = (await fbGet("itd/username_index")) || {};
      const users = [];
      for (const [uname, uid] of Object.entries(usersIdx)) {
        if (uname.includes(query)) { const u = await fbGet(`itd/users/${uid}`); if (u) users.push({ id: u.id, username: (u.profile && u.profile.username) || uname, displayName: (u.profile && u.profile.displayName) || "", avatar: (u.profile && u.profile.avatar) || null, verified: false, hasNuksta: false, isFollowing: false }); }
      }
      return j(res, 200, { data: { users: users.slice(0, 20), posts: [], hashtags: [] } });
    }
    if (path === "/api/hashtags/trending") return j(res, 200, { data: { hashtags: [] } });
    if (path === "/api/users/suggestions/who-to-follow") return j(res, 200, { users: [] });
    if (path === "/api/users/stats/top-clans") return j(res, 200, { clans: [] });
    if (path === "/api/reports" && req.method === "POST") { await readBody(req); return j(res, 200, {}); }

    if (path.startsWith("/api/")) {
      await readBody(req);
      console.log(`    [заглушка] ${req.method} ${path}`);
      return j(res, 200, {});
    }
    return errRes(res, 404, "NOT_FOUND", "Не найдено");
  } catch (e) {
    console.error("ERROR:", path, e.message);
    if (!res.headersSent) return errRes(res, 500, "INTERNAL", "Внутренняя ошибка моста");
  }
});

server.listen(PORT, "0.0.0.0", () =>
  console.log(`*** Мост v2 ИТД <-> Firebase на :${PORT} (БД: ${DB})`));
