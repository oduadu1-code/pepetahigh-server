'use strict';
const crypto = require('crypto');

function generateCrashPoint() {
  const r = Math.random();
  if (r < 0.18) return 1.00;
  if (r < 0.52) return parseFloat((1.01 + Math.random() * 0.97).toFixed(2));
  if (r < 0.72) return parseFloat((1.99 + Math.random() * 2.00).toFixed(2));
  if (r < 0.85) return parseFloat((4.00 + Math.random() * 5.99).toFixed(2));
  if (r < 0.93) return parseFloat((10.0 + Math.random() * 14.99).toFixed(2));
  if (r < 0.97) return parseFloat((25.0 + Math.random() * 24.99).toFixed(2));
  if (r < 0.99) return parseFloat((50.0 + Math.random() * 149).toFixed(2));
  return parseFloat((200.0 + Math.random() * 300).toFixed(2));
}

function createState() {
  return {
    phase: 'waiting', multiplier: 1.00, crashPoint: null,
    bets: new Map(), _nextId: 1, startedAt: null,
    waitStarted: null, waitDuration: 8000, roundNum: 0, history: [],
  };
}
function startWaiting(s) {
  s.phase = 'waiting'; s.multiplier = 1.00;
  s.crashPoint = generateCrashPoint();
  s.startedAt = null; s.waitStarted = Date.now();
  s.roundNum++; s.bets.clear();
}
function startRound(s) { s.phase = 'flying'; s.multiplier = 1.00; s.startedAt = Date.now(); }
function tick(s) {
  if (s.phase !== 'flying') return;
  const elapsed = Date.now() - s.startedAt;
  s.multiplier = Math.max(1.00, parseFloat(Math.pow(1.06, elapsed / 1000 * 5.5).toFixed(2)));
  if (s.multiplier >= s.crashPoint) {
    s.multiplier = parseFloat(s.crashPoint.toFixed(2));
    s.phase = 'crashed';
    s.history.unshift(s.crashPoint);
    if (s.history.length > 30) s.history.pop();
  }
}
function placeBet(s, ws, amount, auto) {
  const id = String(s._nextId++);
  s.bets.set(id, { ws, amount, autoCashout: auto && auto > 1 ? parseFloat(auto) : null, cashedOut: false, lost: false });
  return id;
}
function cashout(s, id, mult) {
  const bet = s.bets.get(id);
  if (!bet || bet.cashedOut || bet.lost) return null;
  bet.cashedOut = true;
  return { payout: Math.floor(bet.amount * mult * 100) / 100, betId: id };
}
function checkAutoCashouts(s) {
  const triggered = [];
  for (const [id, bet] of s.bets) {
    if (bet.cashedOut || bet.lost) continue;
    if (bet.autoCashout && s.multiplier >= bet.autoCashout) {
      bet.cashedOut = true;
      triggered.push({ ws: bet.ws, betId: id, payout: Math.floor(bet.amount * bet.autoCashout * 100) / 100 });
    }
  }
  return triggered;
}
function settleLosses(s) { for (const [, b] of s.bets) if (!b.cashedOut) b.lost = true; }
function getState(s) {
  return { phase: s.phase, multiplier: parseFloat(s.multiplier.toFixed(2)), history: s.history, roundNum: s.roundNum, waitRemaining: s.waitStarted ? Math.max(0, s.waitDuration - (Date.now() - s.waitStarted)) : 0 };
}

module.exports = { createState, startWaiting, startRound, tick, placeBet, cashout, checkAutoCashouts, settleLosses, getState };