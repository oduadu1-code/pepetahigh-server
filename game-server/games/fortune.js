'use strict';
function createState() { return { phase: 'waiting', multiplier: 1, bets: new Map(), waitDuration: 8000, waitStarted: null, startedAt: null, roundNum: 0, history: [] }; }
function startWaiting(s) { s.phase = 'waiting'; s.waitStarted = Date.now(); s.roundNum++; s.bets.clear(); }
function startRound(s) { s.phase = 'flying'; s.startedAt = Date.now(); }
function tick(s) {}
function placeBet(s, ws, amount, auto) { const id = String(Date.now()); s.bets.set(id, { ws, amount, cashedOut: false, lost: false }); return id; }
function cashout(s, id, mult) { const b = s.bets.get(id); if (!b) return null; b.cashedOut = true; return { payout: b.amount * mult, betId: id }; }
function checkAutoCashouts(s) { return []; }
function settleLosses(s) { for (const [,b] of s.bets) if (!b.cashedOut) b.lost = true; }
function getState(s) { return { phase: s.phase, multiplier: s.multiplier || 1 }; }
module.exports = { createState, startWaiting, startRound, tick, placeBet, cashout, checkAutoCashouts, settleLosses, getState };
