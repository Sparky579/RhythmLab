/* 游戏引擎：Canvas 渲染 + 精确判定（4K / 7K 轨道）
 * 时钟以 performance.now() 为基准，输入使用事件自带的 timeStamp（而非帧时间）参与判定
 * 判定窗口：|Δt| ≤ 40ms Perfect(100%)，≤ 80ms Great(50%)，其余 Miss(0%)
 */
(function (MG) {
  'use strict';

  const PERFECT_MS = 40, GREAT_MS = 80;   // 默认判定窗口，玩家可调
  const BASE_APPROACH_MS = 500;           // 1.0 倍速对应的下落时间
  const JUDGE_NAMES = ['PERFECT', 'GREAT', 'MISS'];
  const JUDGE_COLORS = ['#ffd75e', '#5ee8b0', '#ff5c7a'];
  const JUDGE_WEIGHT = [1, 0.5, 0];
  const HAND_COLORS = ['#4fc8ff', '#ff6fae'];
  const THUMB_COLOR = '#b58cff';
  const NEUTRAL_COLOR = '#c9d4ff';

  const KEYMAP = {
    4: { codes: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'], labels: ['D', 'F', 'J', 'K'] },
    7: {
      codes: ['KeyS', 'KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK', 'KeyL'],
      labels: ['S', 'D', 'F', '␣', 'J', 'K', 'L'],
    },
  };

  const DEFAULT_SETTINGS = {
    speed: 1.0,          // 下落速度倍数，1.0 = 500ms 落到判定线
    perfectMs: PERFECT_MS,
    greatMs: GREAT_MS,
    judgeY: 0.8,         // 判定线高度（屏高比例）
    offsetMs: 0,         // 判定偏移：正值 = 认为玩家按早了（把输入时间往后挪）
    autoplay: false,
    missOnEmpty: false,  // 空打判 Miss（断连，不计入总分）
    handColors: true,
    hitSound: true,
    bgm: 'metro',        // 'metro' 节拍器 | 'none' 无声 | 录音/合成 id
    bgmVolume: 1.0,      // BGM 相对音量
    metroOverlay: false, // 放 BGM 时是否再叠一层节拍器
    volume: 0.8,
    showErrorBar: true,
    laneSlackPx: 12,     // 轨道判定余量：落点越过轨道边线这么多像素内仍算这一轨
    inputDebug: false,   // 画面左上角实时显示输入统计，用来排查断触
    autoCalibrate: false,// 默认不动偏移；要用的话在设置里打开，或在结果页手动点一次
    edgeMargin: 28,      // 轨道区左右留白（px）：安卓手势导航会吃掉屏幕边缘的触摸
    autoFullscreen: true,// 开始时自动进入全屏，减少浏览器/系统手势干扰
  };


  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  class Game {
    constructor(canvas, audio) {
      this.canvas = canvas;
      this.ctx2d = canvas.getContext('2d', { alpha: false, desynchronized: true });
      this.audio = audio;
      this.settings = Object.assign({}, DEFAULT_SETTINGS);
      this.state = 'idle'; // idle | countin | playing | paused | resuming | finished
      this.chart = null;
      this.keys = 4;
      this.onFinish = null;
      this.onPauseChange = null;
      this.W = 0; this.H = 0; this.dpr = 1;
      this.rect = null;
      this.effects = new Array(64).fill(null).map(() => ({ t0: -1, kind: 0, lane: 0 }));
      this.effectPtr = 0;
      this.errors = new Array(48).fill(null).map(() => ({ off: 0, t0: -1, kind: 0 }));
      this.errorPtr = 0;
      this.lanePress = new Float64Array(7);
      this.touches = new Map();   // identifier -> {lane, x}
      this.lastTouchAt = 0;
      this.clockDelta = null;     // event.timeStamp -> performance.now() 的偏移
      this.nativeMode = false;    // 原生壳直采触摸时为 true
      this.lastNativeAt = 0;
      this.nativeSeen = 0;
      this.rectAt = 0;
      this.taps = 0; this.emptyTaps = 0; this.assistHits = 0;
      this.tsAnomalies = 0; this.stateDrops = 0; this.lastDt = null;
      this.lastJudge = { kind: -1, t0: -1, dt: 0 };
      this.raf = 0;
      this._bind();
      this.resize();
    }

    /* ---------- 尺寸 ---------- */
    resize() {
      const c = this.canvas;
      const r = c.getBoundingClientRect();
      this.rect = r;
      this.rectAt = performance.now();
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      this.dpr = dpr;
      this.W = r.width; this.H = r.height;
      const pw = Math.round(r.width * dpr), ph = Math.round(r.height * dpr);
      if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
      this.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      const K = this.keys;
      // 左右各留一条空白，避免最外侧轨道压在系统手势区里被吃掉触摸
      const margin = clamp(+this.settings.edgeMargin || 0, 0, Math.max(0, this.W * 0.2));
      const avail = Math.max(60, this.W - margin * 2);
      const laneW = Math.min(avail / K, K === 4 ? 140 : 100);
      this.laneW = laneW;
      this.laneX0 = (this.W - laneW * K) / 2;
      this.edgeMarginPx = (this.W - laneW * K) / 2;
      this.noteH = clamp(laneW * 0.26, 12, 28);
      this.judgePx = this.H * this.settings.judgeY;
    }
    laneCenter(lane) { return this.laneX0 + (lane + 0.5) * this.laneW; }

    /* ---------- 输入绑定 ---------- */
    _bind() {
      // 监听整个游戏层而不是 canvas：即使某一下点到了 canvas 以外的位置也不会丢
      const root = this.canvas.parentElement || this.canvas;
      const skip = (e) => {
        const t = e.target;
        return !!(t && t.closest && t.closest('button, .overlay'));
      };
      const each = (list, fn) => { for (let i = 0; i < list.length; i++) fn(list[i]); };

      root.addEventListener('touchstart', (e) => {
        if (skip(e)) return;
        if (e.cancelable) e.preventDefault();
        this.lastTouchAt = performance.now();
        // 原生壳在转发触摸：DOM 这一路让位。但如果原生事件迟迟不来，
        // 说明那条通道坏了，立刻退回 DOM，别让整个游戏点不动。
        if (this.nativeMode) {
          if (performance.now() - this.lastNativeAt > 300) this.nativeMode = false;
          else return;
        }
        const ts = this._evtTime(e);
        each(e.changedTouches, (t) => {
          const pos = this._lanePos(t.clientX);
          this.touches.set(t.identifier, { lane: pos.lane, x: t.clientX });
          this.inputLane(pos.lane, ts, pos.frac);
        });
      }, { passive: false });

      // 手指没完全抬起就滑到别的轨（手机上最常见的「断触」）：滑过边界也算一次击打
      root.addEventListener('touchmove', (e) => {
        if (e.cancelable) e.preventDefault();
        if (this.nativeMode) return;
        const ts = this._evtTime(e);
        each(e.changedTouches, (t) => {
          const prev = this.touches.get(t.identifier);
          if (!prev) return;
          const pos = this._lanePos(t.clientX);
          if (pos.lane !== prev.lane && Math.abs(t.clientX - prev.x) > this.laneW * 0.45) {
            prev.lane = pos.lane; prev.x = t.clientX;
            this.inputLane(pos.lane, ts, pos.frac);
          }
        });
      }, { passive: false });

      const release = (e) => {
        this.lastTouchAt = performance.now();
        if (this.nativeMode) return;
        each(e.changedTouches, (t) => this.touches.delete(t.identifier));
      };
      root.addEventListener('touchend', release, { passive: true });
      root.addEventListener('touchcancel', release, { passive: true });

      root.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || skip(e)) return;
        // 触摸会派生一次鼠标事件，若放行会把同一轨的下一个音符提前吃掉
        if (performance.now() - this.lastTouchAt < 700) return;
        e.preventDefault();
        const pos = this._lanePos(e.clientX);
        this.inputLane(pos.lane, this._evtTime(e), pos.frac);
      });
      root.addEventListener('contextmenu', (e) => e.preventDefault());
      window.addEventListener('keydown', (e) => {
        if (e.repeat) return;
        if (this.state === 'idle' || this.state === 'finished') return;
        if (e.code === 'Escape') { e.preventDefault(); this.togglePause(); return; }
        if (!this.chart) return;
        const lane = KEYMAP[this.keys].codes.indexOf(e.code);
        if (lane >= 0) { e.preventDefault(); this.inputLane(lane, this._evtTime(e)); }
      });
      window.addEventListener('keyup', (e) => {
        // 空格在 7K 里是轨道键，避免触发按钮默认行为
        if (this.state !== 'idle' && this.state !== 'finished' && e.code === 'Space') e.preventDefault();
      });
      window.addEventListener('resize', () => this.resize());
      window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 200));
      document.addEventListener('visibilitychange', () => {
        if (document.hidden && (this.state === 'playing' || this.state === 'countin')) this.pause();
      });
    }
    /* 事件时间戳换算。
       不同浏览器 / WebView 的 event.timeStamp 基准五花八门，还可能在运行中漂移。
       这里不去猜基准，而是持续记录「performance.now() - timeStamp」的最小值：
       这个最小值就是两个时钟的真实偏移（最小值对应排队耗时≈0 的那次事件）。
       用 timeStamp + 最小偏移 就能稳定换算到 performance.now() 时间轴上，
       既不受基准影响，又保留了事件之间的相对精度（主线程卡顿时尤其重要）。 */
    _evtTime(e) {
      const now = performance.now();
      const ts = e.timeStamp;
      if (typeof ts !== 'number' || !isFinite(ts) || ts <= 0) return now;
      const delta = now - ts;
      if (this.clockDelta === null) this.clockDelta = delta;
      else if (delta < this.clockDelta) this.clockDelta = delta;      // 更小的偏移立刻采纳
      else this.clockDelta += (delta - this.clockDelta) * 0.002;      // 缓慢回升，避免被一次异常值钉死
      const mapped = ts + this.clockDelta;
      if (Math.abs(mapped - now) > 1000) {
        // 时间戳基准跳变（换算结果离当下太远），重新锚定并本次退回系统时钟
        this.tsAnomalies++;
        this.clockDelta = delta;
        return now;
      }
      return mapped > now ? now : mapped;
    }

    /* canvas 位置可能因地址栏收起、旋转等变化，定期重新量一次，避免按到错误的轨 */
    _rect() {
      const now = performance.now();
      if (!this.rect || now - this.rectAt > 250) {
        this.rect = this.canvas.getBoundingClientRect();
        this.rectAt = now;
      }
      return this.rect;
    }
    _lanePos(cx) {
      const xr = (cx - this._rect().left - this.laneX0) / this.laneW;
      const lane = clamp(Math.floor(xr), 0, this.keys - 1);
      return { lane, frac: clamp(xr - lane, 0, 1) };
    }

    /* 第 i 拍的绝对时间；负数是预备拍，按起始速度算 */
    _beatTime(i) {
      const bt = this.chart.beatTimes;
      if (i < 0) return i * this.chart.beat;
      return i < bt.length ? bt[i] : Infinity;
    }
    /* 第一个晚于 t 的拍号 */
    _beatIndexAfter(t) {
      if (t < 0) return Math.floor(t / this.chart.beat) + 1;
      const bt = this.chart.beatTimes;
      let lo = 0, hi = bt.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (bt[mid] <= t) lo = mid + 1; else hi = mid; }
      return lo;
    }

    /* ---------- 装载 / 开始 ---------- */
    load(chart) {
      this.chart = chart;
      this.keys = chart.keys;
      const n = chart.notes.length;
      this.status = new Int8Array(n);      // 0 待判 1 命中 2 miss
      this.judge = new Int8Array(n);       // 0 perfect 1 great 2 miss
      this.offset = new Float32Array(n);   // ms，正=晚
      this.nextIdx = 0; this.drawIdx = 0;
      this.counts = [0, 0, 0];
      this.combo = 0; this.maxCombo = 0; this.emptyMiss = 0;
      this.scoreSum = 0; this.resolved = 0;
      this.lastJudge.kind = -1;
      for (const e of this.effects) e.t0 = -1;
      for (const e of this.errors) e.t0 = -1;
      this.lanePress.fill(0);
      this.touches.clear();
      this.taps = 0; this.emptyTaps = 0; this.assistHits = 0;
      this.tsAnomalies = 0; this.stateDrops = 0; this.lastDt = null;
      this.offSum = 0; this.offCount = 0;
      this.inputLog = [];         // 最近若干次输入，排查断触用
      this.bpmIdx = 0;
      this.currentBpm = chart.measureBpm ? chart.measureBpm[0] : chart.bpm;
      this.bpmFlashAt = -1;
      this._setupBgm();
      this.countInBeats = 4;
      this.countIn = this.countInBeats * chart.beat;
      this.state = 'idle';
      this.resize();
      this._drawStatic();
    }

    /* BGM 的速率比例按起始 BPM 定一次就不再变：
       挑战模式提速时音乐跟着一起变快，而不是每小节重新贴速度 */
    _setupBgm() {
      const id = this.settings.bgm;
      const g = (MG.BGM_BY_ID && MG.BGM_BY_ID[id]) || null;
      this.bgm = (g && (g.kind === 'groove' || g.kind === 'file')) ? g : null;
      this.bgmMeasure = 0;
      this.bgmStep = 0;
      this.bgmBuf = null;
      this.bgmSteps = 0;
      if (!this.bgm) return;
      // 倍率按全曲最高 BPM 定一次：挑战模式宁可开头慢一半，也不让结尾快一倍
      let refBpm = this.chart.bpm;
      const mb = this.chart.measureBpm;
      if (mb) for (let i = 0; i < mb.length; i++) if (mb[i] > refBpm) refBpm = mb[i];
      this.bgmRatio = MG.bgmTempoRatio(refBpm, this.bgm.baseBpm);
      if (this.bgm.kind === 'file') {
        this.bgmBuf = this.audio.decoded && this.audio.decoded[this.bgm.url] || null;
        if (!this.bgmBuf) { this.bgm = null; return; }
        // 用解码后的真实时长反推每小节时长，避免编码器补零造成累积误差
        this.bgmBarDur = this.bgmBuf.duration / this.bgm.loopBars;
      } else {
        this.bgmSteps = Math.max(1, Math.round(16 / this.bgmRatio));
      }
    }

    _scheduleBgm(now) {
      const g = this.bgm;
      if (!g || !this.audio.ctx || !this.audio.enabled) return;
      if (g.kind === 'file') return this._scheduleBgmFile(now);
      const ch = this.chart, horizon = now + 0.25, spm = this.bgmSteps;
      while (this.bgmMeasure < ch.measures) {
        const m = this.bgmMeasure;
        const mStart = ch.measureTime[m];
        const stepDur = (ch.measureTime[m + 1] - mStart) / spm;
        const t = mStart + this.bgmStep * stepDur;
        if (t > horizon) return;
        const gs = m * spm + this.bgmStep;     // 全局步号，各轨按自己的长度循环
        const when = this.audioStart + this.countIn + t;
        for (const inst in g.drums) {
          const seq = g.drums[inst];
          if (seq.charAt(gs % seq.length) === 'x') this._pushSrc(this.audio.playBgm(inst, when));
        }
        // 和弦进行按小节推进（一小节 16 步）
        const prog = g.progression;
        const chord = prog ? prog[Math.floor(gs / 16) % prog.length] : null;
        const tones = chord ? MG.bgmChordTones(chord) : null;
        for (const inst in g.tones) {
          const tr = g.tones[inst];
          const c = tr.seq.charAt(gs % tr.seq.length);
          if (c === '.') continue;
          const oct = tr.octave || 0;
          if (tones) {
            const voices = MG.BGM_CHORD_CHARS[c];
            if (!voices) continue;
            for (const v of voices) {
              this._pushSrc(this.audio.playBgm(inst, when, tones[v[0]] + v[1] + oct, tr.gain));
            }
          } else {
            const semi = MG.BGM_NOTES[c];
            if (semi === undefined || semi === null) continue;
            this._pushSrc(this.audio.playBgm(inst, when, semi + oct, tr.gain));
          }
        }
        this.bgmStep++;
        if (this.bgmStep >= spm) { this.bgmStep = 0; this.bgmMeasure++; }
      }
    }
    /* 录音型 BGM：一小节排一段，速率 = 本小节 BPM / 原速，
       相邻段重叠淡入淡出拼成无缝循环；挑战模式提速时录音跟着变快（音高同时升高） */
    _scheduleBgmFile(now) {
      const g = this.bgm, ch = this.chart, horizon = now + 0.4;
      const loopBars = g.loopBars, barDur = this.bgmBarDur, ratio = this.bgmRatio;
      while (this.bgmMeasure < ch.measures) {
        const m = this.bgmMeasure;
        const t = ch.measureTime[m];
        if (t > horizon) return;
        const measDur = ch.measureTime[m + 1] - t;
        // 一个缓冲小节横跨 ratio 个谱面小节
        const barPos = (m / ratio) % loopBars;
        const offset = barPos * barDur;
        const rate = (barDur / ratio) / measDur;
        this._pushSrc(this.audio.playSlice(
          this.bgmBuf, this.audioStart + this.countIn + t, offset, measDur, rate, 1));
        this.bgmMeasure++;
      }
    }
    _pushSrc(src) {
      if (!src) return;
      this.scheduled.push(src);
      if (this.scheduled.length > 256) this.scheduled.splice(0, 128);
    }

    start() {
      if (!this.chart) return;
      this.audio.ensure();
      this.audio.setVolume(this.settings.volume);
      this.audio.setBgmVolume(this.settings.bgmVolume);
      this.startPerf = performance.now() + 300;
      this.audioStart = this.audio.now() + 0.3;
      this.schedBeat = -this.countInBeats;
      this.scheduled = [];
      this.state = 'countin';
      cancelAnimationFrame(this.raf);
      const loop = () => { this.raf = requestAnimationFrame(loop); this._frame(); };
      this.raf = requestAnimationFrame(loop);
    }
    stop() {
      cancelAnimationFrame(this.raf);
      this._stopScheduled();
      this.state = 'idle';
    }
    chartTime(perfNow) { return (perfNow - this.startPerf) / 1000 - this.countIn; }

    pause() {
      if (this.state !== 'playing' && this.state !== 'countin') return;
      this.pausedPerf = performance.now();
      this.prevState = this.state;
      this.state = 'paused';
      this._stopScheduled();
      if (this.onPauseChange) this.onPauseChange(true);
    }
    resume() {
      if (this.state !== 'paused') return;
      this.state = 'resuming';
      this.resumeAt = performance.now() + 1000;
      if (this.onPauseChange) this.onPauseChange(false);
    }
    togglePause() {
      if (this.state === 'paused') this.resume();
      else this.pause();
    }
    _doResume() {
      const now = performance.now();
      const delta = now - this.pausedPerf;
      this.startPerf += delta;
      this.audioStart += delta / 1000;
      this.state = this.prevState;
      this.schedBeat = Math.max(this.schedBeat, this._beatIndexAfter(this.chartTime(now)));
      this._seekBgm(this.chartTime(now));
    }
    /* 暂停恢复后把 BGM 指针挪到当前时间 */
    _seekBgm(t) {
      if (!this.bgm) return;
      const ch = this.chart, spm = this.bgmSteps;
      if (this.bgm.kind === 'file') {
        let mm = 0;
        while (mm + 1 < ch.measures && ch.measureTime[mm + 1] <= t) mm++;
        this.bgmMeasure = Math.max(this.bgmMeasure, mm + 1);
        return;
      }
      let m = 0;
      while (m + 1 < ch.measures && ch.measureTime[m + 1] <= t) m++;
      const stepDur = (ch.measureTime[m + 1] - ch.measureTime[m]) / spm;
      let st = Math.ceil((t - ch.measureTime[m]) / stepDur);
      if (st >= spm) { st = 0; m++; }
      this.bgmMeasure = Math.max(this.bgmMeasure, m);
      this.bgmStep = this.bgmMeasure === m ? Math.max(this.bgmStep, st) : 0;
    }

    _stopScheduled() {
      if (!this.scheduled) return;
      for (const s of this.scheduled) { try { s.stop(); } catch (e) { /* */ } }
      this.scheduled.length = 0;
    }

    /* ---------- 判定 ---------- */
    _tInput(ts) { return this.chartTime(ts) - this.settings.offsetMs / 1000; }
    get perfectMs() { return this.settings.perfectMs || PERFECT_MS; }
    get greatMs() { return Math.max(this.settings.greatMs || GREAT_MS, this.perfectMs); }
    get approachSec() { return (BASE_APPROACH_MS / Math.max(0.1, this.settings.speed || 1)) / 1000; }

    inputLane(lane, ts, frac) {
      if (this.state !== 'playing' && this.state !== 'countin') {
        // 暂停 / 恢复倒数期间收到的输入，单独记一笔，便于区分「没收到」和「收到但被丢」
        if (this.state === 'paused' || this.state === 'resuming') this.stateDrops++;
        return;
      }
      if (!this.chart) return;
      this.taps++;
      this.lanePress[lane] = performance.now();
      const ct = this._tInput(ts);
      this._judgeInput(lane, ct, frac);
      // 记一笔：谁、什么时候、落在哪、判成什么
      this.inputLog.push([Math.round(ct * 1000), lane, this.lastDt === null ? null : Math.round(this.lastDt),
                          this.nativeMode ? 1 : 0]);
      if (this.inputLog.length > 600) this.inputLog.splice(0, 200);
    }

    /* 该轨窗口内最早的未判音符 */
    _findNote(lane, t) {
      const notes = this.chart.notes, n = notes.length, st = this.status;
      const win = this.greatMs / 1000;
      let best = -1, bestT = Infinity;
      for (let i = this.nextIdx; i < n; i++) {
        const nt = notes[i];
        if (nt.t > t + win) break;
        if (st[i] !== 0 || nt.col !== lane || nt.t < t - win) continue;
        if (nt.t < bestT) { best = i; bestT = nt.t; }
      }
      return best;
    }

    _judgeInput(lane, t, frac) {
      let best = this._findNote(lane, t);
      let assisted = false;
      // 只在落点确实贴着轨道边线、且本轨在判定窗口里没有音符可打时，才让一点余量给隔壁轨。
      // 余量按像素算（默认 12px），不是整条相邻轨，所以不会出现「乱点都能中」。
      const slack = Math.max(0, +this.settings.laneSlackPx || 0);
      if (best < 0 && slack > 0 && frac !== undefined && this.laneW > 0) {
        const tol = Math.min(0.45, slack / this.laneW);
        const nb = frac <= tol ? lane - 1 : (frac >= 1 - tol ? lane + 1 : -1);
        if (nb >= 0 && nb < this.keys) {
          const alt = this._findNote(nb, t);
          if (alt >= 0) { best = alt; assisted = true; lane = nb; this.lanePress[nb] = performance.now(); }
        }
      }
      if (this.settings.hitSound) this.audio.play('hit', 0, 0.9);
      if (best < 0) {
        this.emptyTaps++;
        this.lastDt = null;
        if (this.settings.missOnEmpty && this.state === 'playing') {
          this.emptyMiss++;
          this.combo = 0;
          this._showJudge(2, 0);
        }
        return;
      }
      if (assisted) this.assistHits++;
      const dtMs = (t - this.chart.notes[best].t) * 1000;
      this.lastDt = dtMs;
      this.offSum += dtMs; this.offCount++;
      this._resolve(best, Math.abs(dtMs) <= this.perfectMs ? 0 : 1, dtMs);
    }

    _resolve(i, kind, dtMs) {
      const nt = this.chart.notes[i];
      this.status[i] = kind === 2 ? 2 : 1;
      this.judge[i] = kind;
      this.offset[i] = dtMs;
      this.counts[kind]++;
      this.resolved++;
      this.scoreSum += JUDGE_WEIGHT[kind];
      if (kind === 2) this.combo = 0;
      else { this.combo++; if (this.combo > this.maxCombo) this.maxCombo = this.combo; }
      this._showJudge(kind, dtMs);
      if (kind !== 2) {
        const e = this.effects[this.effectPtr++ % this.effects.length];
        e.t0 = performance.now(); e.kind = kind; e.lane = nt.col;
        const er = this.errors[this.errorPtr++ % this.errors.length];
        er.off = dtMs; er.t0 = e.t0; er.kind = kind;
      }
    }
    _showJudge(kind, dtMs) {
      this.lastJudge.kind = kind; this.lastJudge.t0 = performance.now(); this.lastJudge.dt = dtMs;
    }

    /* ---------- 每帧 ---------- */
    _frame() {
      const perfNow = performance.now();
      if (this.state === 'resuming') {
        if (perfNow >= this.resumeAt) this._doResume();
        else { this._draw(this.chartTime(this.pausedPerf), perfNow); return; }
      }
      if (this.state === 'paused') { this._draw(this.chartTime(this.pausedPerf), perfNow); return; }
      const now = this.chartTime(perfNow);
      if (this.state === 'countin' && now >= 0) this.state = 'playing';
      this._scheduleAudio(now);
      this._scheduleBgm(now);
      const notes = this.chart.notes, n = notes.length, st = this.status;
      while (this.nextIdx < n && st[this.nextIdx] !== 0) this.nextIdx++;
      const missBefore = now - this.greatMs / 1000;
      for (let i = this.nextIdx; i < n && notes[i].t < missBefore; i++) {
        if (st[i] === 0) this._resolve(i, 2, 0);
      }
      if (this.settings.autoplay) {
        for (let i = this.nextIdx; i < n && notes[i].t <= now; i++) {
          if (st[i] === 0) {
            this._resolve(i, 0, 0);
            if (this.settings.hitSound) this.audio.play('hit', 0, 0.9);
            this.lanePress[notes[i].col] = perfNow;
          }
        }
      }
      // 挑战模式下 BPM 会逐段变化
      const mt = this.chart.measureTime;
      if (mt) {
        while (this.bpmIdx + 1 < this.chart.measureBpm.length && mt[this.bpmIdx + 1] <= now) this.bpmIdx++;
        const bpm = this.chart.measureBpm[this.bpmIdx];
        if (bpm !== this.currentBpm) { this.currentBpm = bpm; this.bpmFlashAt = perfNow; }
      }
      this._draw(now, perfNow);
      if (this.state === 'playing' && now > this.chart.duration + 1.2) this._finish();
    }

    _scheduleAudio(now) {
      const total = this.chart.beatTimes.length;
      const horizon = now + 0.2;
      while (this.schedBeat < total && this._beatTime(this.schedBeat) <= horizon) {
        const b = this.schedBeat;
        const isCountIn = b < 0;
        const wantTick = this.settings.bgm === 'metro' || this.settings.metroOverlay;
        if ((isCountIn || wantTick) && this.audio.ctx && this.audio.enabled) {
          const when = this.audioStart + this.countIn + this._beatTime(b);
          const name = ((b % 4) + 4) % 4 === 0 ? 'tickHi' : 'tickLo';
          const ctx = this.audio.ctx;
          const src = ctx.createBufferSource();
          src.buffer = this.audio.buffers[name];
          src.connect(this.audio.master);
          src.start(Math.max(when, ctx.currentTime));
          this.scheduled.push(src);
          if (this.scheduled.length > 32) this.scheduled.splice(0, 16);
        }
        this.schedBeat++;
      }
    }

    _finish() {
      cancelAnimationFrame(this.raf);
      this.state = 'finished';
      if (this.onFinish) this.onFinish(this.results());
    }

    results() {
      const n = this.chart.notes.length;
      let sum = 0, cnt = 0, early = 0, late = 0;
      const offs = [];
      for (let i = 0; i < n; i++) {
        if (this.status[i] !== 1) continue;
        const o = this.offset[i];
        offs.push(o); sum += o; cnt++;
        if (o < 0) early++; else if (o > 0) late++;
      }
      const mean = cnt ? sum / cnt : 0;
      let v = 0; for (const o of offs) v += (o - mean) * (o - mean);
      const total = n || 1;
      return {
        score: Math.round(1e6 * this.scoreSum / total),
        accuracy: this.scoreSum / total,
        counts: this.counts.slice(),
        total: n,
        maxCombo: this.maxCombo,
        emptyMiss: this.emptyMiss,
        meanOffset: mean,
        stdOffset: cnt ? Math.sqrt(v / cnt) : 0,
        early, late,
        taps: this.taps, emptyTaps: this.emptyTaps, assistHits: this.assistHits,
        tsAnomalies: this.tsAnomalies, stateDrops: this.stateDrops,
        nativeMode: this.nativeMode, nativeSeen: this.nativeSeen,
        inputLog: this.inputLog.slice(-400), clockDelta: this.clockDelta,
        suggestOffset: this.offCount >= 12
          ? Math.round(this.settings.offsetMs + this.offSum / this.offCount) : null,
        autoplay: !!this.settings.autoplay,
        perfectMs: this.perfectMs, greatMs: this.greatMs,
        segments: this._segmentStats(),
        chart: this.chart,
      };
    }

    /* 按 BPM 分段统计准确率：挑战模式用来看在哪一档开始崩 */
    _segmentStats() {
      const ch = this.chart;
      if (!ch.challenge || !ch.measureTime) return null;
      const notes = ch.notes, mt = ch.measureTime, mb = ch.measureBpm;
      const byBpm = new Map();
      let mi = 0;
      for (let i = 0; i < notes.length; i++) {
        while (mi + 1 < mb.length && mt[mi + 1] <= notes[i].t + 1e-9) mi++;
        const bpm = mb[mi];
        let e = byBpm.get(bpm);
        if (!e) { e = { bpm, total: 0, score: 0 }; byBpm.set(bpm, e); }
        e.total++;
        if (this.status[i] === 1) e.score += JUDGE_WEIGHT[this.judge[i]];
      }
      return [...byBpm.values()].sort((a, b) => a.bpm - b.bpm)
        .map((e) => ({ bpm: e.bpm, acc: e.total ? e.score / e.total : 0, total: e.total }));
    }

    /* ---------- 绘制 ---------- */
    _drawStatic() { this._draw(-this.countIn, performance.now()); }

    noteColor(nt) {
      if (!this.settings.handColors) return NEUTRAL_COLOR;
      if (this.keys === 7 && nt.col === 3) return THUMB_COLOR;
      return HAND_COLORS[nt.hand];
    }

    _draw(now, perfNow) {
      const g = this.ctx2d, W = this.W, H = this.H, S = this.settings;
      const chart = this.chart, K = this.keys;
      const judgeY = this.judgePx = H * S.judgeY;
      const approach = this.approachSec;
      const x0 = this.laneX0, lw = this.laneW, fieldW = lw * K;

      g.fillStyle = '#0b0d17';
      g.fillRect(0, 0, W, H);

      // 轨道底 + 两侧留白（留白区照样能点到最外侧轨，只是不摆音符）
      if (x0 > 1) {
        g.fillStyle = 'rgba(255,255,255,0.015)';
        g.fillRect(0, 0, x0, H);
        g.fillRect(x0 + fieldW, 0, W - x0 - fieldW, H);
      }
      g.fillStyle = 'rgba(255,255,255,0.03)';
      g.fillRect(x0, 0, fieldW, H);

      // 拍线（变速下逐拍取绝对时间）
      g.lineWidth = 1;
      for (let i = Math.max(-this.countInBeats, this._beatIndexAfter(now) - 1); ; i++) {
        const bt = this._beatTime(i);
        if (bt === Infinity) break;
        const dt = bt - now;
        if (dt > approach) break;
        if (dt < 0) continue;
        const y = judgeY * (1 - dt / approach);
        const bar = ((i % 4) + 4) % 4 === 0;
        g.strokeStyle = bar ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.04)';
        g.beginPath(); g.moveTo(x0, y); g.lineTo(x0 + fieldW, y); g.stroke();
      }

      // 轨道分隔线 + 按下高亮 + 键位
      g.strokeStyle = 'rgba(255,255,255,0.10)';
      for (let i = 0; i <= K; i++) {
        g.beginPath(); g.moveTo(x0 + i * lw, 0); g.lineTo(x0 + i * lw, H); g.stroke();
      }
      const labels = KEYMAP[K].labels;
      for (let i = 0; i < K; i++) {
        const p = (perfNow - this.lanePress[i]) / 220;
        if (p < 1) {
          const gr = g.createLinearGradient(0, judgeY - 240, 0, judgeY);
          gr.addColorStop(0, 'rgba(120,170,255,0)');
          gr.addColorStop(1, `rgba(140,185,255,${0.55 * (1 - p)})`);
          g.fillStyle = gr;
          g.fillRect(x0 + i * lw, judgeY - 240, lw, 240);
          // 判定线上一条亮杠，每一次被收到的输入都看得见
          g.fillStyle = `rgba(200,225,255,${0.9 * (1 - p)})`;
          g.fillRect(x0 + i * lw + 2, judgeY - 2, lw - 4, 4);
        }
        g.fillStyle = 'rgba(255,255,255,0.3)';
        g.font = '600 14px system-ui, sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(labels[i], this.laneCenter(i), judgeY + 30);
      }

      // 判定线
      const grad = g.createLinearGradient(0, judgeY - 3, 0, judgeY + 3);
      grad.addColorStop(0, 'rgba(120,160,255,0)');
      grad.addColorStop(0.5, 'rgba(160,190,255,0.9)');
      grad.addColorStop(1, 'rgba(120,160,255,0)');
      g.fillStyle = grad;
      g.fillRect(x0, judgeY - 3, fieldW, 6);

      // 音符
      const notes = chart.notes, n = notes.length, st = this.status;
      const showFrom = now - 0.25;
      while (this.drawIdx < n && notes[this.drawIdx].t < showFrom) this.drawIdx++;
      const h = this.noteH, pad = Math.max(2, lw * 0.06);
      for (let i = this.drawIdx; i < n; i++) {
        const nt = notes[i];
        const dt = nt.t - now;
        if (dt > approach) break;
        if (st[i] === 1) continue;
        const y = judgeY * (1 - dt / approach);
        g.globalAlpha = st[i] === 2 ? clamp(1 + dt / 0.25, 0, 1) * 0.3 : 1;
        const bx = x0 + nt.col * lw + pad, bw = lw - pad * 2;
        g.fillStyle = this.noteColor(nt);
        this._roundRect(g, bx, y - h / 2, bw, h, Math.min(6, h / 2));
        g.fill();
        g.fillStyle = 'rgba(255,255,255,0.4)';
        this._roundRect(g, bx + 2, y - h / 2 + 2, bw - 4, h * 0.28, 2);
        g.fill();
      }
      g.globalAlpha = 1;

      // 打击特效
      for (const e of this.effects) {
        if (e.t0 < 0) continue;
        const p = (perfNow - e.t0) / 260;
        if (p >= 1) { e.t0 = -1; continue; }
        const cx = this.laneCenter(e.lane);
        g.strokeStyle = JUDGE_COLORS[e.kind];
        g.globalAlpha = 1 - p;
        g.lineWidth = 4 * (1 - p) + 1;
        g.beginPath(); g.arc(cx, judgeY, lw * (0.3 + p * 0.55), 0, Math.PI * 2); g.stroke();
        g.globalAlpha = 1;
      }

      this._drawHUD(g, now, perfNow);
    }

    _drawHUD(g, now, perfNow) {
      const W = this.W, H = this.H, judgeY = this.judgePx;
      const total = this.chart.notes.length || 1;
      const score = Math.round(1e6 * this.scoreSum / total);
      const acc = this.resolved ? (this.scoreSum / this.resolved * 100) : 100;

      const prog = clamp(now / this.chart.duration, 0, 1);
      g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(0, 0, W, 3);
      g.fillStyle = '#7aa2ff'; g.fillRect(0, 0, W * prog, 3);

      g.textBaseline = 'top';
      g.fillStyle = '#ffffff';
      g.font = '700 22px "Segoe UI", system-ui, sans-serif';
      g.textAlign = 'left';
      g.fillText(String(score).padStart(7, '0'), 14, 12);
      g.textAlign = 'right';
      g.fillText(acc.toFixed(2) + '%', W - 14, 12);
      g.font = '500 12px system-ui, sans-serif'; g.fillStyle = 'rgba(255,255,255,0.5)';
      g.textAlign = 'left'; g.fillText('SCORE', 14, 38);
      g.textAlign = 'right';
      const bpmTxt = this.chart.challenge
        ? `${this.currentBpm} BPM → ${this.chart.bpmEnd}`
        : `${this.chart.bpm} BPM`;
      g.fillText(`${this.chart.presetName} · ${this.keys}K · ${bpmTxt}`, W - 14, 38);

      // 提速瞬间在中间闪一下，让人知道变快了
      if (this.bpmFlashAt > 0) {
        const p = (perfNow - this.bpmFlashAt) / 1100;
        if (p >= 1) this.bpmFlashAt = -1;
        else {
          g.save();
          g.globalAlpha = p < 0.6 ? 1 : (1 - p) / 0.4;
          g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillStyle = '#b58cff';
          g.font = '800 34px "Segoe UI", system-ui, sans-serif';
          g.fillText('♪ ' + this.currentBpm + ' BPM', W / 2, H * 0.30);
          g.restore();
          g.globalAlpha = 1;
        }
      }

      if (this.combo >= 2) {
        g.textAlign = 'center';
        g.fillStyle = 'rgba(255,255,255,0.9)';
        g.font = '800 44px "Segoe UI", system-ui, sans-serif';
        g.fillText(String(this.combo), W / 2, H * 0.16);
        g.font = '500 12px system-ui, sans-serif'; g.fillStyle = 'rgba(255,255,255,0.5)';
        g.fillText('COMBO', W / 2, H * 0.16 + 48);
      }

      const lj = this.lastJudge;
      if (lj.kind >= 0) {
        const p = (perfNow - lj.t0) / 500;
        if (p < 1) {
          g.save();
          g.translate(W / 2, judgeY - 130);
          const sc = 1 + 0.15 * Math.max(0, 1 - p * 5);
          g.scale(sc, sc);
          g.globalAlpha = p < 0.7 ? 1 : (1 - p) / 0.3;
          g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillStyle = JUDGE_COLORS[lj.kind];
          g.font = '800 30px "Segoe UI", system-ui, sans-serif';
          g.fillText(JUDGE_NAMES[lj.kind], 0, 0);
          if (lj.kind !== 2) {
            g.font = '600 13px system-ui, sans-serif';
            g.fillStyle = 'rgba(255,255,255,0.7)';
            g.fillText((lj.dt < 0 ? 'EARLY ' : 'LATE ') + Math.abs(lj.dt).toFixed(0) + 'ms', 0, 26);
          }
          g.restore();
          g.globalAlpha = 1;
        }
      }

      if (this.settings.inputDebug) {
        const hits = this.counts[0] + this.counts[1];
        const lines = [
          `触摸/按键 ${this.taps}   命中 ${hits}   打空 ${this.emptyTaps}`
            + (this.settings.autoplay ? '   [自动演奏]' : ''),
          `按住中 ${this.touches.size}   边缘救回 ${this.assistHits}   暂停期丢弃 ${this.stateDrops}`,
          `输入通道 ${this.nativeMode ? '原生直采 (' + this.nativeSeen + ')' : '浏览器 DOM'}`,
          `上次偏差 ${this.lastDt === null ? '打空' : (this.lastDt > 0 ? '+' : '') + this.lastDt.toFixed(0) + 'ms'}`
            + (this.offCount ? `   平均 ${(this.offSum / this.offCount > 0 ? '+' : '')}${(this.offSum / this.offCount).toFixed(0)}ms` : '')
            + (this.tsAnomalies ? `   时间戳异常 ${this.tsAnomalies}` : ''),
        ];
        g.textAlign = 'left'; g.textBaseline = 'top';
        g.font = '500 11px ui-monospace, Menlo, Consolas, monospace';
        for (let i = 0; i < lines.length; i++) {
          const w2 = g.measureText(lines[i]).width + 10;
          g.fillStyle = 'rgba(0,0,0,0.55)';
          g.fillRect(10, 56 + i * 15, w2, 14);
          // 自动演奏本来就没有输入，不该标红
          const suspect = !this.settings.autoplay && this.taps < hits;
          g.fillStyle = suspect ? '#ff5c7a' : 'rgba(255,255,255,0.8)';
          g.fillText(lines[i], 15, 58 + i * 15);
        }
      }

      if (this.settings.showErrorBar) {
        const bw = Math.min(240, W * 0.6), bx = (W - bw) / 2, by = H - 26;
        g.fillStyle = 'rgba(94,232,176,0.4)'; g.fillRect(bx, by - 3, bw, 6);
        const pw = bw * clamp(this.perfectMs / this.greatMs, 0.05, 1);
        g.fillStyle = 'rgba(255,215,94,0.6)'; g.fillRect(bx + (bw - pw) / 2, by - 3, pw, 6);
        g.fillStyle = '#fff'; g.fillRect(bx + bw / 2 - 1, by - 8, 2, 16);
        for (const e of this.errors) {
          if (e.t0 < 0) continue;
          const p = (perfNow - e.t0) / 2500;
          if (p >= 1) { e.t0 = -1; continue; }
          const x = bx + bw / 2 + clamp(e.off / this.greatMs, -1, 1) * bw / 2;
          g.globalAlpha = 1 - p;
          g.fillStyle = JUDGE_COLORS[e.kind];
          g.fillRect(x - 1, by - 9, 2, 18);
        }
        g.globalAlpha = 1;
      }

      if (now < 0 && this.state !== 'idle') {
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillStyle = 'rgba(255,255,255,0.9)';
        g.font = '800 64px "Segoe UI", system-ui, sans-serif';
        g.fillText(String(Math.ceil(-now / this.chart.beat)), W / 2, H * 0.4);
        g.font = '500 14px system-ui, sans-serif'; g.fillStyle = 'rgba(255,255,255,0.55)';
        g.fillText('轻触轨道 / 键盘 ' + KEYMAP[this.keys].labels.join(' '), W / 2, H * 0.4 + 52);
      }
      if (this.state === 'resuming') {
        g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(0, 0, W, H);
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillStyle = '#fff'; g.font = '800 64px "Segoe UI", system-ui, sans-serif';
        g.fillText(String(Math.max(1, Math.ceil((this.resumeAt - perfNow) / 1000 * 3))), W / 2, H * 0.4);
      }
    }

    _roundRect(g, x, y, w, h, r) {
      g.beginPath();
      g.moveTo(x + r, y);
      g.arcTo(x + w, y, x + w, y + h, r);
      g.arcTo(x + w, y + h, x, y + h, r);
      g.arcTo(x, y + h, x, y, r);
      g.arcTo(x, y, x + w, y, r);
      g.closePath();
    }
  }

  MG.Game = Game;
  MG.GAME_DEFAULTS = DEFAULT_SETTINGS;
  MG.KEYMAP = KEYMAP;
  MG.JUDGE = { PERFECT_MS, GREAT_MS, BASE_APPROACH_MS, NAMES: JUDGE_NAMES, COLORS: JUDGE_COLORS,
    HAND_COLORS, THUMB_COLOR };
})(window.MG = window.MG || {});
