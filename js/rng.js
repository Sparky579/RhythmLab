/* 可复现随机数：FNV-1a 哈希 + mulberry32 */
(function (root) {
  'use strict';

  function hashString(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class RNG {
    constructor(seed) {
      this.seed = seed >>> 0;
      this.next = mulberry32(this.seed);
    }
    float(a = 0, b = 1) { return a + (b - a) * this.next(); }
    int(a, b) { return a + Math.floor(this.next() * (b - a + 1)); }
    pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
    chance(p) { return this.next() < p; }
    sign() { return this.next() < 0.5 ? -1 : 1; }
    /* items: 数组, weights: 同长度权重数组 */
    weighted(items, weights) {
      let total = 0;
      for (let i = 0; i < weights.length; i++) total += weights[i];
      if (total <= 0) return items[0];
      let r = this.next() * total;
      for (let i = 0; i < items.length; i++) {
        r -= weights[i];
        if (r <= 0) return items[i];
      }
      return items[items.length - 1];
    }
  }

  root.RNG = RNG;
  root.hashString = hashString;
})(typeof module !== 'undefined' ? module.exports : (window.MG = window.MG || {}));
