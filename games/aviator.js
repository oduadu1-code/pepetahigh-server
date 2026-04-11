'use strict';
/**
 * games/aviator.js  v2
 * ─────────────────────────────────────────────────────────────────────
 * Pure game logic — no WebSocket, no DB, no side effects.
 * server.js calls these functions and handles all I/O.
 *
 * KEY FIXES vs v1:
 *  1. Multiplier curve matches engine.js EXACTLY:
 *       Math.pow(Math.E, elapsed_ms / 5800)
 *     The old formula used seconds*0.06 which is a different curve —
 *     would cause frontend animation to crash at the wrong visual point.
 *
 *  2. Crash generator matches engine.js genCrashReal() distribution:
 *     - Real time-of-day house edge (52–58%)
 *     - Daily jackpot (0.008% → 5000×, once per calendar day)
 *     - Big-win quota (up to 5 per session)
 *     Same distribution = admin predictor feels accurate.
 *
 *  3. crashPoint generated at START OF WAITING phase (not at takeoff)
 *     so admin sees the prediction 8 seconds before the round starts —
 *     exactly as the old engine.js did in doWait().
 *
 *  4. getAdminState() exposes crashAt + waitTimer for the admin panel.
 *     getState() NEVER reveals crashPoint to regular players.
 */

const crypto = require('crypto');

// ── House edge by hour (mirrors engine.js realWinRate) ────────────────
function realWinRate() {
  const h = new Date().getHours();
  if (h >= 21 || h <= 2)  return 0.52;
  if (h >= 6  && h <= 9)  return 0.58;
  if (h >= 14 && h <= 17) return 0.56;
  return 0.54;
}

// ── Jackpot / big-win tracking per server session ────────────────────
let _jpFiredToday = false;
let _jpDate       = '';
let _bigWinCount  = 0;

function _checkJpDate() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== _jpDate) { _jpDate = today; _jpFiredToday = false; }
}

// ── Crash generator (matches engine.js genCrashReal) ─────────────────
function generateCrashPoint() {
  _checkJpDate();

  // Daily jackpot — 0.008% chance, only fires once per calendar day
  if (!_jpFiredToday && Math.random() < 0.00008) {
    _jpFiredToday = true;
    return 5000;
  }

  // Big-win quota: up to 5 large wins per server session
  if (_bigWinCount < 5 && Math.random() < 0.028) {
    _bigWinCount++;
    return parseFloat((2000 + Math.random() * 2999).toFixed(2));
  }

  const w  = realWinRate();
  const r  = Math.random();

  // Loss zone (more frequent, weighted by house edge)
  if (r < (1 - w) * 1.25) {
    const s = Math.random();
    if (s < 0.05)  return 1.00;
    if (s < 0.55)  return parseFloat((1.01 + Math.random() * 0.48).toFixed(2));
    return parseFloat((1.50 + Math.random() * 0.49).toFixed(2));
  }

  // Win zone
  const r2 = Math.random();
  if (r2 < 0.30)  return parseFloat((2.00  + Math.random() * 2.99).toFixed(2));
  if (r2 < 0.58)  return parseFloat((5.00  + Math.random() * 4.99).toFixed(2));
  if (r2 < 0.78)  return parseFloat((10.00 + Math.random() * 9.99).toFixed(2));
  if (r2 < 0.91)  return parseFloat((20.00 + Math.random() * 29.99).toFixed(2));
  if (r2 < 0.97)  return parseFloat((50.00 + Math.random() * 49.99).toFixed(2));
  if (r2 < 0.995) return parseFloat((100.0 + Math.random() * 99.99).toFixed(2));
  return parseFloat((200.0 + Math.random() * 799).toFixed(2));
}

// ── State factory ─────────────────────────────────────────────────────
function createState() {
  return {
    phase        : 'waiting',
    multiplier   : 1.00,
    crashPoint   : null,    // SECRET — never sent to players
    bets         : new Map(),
    _nextId      : 1,
    startedAt    : null,    // ms timestamp when flying started
    waitStarted  : null,    // ms timestamp when waiting started
    waitDuration : 8000,    // ms of bet-acceptance window
    roundNum     : 0,
    history      : [],      // last 30 crash points (public)
  };
}

// ── Start waiting phase ───────────────────────────────────────────────
// crashPoint generated HERE so admin sees it 8s before takeoff.
// Matches engine.js: crash point is decided in doWait(), not doFly().
function startWaiting(s) {
  s.phase       = 'waiting';
  s.multiplier  = 1.00;
  s.crashPoint  = generateCrashPoint();
  s.startedAt   = null;
  s.waitStarted = Date.now();
  s.roundNum++;
  s.bets.clear();
}

// ── Start flying phase ────────────────────────────────────────────────
function startRound(s) {
  s.phase      = 'flying';
  s.multiplier = 1.00;
  s.startedAt  = Date.now();
}

// ── Tick (called every 50ms) ──────────────────────────────────────────
// Curve: Math.pow(e, elapsed_ms / 5800) — EXACT match to engine.js
// engine.js line: G.mult = Math.round(Math.pow(Math.E, G.elapsed / 5800) * 100) / 100
function tick(s) {
  if (s.phase !== 'flying') return;

  const elapsedMs  = Date.now() - s.startedAt;
  s.multiplier     = Math.round(Math.pow(Math.E, elapsedMs / 5800) * 100) / 100;
  s.multiplier     = Math.max(1.00, s.multiplier);

  if (s.multiplier >= s.crashPoint) {
    s.multiplier = parseFloat(s.crashPoint.toFixed(2));
    s.phase      = 'crashed';
    s.history.unshift(s.crashPoint);
    if (s.history.length > 30) s.history.pop();
  }
}

// ── Waiting time remaining ────────────────────────────────────────────
function waitRemaining(s) {
  if (s.phase !== 'waiting' || !s.waitStarted) return 0;
  return Math.max(0, s.waitDuration - (Date.now() - s.waitStarted));
}

// ── Place a bet ───────────────────────────────────────────────────────
function placeBet(s, ws, amount, autoCashout) {
  const betId = String(s._nextId++);
  s.bets.set(betId, {
    ws,
    amount,
    autoCashout : autoCashout && autoCashout > 1 ? parseFloat(autoCashout) : null,
    cashedOut   : false,
    lost        : false,
  });
  return betId;
}

// ── Manual cashout ────────────────────────────────────────────────────
function cashout(s, betId, multiplier) {
  const bet = s.bets.get(betId);
  if (!bet || bet.cashedOut || bet.lost) return null;
  bet.cashedOut = true;
  const payout = Math.floor(bet.amount * multiplier * 100) / 100;
  return { payout, betId };
}

// ── Auto-cashouts ─────────────────────────────────────────────────────
function checkAutoCashouts(s) {
  const triggered = [];
  for (const [betId, bet] of s.bets) {
    if (bet.cashedOut || bet.lost) continue;
    if (bet.autoCashout && s.multiplier >= bet.autoCashout) {
      bet.cashedOut = true;
      const payout = Math.floor(bet.amount * bet.autoCashout * 100) / 100;
      triggered.push({ ws: bet.ws, betId, payout });
    }
  }
  return triggered;
}

// ── Settle losses ─────────────────────────────────────────────────────
function settleLosses(s) {
  for (const [, bet] of s.bets) {
    if (!bet.cashedOut) bet.lost = true;
  }
  // Don't clear map — server.js reads it to send loss notifications
}

// ── PUBLIC state (sent to all connected players) ──────────────────────
// crashPoint NEVER included — would let cheaters know when to cash out.
function getState(s) {
  return {
    phase         : s.phase,
    multiplier    : parseFloat(s.multiplier.toFixed(2)),
    history       : s.history,
    betCount      : s.bets.size,
    roundNum      : s.roundNum,
    waitRemaining : waitRemaining(s),
  };
}

// ── ADMIN state (sent only to verified admin WebSocket connections) ───
// Includes crashAt so admin panel shows the prediction during waiting.
// Field names match bridge-aviator.js so admin-aviator.html works unchanged.
function getAdminState(s) {
  const wr = waitRemaining(s);
  return {
    game      : 'aviator',
    ts        : Date.now(),
    mode      : 'real',
    state     : s.phase,                              // matches bridge payload field
    mult      : parseFloat(s.multiplier.toFixed(2)),  // matches bridge payload field
    crashAt   : s.crashPoint,                         // THE prediction — admin only
    waitTimer : wr,                                   // matches bridge-aviator.js
    fillPct   : s.phase === 'waiting' && s.waitStarted
      ? Math.min(1, (Date.now() - s.waitStarted) / s.waitDuration)
      : 0,
    roundNum  : s.roundNum,
    roundHist : s.history,                            // matches bridge payload field
  };
}

module.exports = {
  createState,
  startWaiting,
  startRound,
  tick,
  waitRemaining,
  placeBet,
  cashout,
  checkAutoCashouts,
  settleLosses,
  getState,
  getAdminState,
};
