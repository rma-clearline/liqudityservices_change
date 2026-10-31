// Premium-rate resolution for the Invaluable collector (scripts/invaluable/lib.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { rateCandidates, dominantRate, lotRate, hammerOf, onlineWon, deriveLot } from "../scripts/invaluable/lib.mjs";

const lot = (priceResult, buyersPremium, price, bidCount = 1, isSold = true) => ({ isSold, priceResult, buyersPremium, price, bidCount });

test("rateCandidates lists the schedule rate first, then each distinct naive lot rate", () => {
  const cat = { premiumRate: 0.28 };
  const lots = [lot(3840, 883.2, 3000), lot(1280, 294.4, 1000), lot(500, 0, 400), lot(0, 0, 0, 0, false)];
  assert.deepEqual(rateCandidates(lots, cat), [0.28, 0.23]);
});

test("rateCandidates without a schedule still offers the lot rates", () => {
  assert.deepEqual(rateCandidates([lot(1250, 250, 1000)], { premiumRate: null }), [0.2]);
});

test("dominantRate is the candidate under which most sold results are whole-dollar hammers", () => {
  const results = [3840, 832, 2432, 3712, 1216];
  assert.equal(dominantRate(results, [0.28, 0.23]), 0.28);
  assert.equal(dominantRate(results, [0.23, 0.28]), 0.28);
});

test("dominantRate falls back to the first candidate when nothing is round, and null without candidates", () => {
  assert.equal(dominantRate([1003, 1007], [0.25, 0.3]), 0.25);
  assert.equal(dominantRate([1000], []), null);
});

test("lotRate picks the one candidate that gives a whole-dollar hammer", () => {
  assert.equal(lotRate(3840, [0.28, 0.23], 0.23), 0.28);
});

test("lotRate uses the dominant rate when several or no candidates are round", () => {
  assert.equal(lotRate(1280, [0.28, 0.25], 0.25), 0.25);
  assert.equal(lotRate(1001, [0.28, 0.25], 0.28), 0.28);
});

test("hammerOf strips the premium only when results include it", () => {
  assert.equal(hammerOf(3840, 0.28, true), 3000);
  assert.equal(hammerOf(3840, 0.28, false), 3840);
  assert.equal(hammerOf(3840, null, true), 3840);
});

test("onlineWon: live sales need an online bid equal to the hammer and at least one bid; timed sales are online", () => {
  assert.equal(onlineWon({ sold: true, hammer: 3000, onlineHammer: 3000, bids: 26, isTimed: false }), true);
  assert.equal(onlineWon({ sold: true, hammer: 3000, onlineHammer: 3000, bids: 0, isTimed: false }), false);
  assert.equal(onlineWon({ sold: true, hammer: 3000, onlineHammer: 2800, bids: 5, isTimed: false }), false);
  assert.equal(onlineWon({ sold: true, hammer: 3000, onlineHammer: 2990, bids: 5, isTimed: true }), true);
  assert.equal(onlineWon({ sold: false, hammer: null, onlineHammer: 100, bids: 3, isTimed: true }), false);
});

test("deriveLot with resolved catalog rates recovers the online win the naive rate hides", () => {
  const cat = { premiumRate: 0.28, resultsIncludePremium: true, isTimed: false };
  const lots = [lot(3840, 883.2, 3000, 26), lot(832, 191.36, 650, 13), lot(2432, 559.36, 1100, 16)];
  const rates = { candidates: rateCandidates(lots, cat), dominant: dominantRate(lots.map((l) => l.priceResult), rateCandidates(lots, cat)) };
  const a = deriveLot(lots[0], cat, rates);
  assert.equal(a.rate, 0.28);
  assert.equal(a.hammer, 3000);
  assert.equal(a.onlineWon, true);
  const c = deriveLot(lots[2], cat, rates);
  assert.equal(c.hammer, 1900);
  assert.equal(c.onlineWon, false);
});

test("deriveLot without resolved rates keeps the naive per-lot rate (legacy behaviour)", () => {
  const cat = { premiumRate: 0.28, resultsIncludePremium: true, isTimed: false };
  const d = deriveLot(lot(3840, 883.2, 3000, 26), cat);
  assert.equal(d.rate, 0.23);
  assert.equal(d.onlineWon, false);
});
