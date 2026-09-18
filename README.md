# Мост «ИТД → Firebase»

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/moidpugedshan/itd-bridge)

**Быстрый деплой: жми кнопку выше → Sign in with GitHub → Create Resources → жди 2 минуты → получишь постоянный адрес.**

Этот сервер связывает модифицированное приложение ИТД с твоей базой
Firebase Realtime DB (`coolchel-bf775`). Один раз развернёшь — и адрес
больше никогда не поменяется, никакие Error 1033 не страшны.

В папке: `server.js` (сам мост), `package.json`, `render.yaml`, `Procfile`.

---

## Вариант 1 — Render.com (рекомендую, бесплатно, без карты)

1. Зайди на **https://render.com** → Sign Up (можно через Google)
2. Нажми **New + → Web Service**
3. Если спросит «Where is your code?» — выбери
   **«Deploy without Git / Public Git repository»** или создай репозиторий (шаг Б)

### Вариант через GitHub (надёжнее)
Б.1. Создай аккаунт на **github.com** → **New repository** → назови `itd-bridge`,
    Public → Create
Б.2. Нажми **«uploading an existing file»** → перетащи ВСЕ 5 файлов из этой
     папки → **Commit changes**
Б.3. На Render: New + → Web Service → **GitHub** → выбери `itd-bridge` → Connect

### Настройка (одинакова для обоих путей)
- **Runtime**: Node
- **Build Command**: оставь как есть (или `true`)
- **Start Command**: `node server.js`
- **Instance Type**: **Free**
- Environment Variable: `FIREBASE_DB` = `coolchel-bf775-default-rtdb.firebaseio.com`
4. Жми **Create Web Service** → жди 1–2 минуты
5. Вверху страницы появится адрес вида **`https://itd-bridge-xxxx.onrender.com`** —
   это и есть вечный адрес твоего сервера ✅

## Вариант 2 — Railway.app (тоже бесплатно, быстрее старт)

1. Зайди на **https://railway.app** → Sign in with GitHub
2. **New Project → Deploy from GitHub repo** → выбери репозиторий с этими файлами
3. В настройках сервиса → **Settings → Networking → Generate Domain** — получишь адрес
4. В **Variables** добавь: `FIREBASE_DB` = `coolchel-bf775-default-rtdb.firebaseio.com`

## Вариант 3 — свой VPS/компьютер

```bash
node server.js          # PORT и FIREBASE_DB — необязательные переменные окружения
```

---

## ⚠️ ВАЖНО: после получения адреса напиши его мне в чат

Я пересоберу APK с твоим постоянным адресом (займёт ~2 минуты) — и всё
будет работать всегда, без перезапусков и смены адресов.

Пока адрес не вшит в приложение — продолжай пользоваться текущей сборкой
(она работает, пока активна наша сессия в чате).

## Проверка, что мост работает

Открой в браузере: `https://ТВОЙ-АДРЕС/health`
Должно быть: `{"ok":true,"bridge":"itd2firebase-v2",...}`

## Что умеет мост

- Регистрация/вход по email + код подтверждения (показывается в приложении,
  мастер-код `000000`)
- Профили, username, аватарки, поиск пользователей
- Посты, лента, лайки, комментарии, подписки, счётчики
- Уведомления (в приложении), сессии, выход
- Загрузка картинок/файлов (хранятся в Firebase)
- Все данные лежат в твоей Firebase-базе в узле `itd/`
