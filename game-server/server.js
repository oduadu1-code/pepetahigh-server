'use strict';
/**
 * PepetaHigh — game-server/server.js  v2
 * ─────────────────────────────────────────────────────────────────────
 * Central WebSocket hub for all games.
 *
 * Connection URL format:
 *   ws://host:4000?game=aviator&token=<JWT>          ← player
 *   ws://host:4000?game=aviator&token=<JWT>&admin=1  ← admin predictor
 *
 * Admin connections receive getAdminState() which includes crashAt.
 * Regular connections receive getState() which never reveals crashAt.
 *
 * ENV VARS (game-server/.env):
 *   PORT=4000
 *   JWT_SECRET=<same as main backend>
 *   MAIN_BACKEND_URL=https://pepetahigh-backend.onrender.com
 *   GAME_SERVER_SECRET=<random secret for server-to-server calls>
 *   ADMIN_SECRET=<secret query param that grants admin access>
 */

require('dotenv').config();

const http    = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const jwt     = require('jsonwebtoken');
const axios   = require('axios');

const aviator = require('./games/aviator');
const rocket  = require('./games/rocket');
const dice    = require('./games/dice');
const mines   = require('./games/mines');
const fortune = require('./games/fortune');

// ── Config ────────────────────────────────────────────────────────────
const PORT          = process.env.PORT || 4000;
const JWT_SECRET    = process.env.JWT_SECRET;
const BACKEND_URL   = process.env.MAIN_BACKEND_URL || 'https://pepetahigh-backend.onrender.com';
const ADMIN_SECRET  = process.env.ADMIN_SECRET || 'change-this-admin-secret';

if (!JWT_SECRET) { console.error('[game-server] JWT_SECRET not set!'); process.exit(1); }

// ── HTTP server ───────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  } else {
    res.writeHead(404); res.end();
  }
});

const wss = new WebSocketServer({ server });

// ── Rooms: regular players ────────────────────────────────────────────
const rooms = {
  aviator : new Set(),
  rocket  : new Set(),
  dice    : new Set(),
  mines   : new Set(),
  fortune : new Set(),
};

// ── Admin room: receives crash predictions ────────────────────────────
// Admin clients connect with ?admin=1&secret=ADMIN_SECRET
const adminRoom = new Set();

// ── Helpers ───────────────────────────────────────────────────────────
function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(game, obj) {
  const msg = JSON.stringify(obj);
  for (const ws of rooms[game]) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

// Broadcast admin state to all admin connections (aviator + rocket)
function broadcastAdmin(adminState) {
  const msg = JSON.stringify(adminState);
  for (const ws of adminRoom) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function verifyJWT(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

// ── Wallet calls to main backend ──────────────────────────────────────
async function debitWallet(userId, amount, game) {
  const res = await axios.post(`${BACKEND_URL}/api/wallet/debit`, {
    userId, amount, game,
    secret: process.env.GAME_SERVER_SECRET
  });
  return res.data;
}

async function creditWallet(userId, amount, game, reason) {
  const res = await axios.post(`${BACKEND_URL}/api/wallet/credit`, {
    userId, amount, game, reason,
    secret: process.env.GAME_SERVER_SECRET
  });
  return res.data;
}

// ── Game states ───────────────────────────────────────────────────────
const state = {
  aviator : aviator.createState(),
  rocket  : rocket.createState(),
};

// ─────────────────────────────────────────────────────────────────────
// CONNECTION HANDLER
// ─────────────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const url    = new URL(req.url, `http://localhost`);
  const game   = url.searchParams.get('game');
  const token  = url.searchParams.get('token');
  const isAdmin = url.searchParams.get('admin') === '1' &&
                  url.searchParams.get('secret') === ADMIN_SECRET;

  // ── Admin connection ───────────────────────────────────────────────
  if (isAdmin) {
    ws.isAdmin = true;
    adminRoom.add(ws);
    console.log(`[admin] New admin connection. Total: ${adminRoom.size}`);

    // Send current state immediately
    if (game === 'aviator' || !game) {
      send(ws, aviator.getAdminState(state.aviator));
    }

    ws.on('close', () => {
      adminRoom.delete(ws);
      console.log(`[admin] Disconnected. Total: ${adminRoom.size}`);
    });
    return; // admin connections don't play — just observe
  }

  // ── Player connection ──────────────────────────────────────────────
  if (!game || !rooms[game]) {
    send(ws, { type: 'error', code: 'INVALID_GAME', msg: `Unknown game: ${game}` });
    ws.close();
    return;
  }

  let user = null;
  if (token) {
    const payload = verifyJWT(token);
    if (payload) user = { userId: payload.userId };
  }

  ws.user  = user;
  ws.game  = game;
  ws.mode  = user ? 'play' : 'spectate';

  rooms[game].add(ws);
  console.log(`[${game}] +1 client (${user ? 'auth' : 'guest'}). Room: ${rooms[game].size}`);

  send(ws, { type: 'connected', game, authenticated: !!user });
  sendGameState(ws, game);

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { send(ws, { type: 'error', msg: 'Invalid JSON' }); return; }
    try { await handleMessage(ws, game, msg); }
    catch (err) {
      console.error(`[${game}] handler error:`, err.message);
      send(ws, { type: 'error', msg: err.message || 'Server error' });
    }
  });

  ws.on('close', () => {
    rooms[game].delete(ws);
    console.log(`[${game}] -1 client. Room: ${rooms[game].size}`);
  });
});

// ─────────────────────────────────────────────────────────────────────
// INITIAL STATE ON CONNECT
// ─────────────────────────────────────────────────────────────────────
function sendGameState(ws, game) {
  if (game === 'aviator') {
    send(ws, { type: 'state', ...aviator.getState(state.aviator) });
  } else if (game === 'rocket') {
    send(ws, { type: 'state', ...rocket.getState(state.rocket) });
  }
}

// ─────────────────────────────────────────────────────────────────────
// MESSAGE ROUTER
// ─────────────────────────────────────────────────────────────────────
async function handleMessage(ws, game, msg) {
  if (msg.type === 'set_mode') {
    ws.mode = msg.mode === 'demo' ? 'demo' : 'play';
    send(ws, { type: 'mode_set', mode: ws.mode });
    return;
  }
  switch (game) {
    case 'aviator': return handleAviator(ws, msg);
    case 'rocket' : return handleRocket(ws, msg);
    case 'dice'   : return handleDice(ws, msg);
    case 'mines'  : return handleMines(ws, msg);
    case 'fortune': return handleFortune(ws, msg);
  }
}

// ─────────────────────────────────────────────────────────────────────
// AVIATOR HANDLER
// ─────────────────────────────────────────────────────────────────────
async function handleAviator(ws, msg) {
  const { type } = msg;

  if (type === 'bet') {
    if (ws.mode === 'play' && !ws.user) {
      send(ws, { type: 'error', code: 'AUTH_REQUIRED', msg: 'Login to place real bets' }); return;
    }
    const amount      = parseFloat(msg.amount);
    const autoCashout = parseFloat(msg.autoCashout) || null;

    if (!amount || amount < 20) { send(ws, { type: 'error', msg: 'Minimum bet is KSh 20' }); return; }
    if (state.aviator.phase !== 'waiting') { send(ws, { type: 'error', msg: 'Bets closed — wait for next round' }); return; }

    if (ws.mode === 'play') await debitWallet(ws.user.userId, amount, 'aviator');

    const betId = aviator.placeBet(state.aviator, ws, amount, autoCashout);
    ws.avBetId = betId;

    send(ws, { type: 'bet_accepted', betId, amount, autoCashout });
    broadcast('aviator', { type: 'bet_placed', betId, amount });
    return;
  }

  if (type === 'cashout') {
    if (!ws.avBetId) { send(ws, { type: 'error', msg: 'No active bet' }); return; }
    if (state.aviator.phase !== 'flying') { send(ws, { type: 'error', msg: 'Game not in flight' }); return; }

    const result = aviator.cashout(state.aviator, ws.avBetId, state.aviator.multiplier);
    if (!result) { send(ws, { type: 'error', msg: 'Cashout failed' }); return; }

    if (ws.mode === 'play') {
      await creditWallet(ws.user.userId, result.payout, 'aviator', `cashout @${state.aviator.multiplier.toFixed(2)}x`);
    }

    ws.avBetId = null;
    send(ws, { type: 'cashout_success', payout: result.payout, mult: state.aviator.multiplier });
    return;
  }
}

// ─────────────────────────────────────────────────────────────────────
// ROCKET CRASH HANDLER
// ─────────────────────────────────────────────────────────────────────
async function handleRocket(ws, msg) {
  const { type } = msg;

  if (type === 'bet') {
    if (ws.mode === 'play' && !ws.user) {
      send(ws, { type: 'error', code: 'AUTH_REQUIRED', msg: 'Login to place real bets' }); return;
    }
    const amount = parseFloat(msg.amount);
    if (!amount || amount < 20) { send(ws, { type: 'error', msg: 'Minimum bet is KSh 20' }); return; }
    if (state.rocket.phase !== 'waiting') { send(ws, { type: 'error', msg: 'Bets closed' }); return; }

    if (ws.mode === 'play') await debitWallet(ws.user.userId, amount, 'rocket');
    const betId = rocket.placeBet(state.rocket, ws, amount, msg.autoCashout || null);
    ws.rkBetId = betId;
    send(ws, { type: 'bet_accepted', betId, amount });
    return;
  }

  if (type === 'cashout') {
    if (!ws.rkBetId || state.rocket.phase !== 'flying') { send(ws, { type: 'error', msg: 'Cannot cashout now' }); return; }
    const result = rocket.cashout(state.rocket, ws.rkBetId, state.rocket.multiplier);
    if (!result) { send(ws, { type: 'error', msg: 'Cashout failed' }); return; }
    if (ws.mode === 'play') await creditWallet(ws.user.userId, result.payout, 'rocket', `cashout @${state.rocket.multiplier.toFixed(2)}x`);
    ws.rkBetId = null;
    send(ws, { type: 'cashout_success', payout: result.payout, mult: state.rocket.multiplier });
  }
}

// ─────────────────────────────────────────────────────────────────────
// DICE HANDLER
// ─────────────────────────────────────────────────────────────────────
async function handleDice(ws, msg) {
  if (msg.type !== 'roll') return;
  if (ws.mode === 'play' && !ws.user) {
    send(ws, { type: 'error', code: 'AUTH_REQUIRED', msg: 'Login to roll for real' }); return;
  }

  const amount    = parseFloat(msg.amount);
  const target    = parseFloat(msg.target);
  const direction = msg.direction || 'under';

  if (!amount || amount < 20) { send(ws, { type: 'error', msg: 'Minimum bet KSh 20' }); return; }
  if (!target || target < 2 || target > 98) { send(ws, { type: 'error', msg: 'Target must be 2–98' }); return; }

  if (ws.mode === 'play') await debitWallet(ws.user.userId, amount, 'dice');

  const result = dice.roll({ amount, target, direction });

  if (result.win && ws.mode === 'play') {
    await creditWallet(ws.user.userId, result.payout, 'dice', `dice win ${result.rolled} (${direction} ${target})`);
  }

  send(ws, { type: 'roll_result', ...result });
}

// ─────────────────────────────────────────────────────────────────────
// MINES HANDLER
// ─────────────────────────────────────────────────────────────────────
async function handleMines(ws, msg) {
  const { type } = msg;

  if (type === 'start') {
    if (ws.mode === 'play' && !ws.user) {
      send(ws, { type: 'error', code: 'AUTH_REQUIRED', msg: 'Login to play for real' }); return;
    }
    const amount    = parseFloat(msg.amount);
    const mineCount = parseInt(msg.mines) || 3;
    if (!amount || amount < 20) { send(ws, { type: 'error', msg: 'Minimum bet KSh 20' }); return; }
    if (mineCount < 1 || mineCount > 24) { send(ws, { type: 'error', msg: 'Mines must be 1–24' }); return; }

    if (ws.mode === 'play') await debitWallet(ws.user.userId, amount, 'mines');
    ws.minesGame = mines.createGame({ amount, mineCount });
    send(ws, { type: 'mines_started', tiles: 25, mines: mineCount, currentMultiplier: ws.minesGame.currentMultiplier });
    return;
  }

  if (type === 'reveal') {
    if (!ws.minesGame) { send(ws, { type: 'error', msg: 'No active mines game' }); return; }
    const result = mines.reveal(ws.minesGame, parseInt(msg.tile));
    if (result.hit) {
      ws.minesGame = null;
      send(ws, { type: 'mines_bust', tile: msg.tile, board: result.board });
    } else {
      send(ws, { type: 'mines_safe', tile: msg.tile, safeCount: result.safeCount, currentMultiplier: result.currentMultiplier, nextMultiplier: result.nextMultiplier });
    }
    return;
  }

  if (type === 'cashout') {
    if (!ws.minesGame) { send(ws, { type: 'error', msg: 'No active mines game' }); return; }
    const { payout, board } = mines.cashout(ws.minesGame);
    if (ws.mode === 'play') {
      await creditWallet(ws.user.userId, payout, 'mines', `mines cashout x${ws.minesGame.currentMultiplier.toFixed(2)}`);
    }
    ws.minesGame = null;
    send(ws, { type: 'mines_cashout', payout, board });
  }
}

// ─────────────────────────────────────────────────────────────────────
// FORTUNE SPIN HANDLER
// ─────────────────────────────────────────────────────────────────────
async function handleFortune(ws, msg) {
  if (msg.type !== 'spin') return;
  if (ws.mode === 'play' && !ws.user) {
    send(ws, { type: 'error', code: 'AUTH_REQUIRED', msg: 'Login to spin for real' }); return;
  }

  const amount = parseFloat(msg.amount);
  if (!amount || amount < 20) { send(ws, { type: 'error', msg: 'Minimum bet KSh 20' }); return; }

  if (ws.mode === 'play') await debitWallet(ws.user.userId, amount, 'fortune');
  const result = fortune.spin({ amount });
  if (result.win && ws.mode === 'play') {
    await creditWallet(ws.user.userId, result.payout, 'fortune', `fortune spin ${result.segment}`);
  }
  send(ws, { type: 'spin_result', ...result });
}

// ─────────────────────────────────────────────────────────────────────
// AVIATOR GAME LOOP
// ─────────────────────────────────────────────────────────────────────
// Timing:
//   [waiting 8s] → [flying until crash] → [crashed 3.2s cooldown] → repeat
//
// Admin gets state at EVERY phase:
//   waiting → includes crashAt (the prediction — 8s early warning)
//   flying  → includes crashAt (admin can watch countdown)
//   crashed → includes crashAt (confirmed result)

function runAviatorLoop() {
  // ── Phase 1: WAITING ──────────────────────────────────────────────
  aviator.startWaiting(state.aviator);

  // Broadcast waiting state to players (no crashAt)
  broadcast('aviator', {
    type      : 'round_waiting',
    waitMs    : state.aviator.waitDuration,
    roundNum  : state.aviator.roundNum,
  });

  // Broadcast admin state (includes crashAt — the prediction!)
  broadcastAdmin(aviator.getAdminState(state.aviator));

  // Push admin state every 200ms during waiting so countdown stays live
  const waitInterval = setInterval(() => {
    broadcastAdmin(aviator.getAdminState(state.aviator));
  }, 200);

  setTimeout(() => {
    clearInterval(waitInterval);

    // ── Phase 2: FLYING ──────────────────────────────────────────────
    aviator.startRound(state.aviator);
    broadcast('aviator', {
      type     : 'round_start',
      roundNum : state.aviator.roundNum,
      multiplier : 1.00,
    });

    const flyInterval = setInterval(() => {
      aviator.tick(state.aviator);
      const { multiplier, phase } = state.aviator;

      // Process auto-cashouts
      const autoCashouts = aviator.checkAutoCashouts(state.aviator);
      for (const { ws: betWs, betId, payout } of autoCashouts) {
        if (betWs.mode === 'play' && betWs.user) {
          creditWallet(betWs.user.userId, payout, 'aviator', `auto-cashout @${multiplier.toFixed(2)}x`)
            .catch(err => console.error('[aviator] auto-cashout credit failed:', err.message));
        }
        send(betWs, { type: 'cashout_success', payout, mult: multiplier, auto: true });
      }

      // Broadcast tick to players
      broadcast('aviator', { type: 'tick', mult: parseFloat(multiplier.toFixed(2)) });

      // Broadcast tick to admin (includes crashAt so admin sees live countdown)
      broadcastAdmin(aviator.getAdminState(state.aviator));

      if (phase === 'crashed') {
        clearInterval(flyInterval);

        // Notify all players of crash
        broadcast('aviator', {
          type       : 'round_crash',
          crashPoint : parseFloat(multiplier.toFixed(2)),
          roundNum   : state.aviator.roundNum,
        });

        // Notify admin of crash (they can now confirm their prediction)
        broadcastAdmin(aviator.getAdminState(state.aviator));

        // Notify each bettor of their loss
        aviator.settleLosses(state.aviator);
        for (const [, bet] of state.aviator.bets) {
          if (bet.lost) send(bet.ws, { type: 'bet_lost', amount: bet.amount });
        }

        // 3.2s cooldown then next round
        setTimeout(runAviatorLoop, 3200);
      }
    }, 50); // tick every 50ms — smooth multiplier updates

  }, state.aviator.waitDuration);
}

// ─────────────────────────────────────────────────────────────────────
// ROCKET CRASH LOOP
// ─────────────────────────────────────────────────────────────────────
function runRocketLoop() {
  rocket.startWaiting(state.rocket);
  broadcast('rocket', { type: 'round_waiting', waitMs: state.rocket.waitDuration, roundNum: state.rocket.roundNum });

  setTimeout(() => {
    rocket.startRound(state.rocket);
    broadcast('rocket', { type: 'round_start', roundNum: state.rocket.roundNum });

    const flyInterval = setInterval(() => {
      rocket.tick(state.rocket);
      const { multiplier, phase } = state.rocket;

      const autoCashouts = rocket.checkAutoCashouts(state.rocket);
      for (const { ws: betWs, payout } of autoCashouts) {
        if (betWs.mode === 'play' && betWs.user) {
          creditWallet(betWs.user.userId, payout, 'rocket', `auto-cashout @${multiplier.toFixed(2)}x`)
            .catch(err => console.error('[rocket] auto-cashout credit failed:', err.message));
        }
        send(betWs, { type: 'cashout_success', payout, mult: multiplier, auto: true });
      }

      broadcast('rocket', { type: 'tick', mult: parseFloat(multiplier.toFixed(2)) });

      if (phase === 'crashed') {
        clearInterval(flyInterval);
        broadcast('rocket', { type: 'round_crash', crashPoint: parseFloat(multiplier.toFixed(2)), roundNum: state.rocket.roundNum });
        rocket.settleLosses(state.rocket);
        for (const [, bet] of state.rocket.bets) {
          if (bet.lost) send(bet.ws, { type: 'bet_lost', amount: bet.amount });
        }
        setTimeout(runRocketLoop, 3200);
      }
    }, 50);
  }, state.rocket.waitDuration);
}

// ─────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`🎮 PepetaHigh game-server on port ${PORT}`);
  console.log(`   Backend: ${BACKEND_URL}`);
  runAviatorLoop();
  runRocketLoop();
});
