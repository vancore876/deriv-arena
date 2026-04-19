// ──────────────────────────────────────────────────────────────────
// STRATFORGE ARENA — Express + WebSocket Server
// ──────────────────────────────────────────────────────────────────

require('dotenv').config();
const express  = require('express');
const http     = require('http');
const WebSocket = require('ws');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { DerivBot, MARKETS } = require('./bot');
const { DEFAULT_SMC_SETTINGS, mergeSmcSettings } = require('./smc-engine');
const { PRESETS } = require('./strategies');
const { installOpenClawJarvisRoutes } = require('./openclaw-jarvis-routes');
const { enqueueMt5Command, getMt5Events, saveMt5User } = require('./mt5-client');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'stratforge_secret_key_change_me';
const DATA_FILE  = path.join(__dirname, '../data/users.json');
const MT5_SECRET = process.env.MT5_CRED_SECRET || `${JWT_SECRET}_mt5`;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── User store ───────────────────────────────────────────────────


function defaultArenaProfile() {
  return {
    market: 'R_25',
    mode: 'digits',
    preset: 'balanced',
    autoEdgeEnabled: true,
    manualMarketOverride: false,
    manualModeOverride: false,
    userSettings: {},
    lockedSettingPaths: [],
  };
}

function defaultMt5Profile() {
  return {
    enabled: false,
    login: '',
    passwordEncrypted: '',
    server: '',
    bridgeUrl: process.env.STRATFORGE_MT5_API || process.env.MT5_BRIDGE_URL || 'http://104.238.214.215:9000',
    followAdmin: false,
    mirrorAdminTrades: false,
    riskMultiplier: 1,
    sameAsAdmin: false,
    liveTradingEnabled: false,
    allowedSymbols: ['XAUUSD', 'Volatility 75 Index', 'Volatility 100 Index'],
    smcSettings: mergeSmcSettings(DEFAULT_SMC_SETTINGS, {})
  };
}

function buildMt5Key() {
  return crypto.createHash('sha256').update(String(MT5_SECRET)).digest();
}

function encryptMt5Password(value = '') {
  const plain = String(value || '');
  if (!plain) return '';
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', buildMt5Key(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptMt5Password(value = '') {
  try {
    if (!value) return '';
    const [ivHex, dataHex] = String(value).split(':');
    if (!ivHex || !dataHex) return '';
    const decipher = crypto.createDecipheriv('aes-256-cbc', buildMt5Key(), Buffer.from(ivHex, 'hex'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (_error) {
    return '';
  }
}

function sanitizeMt5Config(mt5 = {}) {
  const merged = { ...defaultMt5Profile(), ...(mt5 || {}) };
  return {
    enabled: Boolean(merged.enabled),
    login: String(merged.login || ''),
    server: String(merged.server || ''),
    bridgeUrl: String(merged.bridgeUrl || defaultMt5Profile().bridgeUrl),
    followAdmin: Boolean(merged.followAdmin),
    mirrorAdminTrades: Boolean(merged.mirrorAdminTrades),
    riskMultiplier: Math.max(0.1, Number(merged.riskMultiplier || 1)),
    sameAsAdmin: Boolean(merged.sameAsAdmin),
    liveTradingEnabled: Boolean(merged.liveTradingEnabled),
    allowedSymbols: Array.isArray(merged.allowedSymbols) ? merged.allowedSymbols.slice(0, 20) : defaultMt5Profile().allowedSymbols,
    smcSettings: mergeSmcSettings(DEFAULT_SMC_SETTINGS, merged.smcSettings || {}),
    passwordSet: Boolean(merged.passwordEncrypted)
  };
}

function mergeUserDefaults(user) {
  if (!user) return user;
  user.mt5 = { ...defaultMt5Profile(), ...(user.mt5 || {}) };
  user.arenaProfile = { ...defaultArenaProfile(), ...(user.arenaProfile || {}) };
  return user;
}


function persistBotMt5Config(userId, bot) {
  if (!userId || !bot) return;
  const db = loadUsers();
  const user = db.users.find((entry) => entry.id === userId);
  if (!user) return;
  mergeUserDefaults(user);
  const botMt5 = bot.getMt5AccountProfile?.() || {};
  user.mt5.enabled = Boolean(botMt5.venueEnabled);
  user.mt5.login = String(botMt5.accountLogin || user.mt5.login || '');
  user.mt5.server = String(botMt5.accountServer || user.mt5.server || '');
  user.mt5.bridgeUrl = String(botMt5.bridgeUrl || user.mt5.bridgeUrl || defaultMt5Profile().bridgeUrl);
  user.mt5.followAdmin = Boolean(botMt5.copyTrading?.followAdmin);
  user.mt5.mirrorAdminTrades = Boolean(botMt5.copyTrading?.mirrorAdminTrades);
  user.mt5.riskMultiplier = Math.max(0.1, Number(botMt5.copyTrading?.riskMultiplier || user.mt5.riskMultiplier || 1));
  user.mt5.sameAsAdmin = Boolean(botMt5.copyTrading?.sameAsAdmin);
  user.mt5.liveTradingEnabled = Boolean(botMt5.liveTradingEnabled);
  user.mt5.allowedSymbols = Array.isArray(botMt5.watchlist) && botMt5.watchlist.length ? botMt5.watchlist.slice(0, 20) : user.mt5.allowedSymbols;
  user.mt5.smcSettings = mergeSmcSettings(DEFAULT_SMC_SETTINGS, botMt5.smcSettings || user.mt5.smcSettings || {});

  user.arenaProfile = {
    ...defaultArenaProfile(),
    ...(user.arenaProfile || {}),
    market: bot.market,
    mode: bot.mode,
    preset: bot.selectedPreset || bot.preset,
    autoEdgeEnabled: Boolean(bot.autoEdgeEnabled),
    manualMarketOverride: Boolean(bot.manualMarketOverride),
    manualModeOverride: Boolean(bot.manualModeOverride),
    userSettings: JSON.parse(JSON.stringify(bot.userSettings || {})),
    lockedSettingPaths: Array.from(bot.lockedSettingPaths || []),
  };
  saveUsers(db);
}
function loadUsers() {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) {
      const admin = {
        id: 'admin',
        username: 'admin',
        password: bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10),
        role: 'admin',
        expiresAt: null,
        xp: 0,
        level: 1,
        createdAt: Date.now(),
        mt5: defaultMt5Profile()
      };
      fs.writeFileSync(DATA_FILE, JSON.stringify({ users: [admin] }, null, 2));
    }
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    parsed.users = Array.isArray(parsed.users) ? parsed.users.map(mergeUserDefaults) : [];
    return parsed;
  } catch (e) {
    return { users: [] };
  }
}

function saveUsers(data) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ─── Auth middleware ──────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    // Check expiry
    const db   = loadUsers();
    const user = db.users.find(u => u.id === req.user.id);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.expiresAt && Date.now() > user.expiresAt) {
      return res.status(403).json({ error: 'Account expired' });
    }
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── REST endpoints ───────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  const db = loadUsers();
  const user = db.users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  if (user.expiresAt && Date.now() > user.expiresAt) {
    return res.status(403).json({ error: 'Account has expired' });
  }
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username: user.username, role: user.role, xp: user.xp, level: user.level });
});

app.post('/api/signup', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || password.length < 6) {
    return res.status(400).json({ error: 'Username and password (min 6 chars) required' });
  }
  const db = loadUsers();
  if (db.users.find(u => u.username === username)) {
    return res.status(409).json({ error: 'Username already taken' });
  }
  const user = {
    id: 'u_' + Date.now(),
    username,
    password: bcrypt.hashSync(password, 10),
    role: 'user',
    expiresAt: null,
    xp: 0,
    level: 1,
    createdAt: Date.now(),
    mt5: defaultMt5Profile()
  };
  db.users.push(user);
  saveUsers(db);
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username: user.username, role: user.role, xp: 0, level: 1 });
});

app.get('/api/user/mt5/profile', authMiddleware, (req, res) => {
  const db = loadUsers();
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  mergeUserDefaults(user);
  res.json({ ok: true, mt5: sanitizeMt5Config(user.mt5) });
});

app.post('/api/user/mt5/profile', authMiddleware, (req, res) => {
  const db = loadUsers();
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  mergeUserDefaults(user);
  const body = req.body || {};
  if (body.login !== undefined) user.mt5.login = String(body.login || '');
  if (body.server !== undefined) user.mt5.server = String(body.server || '');
  if (body.bridgeUrl !== undefined) user.mt5.bridgeUrl = String(body.bridgeUrl || defaultMt5Profile().bridgeUrl);
  if (body.password !== undefined && String(body.password).trim()) user.mt5.passwordEncrypted = encryptMt5Password(String(body.password));
  if (body.followAdmin !== undefined) user.mt5.followAdmin = Boolean(body.followAdmin);
  if (body.mirrorAdminTrades !== undefined) user.mt5.mirrorAdminTrades = Boolean(body.mirrorAdminTrades);
  if (body.riskMultiplier !== undefined) user.mt5.riskMultiplier = Math.max(0.1, Number(body.riskMultiplier || 1));
  if (body.sameAsAdmin !== undefined) user.mt5.sameAsAdmin = Boolean(body.sameAsAdmin);
  if (body.liveTradingEnabled !== undefined) user.mt5.liveTradingEnabled = Boolean(body.liveTradingEnabled);
  if (body.enabled !== undefined) user.mt5.enabled = Boolean(body.enabled);
  if (Array.isArray(body.allowedSymbols)) user.mt5.allowedSymbols = body.allowedSymbols.slice(0, 20);
  if (body.smcSettings && typeof body.smcSettings === 'object') user.mt5.smcSettings = mergeSmcSettings(user.mt5.smcSettings || DEFAULT_SMC_SETTINGS, body.smcSettings);
  saveUsers(db);
  res.json({ ok: true, mt5: sanitizeMt5Config(user.mt5) });
});

// Admin: list users
app.get('/api/admin/users', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const db = loadUsers();
  const safe = db.users.map(({ password, ...u }) => u);
  res.json(safe);
});

// Admin: update user
app.patch('/api/admin/users/:id', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const db = loadUsers();
  const idx = db.users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  const { expiresAt, disabled } = req.body;
  if (expiresAt !== undefined) db.users[idx].expiresAt = expiresAt;
  if (disabled  !== undefined) db.users[idx].disabled  = disabled;
  saveUsers(db);
  res.json({ ok: true });
});

// Get presets
app.get('/api/presets', authMiddleware, (req, res) => {
  res.json(PRESETS);
});

// Get markets
app.get('/api/markets', authMiddleware, (req, res) => {
  res.json(MARKETS);
});


installOpenClawJarvisRoutes({
  app,
  authMiddleware,
  getSnapshot: (req) => bots.get(req.user?.id)?.getState?.() || {},
  getBot: (req) => bots.get(req.user?.id),
  broadcast: (req, event, data) => {
    if (req.user?.id) broadcast(req.user.id, event, data);
  }
});


app.post('/api/mt5/account', authMiddleware, async (req, res) => {
  try {
    const userId = String(req.body?.userId || req.user.id || '').trim();
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    if (req.user.role !== 'admin' && userId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const result = await enqueueMt5Command(userId, 'account_info', {});
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

app.get('/api/mt5/events', authMiddleware, async (req, res) => {
  try {
    const userId = String(req.query?.userId || req.user.id || '').trim();
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    if (req.user.role !== 'admin' && userId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const events = await getMt5Events(userId);
    res.json(events);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});


app.get('/api/mt5/positions', authMiddleware, async (req, res) => {
  try {
    const userId = String(req.query?.userId || req.user.id || '').trim();
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    if (req.user.role !== 'admin' && userId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const result = await enqueueMt5Command(userId, 'positions', {});
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

app.post('/api/mt5/place-order', authMiddleware, async (req, res) => {
  try {
    const userId = String(req.body?.userId || req.user.id || '').trim();
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    if (req.user.role !== 'admin' && userId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { symbol, side, volume, sl, tp } = req.body || {};
    if (!symbol || !side || !volume) return res.status(400).json({ error: 'Missing order fields' });
    const result = await enqueueMt5Command(userId, 'place_order', { symbol, side, volume, sl, tp });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

app.post('/api/mt5/modify-sl-tp', authMiddleware, async (req, res) => {
  try {
    const userId = String(req.body?.userId || req.user.id || '').trim();
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    if (req.user.role !== 'admin' && userId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { position_ticket, sl, tp } = req.body || {};
    if (!position_ticket) return res.status(400).json({ error: 'Missing position_ticket' });
    const result = await enqueueMt5Command(userId, 'modify_sl_tp', { position_ticket, sl, tp });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

app.post('/api/mt5/close-position', authMiddleware, async (req, res) => {
  try {
    const userId = String(req.body?.userId || req.user.id || '').trim();
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    if (req.user.role !== 'admin' && userId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { ticket, volume } = req.body || {};
    if (!ticket) return res.status(400).json({ error: 'Missing ticket' });
    const result = await enqueueMt5Command(userId, 'close_position', { ticket, volume });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

app.post('/api/mt5/flatten', authMiddleware, async (req, res) => {
  try {
    const userId = String(req.body?.userId || req.user.id || '').trim();
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    if (req.user.role !== 'admin' && userId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const result = await enqueueMt5Command(userId, 'flatten', {});
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

app.post('/api/mt5/save', authMiddleware, async (req, res) => {
  try {
    const { userId: rawUserId, ...mt5 } = req.body || {};
    const userId = String(rawUserId || req.user.id || '').trim();
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    if (req.user.role !== 'admin' && userId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const localDb = loadUsers();
    const localUser = localDb.users.find(u => u.id === userId);
    if (!localUser) return res.status(404).json({ error: 'User not found' });
    mergeUserDefaults(localUser);
    if (mt5.login !== undefined) localUser.mt5.login = String(mt5.login || '');
    if (mt5.server !== undefined) localUser.mt5.server = String(mt5.server || '');
    if (mt5.bridgeUrl !== undefined) localUser.mt5.bridgeUrl = String(mt5.bridgeUrl || defaultMt5Profile().bridgeUrl);
    if (mt5.password !== undefined && String(mt5.password).trim()) localUser.mt5.passwordEncrypted = encryptMt5Password(String(mt5.password));
    if (mt5.followAdmin !== undefined) localUser.mt5.followAdmin = Boolean(mt5.followAdmin);
    if (mt5.riskMultiplier !== undefined) localUser.mt5.riskMultiplier = Math.max(0.1, Number(mt5.riskMultiplier || 1));
    if (mt5.liveTradingArmed !== undefined) localUser.mt5.liveTradingEnabled = Boolean(mt5.liveTradingArmed);
    if (mt5.enabled !== undefined) localUser.mt5.enabled = Boolean(mt5.enabled);
    if (Array.isArray(mt5.allowedSymbols)) localUser.mt5.allowedSymbols = mt5.allowedSymbols.slice(0, 20);
    if (mt5.smcSettings && typeof mt5.smcSettings === 'object') localUser.mt5.smcSettings = mergeSmcSettings(localUser.mt5.smcSettings || DEFAULT_SMC_SETTINGS, mt5.smcSettings);
    saveUsers(localDb);

    const result = await saveMt5User(userId, {
      login: localUser.mt5.login,
      password: mt5.password !== undefined ? String(mt5.password || '') : decryptMt5Password(localUser.mt5.passwordEncrypted || ''),
      server: localUser.mt5.server,
      enabled: localUser.mt5.enabled,
      terminalAlias: `${userId}-mt5`,
      followAdmin: localUser.mt5.followAdmin,
      riskMultiplier: localUser.mt5.riskMultiplier,
      allowedSymbols: localUser.mt5.allowedSymbols,
      liveTradingArmed: localUser.mt5.liveTradingEnabled
    });

    res.json({ ok: true, mt5: sanitizeMt5Config(localUser.mt5), bridge: result });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

app.get('/api/mt5/accounts', authMiddleware, (req, res) => {
  const currentBot = bots.get(req.user.id);
  const current = currentBot?.getMt5AccountProfile?.() || null;
  const followers = Array.from(bots.values())
    .filter((bot) => bot.userId !== req.user.id && bot.isFollowingAdmin?.())
    .map((bot) => bot.getMt5AccountProfile?.())
    .filter(Boolean);
  res.json({ ok: true, current, followers });
});

// ─── WebSocket server ─────────────────────────────────────────────
const clients = new Map(); // userId → ws
const bots    = new Map(); // userId → DerivBot

function broadcast(userId, event, data) {
  const ws = clients.get(userId);
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ event, data }));
  }
}

wss.on('connection', (ws, req) => {
  let userId = null;
  let bot    = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    const { action, payload } = msg;

    // ── Auth ─────────────────────────────────────────────────────
    if (action === 'auth') {
      let decoded;
      try {
        decoded = jwt.verify(payload?.token, JWT_SECRET);
      } catch (error) {
        ws.send(JSON.stringify({ event: 'auth_failed', data: { reason: 'Bad token' } }));
        return;
      }

      try {
        const db = loadUsers();
        const user = db.users.find(u => u.id === decoded.id);
        if (!user || (user.expiresAt && Date.now() > user.expiresAt)) {
          ws.send(JSON.stringify({ event: 'auth_failed', data: { reason: 'Expired or invalid' } }));
          return;
        }
        userId = decoded.id;
        clients.set(userId, ws);

        if (!bots.has(userId)) {
          bots.set(userId, new DerivBot(userId, broadcast, { role: user.role, username: user.username, mt5Config: {
            ...(user.mt5 || {}),
            password: decryptMt5Password(user.mt5?.passwordEncrypted || '')
          },
          arenaProfile: user.arenaProfile || defaultArenaProfile() }));
        }
        bot = bots.get(userId);
        persistBotMt5Config(userId, bot);
        ws.send(JSON.stringify({ event: 'auth_ok', data: { username: decoded.username, role: decoded.role, state: bot.getState() } }));
      } catch (error) {
        console.error('WebSocket auth session initialization failed:', error);
        ws.send(JSON.stringify({ event: 'error', data: { message: 'Session initialization failed' } }));
      }
      return;
    }

    if (!userId || !bot) { ws.send(JSON.stringify({ event: 'error', data: 'Not authenticated' })); return; }
    const persistBot = () => persistBotMt5Config(userId, bot);

    // ── Bot commands ──────────────────────────────────────────────
    switch (action) {
      case 'connect_deriv':
        bot.connect(payload.token);
        persistBot();
        break;
      case 'disconnect_deriv':
        bot.disconnect();
        break;
      case 'start_ticks':
        bot.market = payload.market || bot.market;
        bot.startTicks();
        break;
      case 'stop_ticks':
        bot.stopTicks();
        break;
      case 'set_mode':
        bot.setMode(payload.mode, payload.preset, { manual: true });
        persistBot();
        break;
      case 'set_auto_edge':
        bot.setAutoEdge(payload.enabled);
        broadcast(userId, 'state', bot.getState());
        persistBot();
        break;
      case 'set_market':
        bot.setMarket(payload.market, { manual: true });
        persistBot();
        break;
      case 'start_bot':
        bot.start();
        persistBot();
        break;
      case 'stop_bot':
        bot.stop();
        persistBot();
        break;
      case 'reset_session':
        bot.resetSession();
        break;
      case 'reset_analyzer':
        bot.resetAnalyzer();
        break;
      case 'update_settings': {
        bot.updateSettings(payload, { manual: true, reason: 'settings-updated' });

        broadcast(userId, 'settings_saved', { settings: bot.settings });
        broadcast(userId, 'state', bot.getState());
        persistBot();
        break;
      }
      case 'update_indicator_settings': {
        bot.updateIndicatorSettings(payload || {});
        broadcast(userId, 'settings_saved', { settings: bot.settings, indicatorSettings: bot.settings?.entryFilter || {} });
        broadcast(userId, 'state', bot.getState());
        persistBot();
        break;
      }
      case 'overseer_command':
        bot.executeOverseerCommand(payload.command, payload.payload || {});
        ws.send(JSON.stringify({ event: 'mission_state', data: bot.getMissionState() }));
        break;
      case 'get_state':
        ws.send(JSON.stringify({ event: 'state', data: bot.getState() }));
        break;
    }
  });

  ws.on('close', () => {
    if (userId) {
      clients.delete(userId);
      // Bot keeps running, just UI disconnected
    }
  });
});

setInterval(() => {
  const adminBot = bots.get('admin');
  if (!adminBot) return;
  const adminState = adminBot.getState();
  for (const [id, bot] of bots.entries()) {
    if (id === 'admin') continue;
    if (bot?.isFollowingAdmin?.()) {
      bot.syncFromMaster?.(adminState);
      broadcast(id, 'mission_state', bot.getMissionState());
      broadcast(id, 'state', bot.getState());
    }
  }
}, 8000);

// ─── Serve SPA for all non-API routes ─────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

server.listen(PORT, () => {
  console.log(`\n🚀 StratForge Arena running on http://localhost:${PORT}`);
  console.log(`   Default login: admin / ${process.env.ADMIN_PASSWORD || 'admin123'}\n`);
});
