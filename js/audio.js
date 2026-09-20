/* 音频：Web Audio 合成节拍器与打击音，无外部资源 */
(function (MG) {
  'use strict';

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.buffers = {};
      this.enabled = true;
      this.volume = 0.8;
      this.bgmVolume = 1.0;
    }
    ensure() {
      if (this.ctx) return this.ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC({ latencyHint: 'interactive' });
      // 末端两级保护：压缩器收住持续电平，软削波兜住瞬态，避免多押 + 鼓组叠满时失真
      this.softClip = this.ctx.createWaveShaper();
      this.softClip.curve = this._clipCurve();
      this.softClip.oversample = '2x';
      this.softClip.connect(this.ctx.destination);
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -10;
      this.limiter.knee.value = 4;
      this.limiter.ratio.value = 16;
      this.limiter.attack.value = 0.001;
      this.limiter.release.value = 0.09;
      this.limiter.connect(this.softClip);
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.limiter);
      // BGM 单独一条总线，压在打击音下面
      this.bgmBus = this.ctx.createGain();
      this.bgmBus.gain.value = this.bgmVolume;
      this.bgmBus.connect(this.master);
      this._build();
      return this.ctx;
    }
    async unlock() {
      const ctx = this.ensure();
      if (!ctx) return;
      if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) { /* ignore */ } }
      // iOS：播放一个静音 buffer 以解锁
      const b = ctx.createBuffer(1, 1, ctx.sampleRate);
      const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0);
    }
    setVolume(v) {
      this.volume = v;
      if (this.master) this.master.gain.value = v;
    }
    setBgmVolume(v) {
      this.bgmVolume = v;
      if (this.bgmBus) this.bgmBus.gain.value = v;
    }
    /* 软削波曲线：tanh 型，输出恒在 ±1 以内 */
    _clipCurve() {
      const n = 2048, c = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        c[i] = 0.985 * Math.tanh(x * 1.6) / Math.tanh(1.6);
      }
      return c;
    }
    _make(len, fn) {
      const ctx = this.ctx, sr = ctx.sampleRate;
      const n = Math.floor(sr * len);
      const buf = ctx.createBuffer(1, n, sr);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = fn(i / sr, i / n);
      return buf;
    }
    _build() {
      const env = (p, k) => Math.exp(-p * k);
      let seed = 1;
      const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 * 2 - 1; };
      // 节拍器：重拍 / 轻拍
      this.buffers.tickHi = this._make(0.06, (t, p) => Math.sin(2 * Math.PI * 1760 * t) * env(p, 9) * 0.9);
      this.buffers.tickLo = this._make(0.05, (t, p) => Math.sin(2 * Math.PI * 1175 * t) * env(p, 9) * 0.6);
      // 打击音：短噪声 + 中频
      this.buffers.hit = this._make(0.05, (t, p) => (rnd() * 0.5 + Math.sin(2 * Math.PI * 900 * t) * 0.6) * env(p, 12) * 0.7);
      this.buffers.miss = this._make(0.12, (t, p) => Math.sin(2 * Math.PI * 180 * t) * env(p, 5) * 0.4);

      /* ---- BGM 音色：全部现场合成，无外部素材 ---- */
      // 底鼓：120Hz 扫到 45Hz
      this.buffers.kick = this._make(0.30, (t, p) => {
        const f = 45 + 80 * Math.exp(-t * 32);
        return Math.sin(2 * Math.PI * f * t) * env(p, 5.5) * 0.95;
      });
      // 军鼓：噪声 + 190Hz 基音
      this.buffers.snare = this._make(0.20, (t, p) =>
        (rnd() * 0.75 + Math.sin(2 * Math.PI * 190 * t) * 0.45) * env(p, 9) * 0.55);
      // 拍手：三次噪声爆发
      this.buffers.clap = this._make(0.20, (t, p) => {
        const burst = t < 0.012 ? 1 : t < 0.026 ? 0.8 : t < 0.042 ? 0.65 : Math.exp(-(t - 0.042) * 34);
        return rnd() * burst * env(p, 3.2) * 0.6;
      });
      // 闭镲：噪声做一阶差分当高通
      let prev = 0;
      this.buffers.hat = this._make(0.055, (t, p) => {
        const n = rnd(), d = n - prev; prev = n;
        return d * env(p, 16) * 0.42;
      });
      prev = 0;
      this.buffers.ohat = this._make(0.20, (t, p) => {
        const n = rnd(), d = n - prev; prev = n;
        return d * env(p, 4.5) * 0.34;
      });
      // 贝斯：110Hz 正弦叠一点二次谐波，playbackRate 变调
      this.buffers.bass = this._make(0.26, (t, p) =>
        (Math.sin(2 * Math.PI * 110 * t) + Math.sin(2 * Math.PI * 220 * t) * 0.22) * env(p, 4) * 0.5);
      // 琶音：440Hz 方波
      this.buffers.arp = this._make(0.16, (t, p) =>
        (Math.sin(2 * Math.PI * 440 * t) >= 0 ? 1 : -1) * env(p, 7) * 0.2);
      // 和弦铺底：440Hz 微失谐双音，慢起音长衰减，用来托住和弦进行
      this.buffers.pad = this._make(0.95, (t, p) => {
        const a = 1 - Math.exp(-t * 26);
        const v = Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 441.6 * t)
          + Math.sin(2 * Math.PI * 880 * t) * 0.18;
        return v * a * env(p, 2.4) * 0.16;
      });
    }

    /* BGM 专用播放：semi 为半音偏移（贝斯以 110Hz、琶音以 440Hz 为基准） */
    playBgm(name, when, semi, gain) {
      if (!this.enabled || !this.ctx || !this.buffers[name]) return null;
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = this.buffers[name];
      if (semi) src.playbackRate.value = Math.pow(2, semi / 12);
      let node = src;
      if (gain !== undefined && gain !== 1) {
        const g = ctx.createGain();
        g.gain.value = gain;
        src.connect(g);
        node = g;
      }
      node.connect(this.bgmBus);
      src.start(Math.max(when || 0, ctx.currentTime));
      return src;
    }
    /* 载入并解码外部音频（BGM 录音），带缓存 */
    loadFile(url) {
      this.files = this.files || {};
      if (this.files[url]) return this.files[url];
      const ctx = this.ensure();
      if (!ctx) return Promise.reject(new Error('no audio context'));
      this.files[url] = fetch(url)
        .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
        .then((buf) => new Promise((res, rej) => {
          const ok = (b) => res(b), bad = (e) => rej(e || new Error('decode failed'));
          const p2 = ctx.decodeAudioData(buf, ok, bad);
          if (p2 && p2.then) p2.then(ok, bad);
        }))
        .then((b) => { this.decoded = this.decoded || {}; this.decoded[url] = b; return b; })
        .catch((e) => { delete this.files[url]; throw e; });
      return this.files[url];
    }
    fileBuffer(url) { return (this.decoded && this.decoded[url]) || null; }
    /* 播放录音的一段：when 起播、offset 缓冲内偏移、dur 实际时长、rate 速率
       首尾各做 8ms 淡入淡出，与相邻段重叠成无缝拼接 */
    playSlice(buf, when, offset, dur, rate, gain) {
      if (!this.enabled || !this.ctx || !buf) return null;
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      const g = ctx.createGain();
      const t0 = Math.max(when, ctx.currentTime);
      const fade = Math.min(0.008, dur / 4);
      const vol = gain === undefined ? 1 : gain;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vol, t0 + fade);
      g.gain.setValueAtTime(vol, t0 + dur);
      g.gain.linearRampToValueAtTime(0, t0 + dur + fade);
      src.connect(g);
      g.connect(this.bgmBus);
      src.start(t0, Math.max(0, offset));
      src.stop(t0 + dur + fade + 0.01);
      return src;
    }
    play(name, when, gain = 1) {
      if (!this.enabled || !this.ctx) return;
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = this.buffers[name];
      if (gain !== 1) {
        const g = ctx.createGain(); g.gain.value = gain; src.connect(g); g.connect(this.master);
      } else src.connect(this.master);
      src.start(Math.max(when || 0, ctx.currentTime));
    }
    now() { return this.ctx ? this.ctx.currentTime : 0; }
    outputLatency() {
      if (!this.ctx) return 0;
      return (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    }
  }

  MG.AudioEngine = AudioEngine;
})(window.MG = window.MG || {});
