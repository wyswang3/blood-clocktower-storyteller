'use strict';

/** 可复现随机数（模拟对局用同一颗种子可以重放）。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pick(arr, rng = Math.random) {
  if (!arr.length) return undefined;
  return arr[Math.floor(rng() * arr.length)];
}

function pickMany(arr, k, rng = Math.random) {
  return shuffle(arr, rng).slice(0, k);
}

function clampInt(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n | 0));
}

module.exports = { mulberry32, shuffle, pick, pickMany, clampInt };
