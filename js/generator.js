/* 谱面生成器：4K / 7K，约束 + 打分 + 加权抽样
 * 输出 chart = { notes:[{t,col,hand}], keys, bpm, beat, measures, duration, restPeriod, phrases, warnings }
 * t 单位秒；col 为 0..keys-1；hand 0=左 1=右
 * 主段固定 16 分音，休息段固定 8 分音（只打单键）
 * 交互类仍用双手连续位置模型，最后映射到最近的列
 */
(function (root, deps) {
  'use strict';
  const RNG = deps.RNG, hashString = deps.hashString;

  const MAIN_DIV = 4;          // 主段每拍行数 = 16 分音
  const REST_DIV = 2;          // 休息段每拍行数 = 8 分音
  const PHRASE_MEASURES = 2;   // 乐句 = 2 小节
  const KEY_OPTIONS = [4, 7];
  const VMAX = 3.5;
  const MAX_MEASURES = 256;    // 挑战模式的小节上限，防止极端参数生成上万小节            // 单手移动速度上限（屏宽/秒）

  const PRESETS = {
    /* ---- 交互 ---- */
    trill_basic: {
      name: '普通交互', group: 'trill', kind: 'trill', mode: 'basic',
      desc: '严格一左一右交替，两手位置每 2 小节重抽',
    },
    trill_shift4: {
      name: '位移交互·4 键', group: 'trill', kind: 'trill', mode: 'shift', groupSize: 4,
      desc: '每 4 个键两手一起平移，越界反向，每组起手相同',
    },
    trill_shift3: {
      name: '位移交互·3 键', group: 'trill', kind: 'trill', mode: 'shift', groupSize: 3,
      desc: '每 3 个键平移一次，每组起手换手',
    },
    trill_axis: {
      name: '轴交互', group: 'trill', kind: 'trill', mode: 'axis',
      desc: '一手为轴基本不动，另一手持续位移（可反手 / X 形 / 8 形）',
    },
    trill_converge: {
      name: '交互收拢', group: 'trill', kind: 'trill', mode: 'converge',
      desc: '两手间距随乐句缩到 0，末尾变纵连',
    },
    trill_jack: {
      name: '纵连', group: 'trill', kind: 'jackline',
      desc: '整小节全在同一轨，逐小节换轨（换轨距离可调）',
    },

    /* ---- 切 ---- */
    stream_single: {
      name: '单键切', group: 'stream', kind: 'row', rule: 'stream', chord: { 1: 100 }, maxRun: 1,
      desc: '相邻行不共列的单键流',
    },
    stream_stairs: {
      name: '楼梯', group: 'stream', kind: 'row', rule: 'stream', stairs: true, chord: { 1: 100 }, maxRun: 1,
      desc: '奖励相邻列同向移动的楼梯流',
    },
    js_light: {
      name: '小切 LJS', group: 'stream', kind: 'row', rule: 'stream',
      chord: { 1: 100 }, chordOnBeat: { 2: 100 }, perBeat: 1, maxRun: 1,
      desc: '每拍 1 个双押，其余单键',
    },
    js_dense: {
      name: '小切 DJS', group: 'stream', kind: 'row', rule: 'stream',
      chord: { 1: 100 }, chordOnBeat: { 2: 100 }, perBeat: 2, maxRun: 1,
      desc: '每拍 2 个双押，其余单键',
    },
    hs_light: {
      name: '三切 LHS', group: 'stream', kind: 'row', rule: 'stream',
      chord: { 1: 100 }, chordOnBeat: { 2: 30, 3: 70 }, perBeat: 1, maxRun: 1,
      desc: '每拍 1 个多押（三押为主）',
    },
    hs_dense: {
      name: '三切 DHS', group: 'stream', kind: 'row', rule: 'stream',
      chord: { 1: 100 }, chordOnBeat: { 2: 30, 3: 70 }, perBeat: 2, maxRun: 1,
      desc: '每拍 2 个多押（三押为主）',
    },

    /* ---- 叠 ---- */
    jack_small: {
      name: '小叠', group: 'jack', kind: 'row', rule: 'jack',
      chord: { 1: 30, 2: 60, 3: 10 }, maxRun: 3,
      desc: '双押为主，相邻行至少共 1 列',
    },
    jack_mid: {
      name: '中叠', group: 'jack', kind: 'row', rule: 'jack',
      chord: { 1: 10, 2: 45, 3: 40, 4: 5 }, chord7: { 1: 10, 2: 40, 3: 35, 4: 15 }, maxRun: 4,
      desc: '双押 + 三押',
    },
    jack_big: {
      name: '大叠', group: 'jack', kind: 'row', rule: 'jack',
      chord: { 2: 25, 3: 50, 4: 25 }, chord7: { 2: 15, 3: 35, 4: 30, 5: 20 }, maxRun: 4,
      desc: '三押、四押为主',
    },
    jack_anchor: {
      name: '纵叠', group: 'jack', kind: 'row', rule: 'jack', anchor: true,
      chord: { 1: 35, 2: 45, 3: 20 }, maxRun: 6,
      desc: '每行都包含本乐句的锚定列',
    },

    /* ---- 乱 ---- */
    rand_low: {
      name: '乱·低密度', group: 'chaos', kind: 'row', rule: 'random',
      gap: 0.10, chord: { 1: 95, 2: 5 }, maxRun: 2,
      desc: '随机列的单键流，基本每行一个键，偶尔双押',
    },
    rand_mid: {
      name: '乱·中密度', group: 'chaos', kind: 'row', rule: 'random',
      gap: 0.06, chord: { 1: 72, 2: 25, 3: 3 }, maxRun: 2,
      desc: '同上，双押多一些，偶尔三押',
    },
  };
  const PRESET_KEYS = Object.keys(PRESETS);
  const FANCY_KEYS = PRESET_KEYS.filter(k => PRESETS[k].group !== 'chaos');

  /* ---------- 工具 ---------- */
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  function popcount(m) { let c = 0; while (m) { m &= m - 1; c++; } return c; }
  function maskCols(m, K) { const o = []; for (let i = 0; i < K; i++) if (m & (1 << i)) o.push(i); return o; }
  const colToX = (col, K) => (col + 0.5) / K;
  const xToCol = (x, K) => clamp(Math.round(x * K - 0.5), 0, K - 1);
  /* 列 → 手：K=7 时中间列（col 3）返回 -1，由行内负载决定 */
  function colHand(col, K) {
    const lo = Math.floor(K / 2), hi = Math.ceil(K / 2);
    return col < lo ? 0 : (col >= hi ? 1 : -1);
  }

  /* ---------- 默认选项 ---------- */
  const DEFAULT_OPTS = {
    preset: 'stream_single',
    bpm: 160,
    seed: 'demo',
    measures: 16,
    keys: 4,                 // 4 | 7
    restRatio: 0,            // 休息段比例（休息段只有 8 分音），默认不插入
    shiftAmount: 0.5,        // 交互位移幅度 0..1
    axisHand: 'left',        // 'left' | 'right' | 'alt'
    axisStyle: 'tri',        // 'tri' | 'x' | '8'
    mixedPool: null,         // 散打里可以插入的花样预设
    fancyRatio: 0.35,        // 散打里花样乐句的比例，其余为乱
    challenge: false,        // 挑战模式：BPM 逐段递增
    bpmEnd: 200,             // 挑战目标 BPM
    rampMeasures: 4,         // 每几小节提一次速
    rampStep: 5,             // 每次提多少
  };

  function normalizeOpts(o) {
    const opts = Object.assign({}, DEFAULT_OPTS, o || {});
    opts.bpm = clamp(Math.round(+opts.bpm || 160), 40, 400);
    opts.measures = Math.max(2, Math.round(+opts.measures || 16));
    opts.keys = KEY_OPTIONS.indexOf(+opts.keys) >= 0 ? +opts.keys : 4;
    opts.restRatio = clamp(+opts.restRatio, 0, 0.5);
    opts.shiftAmount = clamp(+opts.shiftAmount, 0, 1);
    opts.fancyRatio = clamp(+opts.fancyRatio, 0, 1);
    opts.challenge = !!opts.challenge;
    opts.bpmEnd = clamp(Math.round(+opts.bpmEnd || 200), 40, 400);
    opts.rampMeasures = clamp(Math.round(+opts.rampMeasures || 4), 1, 32);
    opts.rampStep = clamp(Math.round(+opts.rampStep || 5), 1, 50);
    if (opts.challenge) opts.measures = challengeMeasures(opts);
    if (opts.preset === 'mixed') {
      let pool = Array.isArray(opts.mixedPool) ? opts.mixedPool.filter(k => PRESETS[k] && PRESETS[k].group !== 'chaos') : null;
      opts.mixedPool = (pool && pool.length) ? pool : FANCY_KEYS.slice();
    } else if (!PRESETS[opts.preset]) {
      opts.preset = 'stream_single';
    }
    return opts;
  }

  /* ---------- 挑战模式：速度表 ---------- */
  function challengeSteps(opts) {
    const diff = Math.abs(opts.bpmEnd - opts.bpm);
    return diff === 0 ? 0 : Math.ceil(diff / opts.rampStep);
  }
  /* 覆盖整条爬升所需的小节数：每一档占 rampMeasures 小节 */
  function challengeMeasures(opts) {
    return clamp((challengeSteps(opts) + 1) * opts.rampMeasures, 2, MAX_MEASURES);
  }
  function bpmOfMeasure(opts, m) {
    if (!opts.challenge) return opts.bpm;
    const dir = Math.sign(opts.bpmEnd - opts.bpm);
    if (!dir) return opts.bpm;
    const v = opts.bpm + dir * opts.rampStep * Math.floor(m / opts.rampMeasures);
    return dir > 0 ? Math.min(v, opts.bpmEnd) : Math.max(v, opts.bpmEnd);
  }
  /* 逐小节累加出每小节起点与每一拍的绝对时间，变速下所有下游逻辑都用它 */
  function buildTempo(opts) {
    const M = opts.measures;
    const measureBpm = new Float64Array(M);
    const measureTime = new Float64Array(M + 1);
    for (let m = 0; m < M; m++) {
      measureBpm[m] = bpmOfMeasure(opts, m);
      measureTime[m + 1] = measureTime[m] + 4 * 60 / measureBpm[m];
    }
    const beatTimes = new Float64Array(M * 4 + 1);
    for (let m = 0; m < M; m++) {
      const bt = 60 / measureBpm[m];
      for (let b = 0; b < 4; b++) beatTimes[m * 4 + b] = measureTime[m] + b * bt;
    }
    beatTimes[M * 4] = measureTime[M];
    return { measureBpm, measureTime, beatTimes, duration: measureTime[M] };
  }

  function restPeriodOf(ratio) {
    return ratio >= 0.01 ? Math.max(2, Math.round(1 / ratio)) : 0;
  }

  /* ---------- 逐行生成（切 / 叠 / 乱） ---------- */
  function chordTable(preset, K, onBeat) {
    if (K === 7) {
      if (onBeat && preset.chordOnBeat7) return preset.chordOnBeat7;
      if (!onBeat && preset.chord7) return preset.chord7;
    }
    return onBeat ? preset.chordOnBeat : preset.chord;
  }

  function pickChordSize(rng, table) {
    const sizes = [], w = [];
    for (const k in table) if (table[k] > 0) { sizes.push(+k); w.push(table[k]); }
    if (!sizes.length) return 1;
    return rng.weighted(sizes, w);
  }

  /* 乱：本行是否有音符。「密度」指多押的多少，不是留白多少，
     所以这里默认几乎每行都有键，只在弱拍上留极少量空行做呼吸 */
  function rowActive(rng, preset, r, div) {
    const gap = preset.gap || 0;
    if (gap <= 0) return true;
    const pos = r % div;
    let p;
    if (pos === 0) p = gap * 0.15;          // 重拍基本不空
    else if (pos * 2 === div) p = gap * 0.6;
    else p = gap;
    return !rng.chance(p);
  }

  function rowCandidates(ctx, rule, preset, pp, k, relaxShare) {
    const K = ctx.K, prev = ctx.prevRows;
    const last = prev.length ? prev[prev.length - 1] : 0;
    const total = (1 << K) - 1;
    const out = [];
    for (let m = 1; m <= total; m++) {
      if (popcount(m) !== k) continue;
      if (rule === 'jack' && preset.anchor && !(m & (1 << pp.anchorCol))) continue;
      if (prev.length) {
        if (rule === 'stream' && (m & last)) continue;
        if (rule === 'jack' && !relaxShare && !(m & last)) continue;
      }
      const maxRun = rule === 'rest' ? 2 : pp.maxRun;
      let bad = false;
      for (let c = 0; c < K; c++) {
        if (!(m & (1 << c))) continue;
        if (ctx.runs[c] >= maxRun && !(rule === 'jack' && preset.anchor && c === pp.anchorCol)) { bad = true; break; }
      }
      if (bad) continue;
      out.push({ mask: m, penalty: rowPenalty(ctx, rule, preset, pp, m) });
    }
    return out;
  }

  function rowPenalty(ctx, rule, preset, pp, m) {
    const K = ctx.K, prev = ctx.prevRows, n = prev.length;
    const last = n ? prev[n - 1] : 0;
    let p = 0;

    if (rule === 'jack') {
      if (n >= 1) {
        if (m === last && popcount(m) < K) p += 2.0;
        p += 0.7 * Math.abs(popcount(m & last) - 1);
      }
      if (n >= 2 && m === prev[n - 2] && m !== last) p += 0.6;
    } else {
      // 切 / 乱 / 休息：避免 ABA、ABAB
      if (n >= 2 && m === prev[n - 2] && m !== last) {
        p += rule === 'stream' ? 1.5 : 0.8;
        if (n >= 3 && last === prev[n - 3]) p += 3.0;
      }
      if (rule !== 'stream' && n >= 1 && (m & last)) p += 0.5 * popcount(m & last);
      // 楼梯
      if (popcount(m) === 1 && n >= 1 && popcount(last) === 1) {
        const col = maskCols(m, K)[0], pcol = maskCols(last, K)[0];
        const d = col - pcol;
        const sameDir = Math.abs(d) === 1 && d === ctx.stairDir;
        if (rule === 'stream' && preset.stairs) {
          if (Math.abs(d) === 1) {
            const atEdge = pcol === 0 || pcol === K - 1;
            p += (sameDir || atEdge) ? -1.0 : 0.2;
          } else p += 0.8;
        } else if (rule === 'stream') {
          if (sameDir && ctx.stairLen >= 2) p += 0.5 * (ctx.stairLen - 1);
        }
      }
    }

    // 手内负载与行内分布
    let L = 0, R = 0, sameHandMax = 0;
    const acc = (mm, w) => {
      let l = 0, r = 0;
      for (let c = 0; c < K; c++) {
        if (!(mm & (1 << c))) continue;
        const h = colHand(c, K);
        if (h === 0) l++; else if (h === 1) r++; else { l += 0.5; r += 0.5; }
      }
      L += l * w; R += r * w;
      if (w === 1) sameHandMax = Math.max(l, r);
    };
    acc(m, 1);
    for (let i = Math.max(0, n - 3); i < n; i++) acc(prev[i], 1);
    p += 0.3 * Math.abs(L - R);
    if (popcount(m) >= 2) p += 0.45 * Math.max(0, sameHandMax - 2);
    return p;
  }

  function sampleCandidates(rng, cands) {
    let minP = Infinity;
    for (const c of cands) if (c.penalty < minP) minP = c.penalty;
    const w = cands.map(c => Math.exp(-(c.penalty - minP)));
    return rng.weighted(cands, w).mask;
  }

  function genRow(ctx, preset, pp, r, div, isRest) {
    const rng = ctx.rng, K = ctx.K;
    const rule = isRest ? 'rest' : preset.rule;
    if (preset.rule === 'random' && !rowActive(rng, preset, r, div)) return 0;

    let k;
    if (isRest) k = 1;
    else if (preset.chordOnBeat) {
      const per = preset.perBeat || 1;
      const step = Math.max(1, Math.round(div / per));
      k = (r % step === 0) ? pickChordSize(rng, chordTable(preset, K, true)) : 1;
    } else {
      k = pickChordSize(rng, chordTable(preset, K, false));
    }
    k = clamp(k, 1, K);

    const THRESH = 3.0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const relax = attempt > 0;
      const pool = [];
      for (let kk = k; kk >= 1; kk--) {
        const drop = (k - kk) * 1.0;
        for (const c of rowCandidates(ctx, rule, preset, pp, kk, relax)) {
          pool.push({ mask: c.mask, penalty: c.penalty + drop });
        }
        if (pool.some(x => x.penalty <= THRESH)) break;
      }
      if (pool.length) return sampleCandidates(rng, pool);
      if (rule !== 'jack') break;   // 叠被卡死时放宽「必须共列」
    }
    return 0;   // 仍无解：空一行
  }

  function commitRow(ctx, m) {
    const K = ctx.K, prev = ctx.prevRows;
    const last = prev.length ? prev[prev.length - 1] : 0;
    if (m && popcount(m) === 1 && prev.length && popcount(last) === 1) {
      const d = maskCols(m, K)[0] - maskCols(last, K)[0];
      if (Math.abs(d) === 1 && d === ctx.stairDir) ctx.stairLen++;
      else { ctx.stairDir = Math.abs(d) === 1 ? d : 0; ctx.stairLen = Math.abs(d) === 1 ? 1 : 0; }
    } else { ctx.stairDir = 0; ctx.stairLen = 0; }
    for (let c = 0; c < K; c++) ctx.runs[c] = (m & (1 << c)) ? ctx.runs[c] + 1 : 0;
    if (m) {
      prev.push(m);
      if (prev.length > 8) prev.shift();
    }
  }

  function pushRow(ctx, mask, t) {
    const K = ctx.K, cols = maskCols(mask, K);
    let L = 0, R = 0;
    for (const c of cols) { const h = colHand(c, K); if (h === 0) L++; else if (h === 1) R++; }
    for (const c of cols) {
      let h = colHand(c, K);
      if (h === -1) {
        h = (L <= R) ? 0 : 1;
        if (h === 0) L++; else R++;
      }
      ctx.notes.push({ t, col: c, hand: h });
    }
    // 供交互路径接力：单键行记下列号，多押行视为无约束
    ctx.lastCol = cols.length === 1 ? cols[0] : -1;
  }

  /* ---------- 交互：双手模型 → 最近列 ---------- */
  function samplePhraseTrill(ctx, preset, pp, opts) {
    const rng = ctx.rng, K = ctx.K, amt = opts.shiftAmount;
    const unit = 1 / K;
    const E = 0.5 * unit;                 // 最外侧列中心
    const span = 1 - 2 * E;               // 可用范围
    pp.allowCross = false;
    pp.collapse = false;

    // 起手必须一左一右跨过中线：L ≤ 0.5 ≤ R
    const pickPair = (gap) => {
      const g = clamp(gap, 1.05 * unit, Math.max(1.05 * unit, span));
      const lo = Math.max(E + g / 2, 0.5 - g / 2);
      const hi = Math.min(1 - E - g / 2, 0.5 + g / 2);
      const c = hi > lo ? rng.float(lo, hi) : 0.5;
      return [c - g / 2, c + g / 2];
    };

    switch (preset.mode) {
      case 'basic': {
        const g = rng.float(1.05 * unit, Math.min(span, 3.2 * unit));
        const pair = pickPair(g);
        pp.L = pair[0]; pp.R = pair[1];
        break;
      }
      case 'shift': {
        const g = rng.float(1.05 * unit, Math.min(span, 2.6 * unit));
        const pair = pickPair(g);
        pp.L = pair[0]; pp.R = pair[1];
        pp.step = lerp(0.6 * unit, 2.2 * unit, amt);
        pp.dir = rng.sign();
        pp.off = 0;
        break;
      }
      case 'axis': {
        const axisLeft = opts.axisHand === 'left' ? true
          : opts.axisHand === 'right' ? false
          : (ctx.phraseIndex % 2 === 0);
        pp.axisLeft = axisLeft;
        pp.style = opts.axisStyle;
        pp.period = rng.pick([4, 6, 8]);
        if (pp.style === 'tri') {
          const a = axisLeft ? rng.float(E, E + 1.2 * unit) : rng.float(1 - E - 1.2 * unit, 1 - E);
          pp.axis = clamp(a, E, 1 - E);
          const lo = axisLeft ? pp.axis + 1.05 * unit : E;
          const hi = axisLeft ? 1 - E : pp.axis - 1.05 * unit;
          const range = Math.max(0.5 * unit, hi - lo);
          const ampl = clamp(lerp(1.2 * unit, (K - 1) * unit, amt), 0.5 * unit, range);
          const mid = clamp(rng.float(lo + ampl / 2, hi - ampl / 2), Math.min(lo, hi), Math.max(lo, hi));
          pp.mLo = clamp(mid - ampl / 2, E, 1 - E);
          pp.mHi = clamp(mid + ampl / 2, E, 1 - E);
        } else {
          pp.allowCross = true;
          pp.axis = rng.float(0.5 - 0.5 * unit, 0.5 + 0.5 * unit);
          pp.mLo = E; pp.mHi = 1 - E;
          pp.startSide = rng.sign();
        }
        break;
      }
      case 'converge': {
        const gMax = Math.min(span, (K - 1) * unit);
        pp.g0 = rng.float(Math.max(2 * unit, gMax * 0.6), gMax);
        pp.center = pickPair(pp.g0)[0] + pp.g0 / 2;
        pp.allowCross = true;
        break;
      }
    }
  }

  function trillTarget(ctx, preset, pp, hand, idx) {
    const K = ctx.K, unit = 1 / K, E = 0.5 * unit;
    switch (preset.mode) {
      case 'basic':
        return hand === 0 ? pp.L : pp.R;
      case 'shift': {
        const g = preset.groupSize;
        if (idx > 0 && idx % g === 0) {
          let off = pp.off + pp.step * pp.dir;
          if (pp.L + off < E || pp.R + off > 1 - E) { pp.dir = -pp.dir; off = pp.off + pp.step * pp.dir; }
          pp.off = off;
        }
        return (hand === 0 ? pp.L : pp.R) + pp.off;
      }
      case 'axis': {
        const isAxis = (hand === 0) === pp.axisLeft;
        if (isAxis) return pp.axis;
        const mi = idx >> 1;
        let phase;
        if (pp.style === 'tri') {
          phase = (mi % pp.period) / pp.period;
        } else {
          const nM = Math.max(2, Math.ceil(pp.N / 2));
          phase = pp.style === 'x' ? (mi / nM) * 0.5 : (mi / nM);
          if (pp.startSide < 0) phase = (phase + 0.5) % 1;
          phase = phase % 1;
        }
        const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2;
        return pp.mLo + (pp.mHi - pp.mLo) * tri;
      }
      case 'converge': {
        const N = Math.max(2, pp.N);
        const gap = pp.g0 * Math.max(0, 1 - idx / (N - 1));
        pp.collapse = gap < 0.9 / K;
        return hand === 0 ? pp.center - gap / 2 : pp.center + gap / 2;
      }
    }
    return 0.5;
  }

  function placeCol(want, other, side, K) {
    let col = clamp(want, 0, K - 1);
    if (other < 0) return col;
    col = side < 0 ? Math.min(col, other - 1) : Math.max(col, other + 1);
    if (col < 0 || col > K - 1) {
      col = clamp(want, 0, K - 1);
      if (col === other) col = other > 0 ? other - 1 : other + 1;
    }
    return clamp(col, 0, K - 1);
  }

  function genTrillNote(ctx, preset, pp, t) {
    const K = ctx.K, H = ctx.hands, unit = 1 / K, E = 0.5 * unit;
    const hand = ctx.nextHand; ctx.nextHand ^= 1;
    const idx = ctx.trillIdx++;
    let target = trillTarget(ctx, preset, pp, hand, idx);

    if (!H.free[hand] && H.t[hand] >= 0) {
      const dt = t - H.t[hand];
      target = clamp(target, H.x[hand] - VMAX * dt, H.x[hand] + VMAX * dt);
    }
    if (!pp.allowCross) {
      const gap = 1.02 * unit;
      if (hand === 0) target = Math.min(target, H.x[1] - gap);
      else target = Math.max(target, H.x[0] + gap);
    }
    target = clamp(target, E, 1 - E);
    H.x[hand] = target; H.t[hand] = t; H.free[hand] = false;

    let col = xToCol(target, K);
    const other = ctx.lastCol;
    if (other >= 0) {
      if (pp.collapse) {
        col = other;                                   // 收拢到底 → 纵连
      } else if (pp.allowCross) {
        if (col === other) {
          const dir = hand === 0 ? -1 : 1;
          let c2 = col + dir;
          if (c2 < 0 || c2 >= K) c2 = col - dir;
          if (c2 >= 0 && c2 < K) col = c2;
        }
      } else {
        col = placeCol(col, other, hand === 0 ? -1 : 1, K);
      }
    }
    ctx.lastCol = col;
    ctx.notes.push({ t, col, hand });
    commitRow(ctx, 1 << col);   // 与逐行路径共享行历史，散打切换预设时才接得上
  }

  /* ---------- 乐句参数 ---------- */
  function rollPhrase(ctx, preset, m, restPeriod, opts) {
    const rng = ctx.rng, K = ctx.K;
    const pp = { maxRun: preset.maxRun || 1 };
    let n = 0;
    for (let i = m; i < Math.min(m + PHRASE_MEASURES, opts.measures); i++) {
      const rest = restPeriod > 0 && ((i + 1) % restPeriod === 0);
      n += 4 * (rest ? REST_DIV : MAIN_DIV);
    }
    pp.N = Math.max(2, n);
    if (preset.anchor) pp.anchorCol = rng.int(0, K - 1);
    if (preset.kind === 'trill') samplePhraseTrill(ctx, preset, pp, opts);
    return pp;
  }

  /* 纵连换轨：不连着两小节用同一轨，否则整段变成一条不断的纵连。
     shiftAmount 控制跳多远：0 只挪到相邻轨，1 可以横跨整个键位。 */
  function pickJackCol(ctx, opts) {
    const K = ctx.K, rng = ctx.rng;
    const prev = ctx.jackCol;
    if (prev === undefined) return rng.int(0, K - 1);
    const span = Math.max(1, Math.round(lerp(1, K - 1, clamp(+opts.shiftAmount || 0, 0, 1))));
    const cand = [];
    for (let c = 0; c < K; c++) {
      if (c === prev) continue;
      if (Math.abs(c - prev) <= span) cand.push(c);
    }
    if (!cand.length) return (prev + 1) % K;
    return cand[rng.int(0, cand.length - 1)];
  }

  /* 换气：休息段前后只放开两手的移动速度限制（允许瞬移换位），
     列约束（不共列 / 必共列 / 不同列）保持连续，否则边界处会冒出假纵连 */
  function breathe(ctx) {
    ctx.hands.free = [true, true];
    ctx.stairDir = 0; ctx.stairLen = 0;
  }

  /* ---------- 主流程 ---------- */
  function generate(userOpts) {
    const opts = normalizeOpts(userOpts);
    const K = opts.keys;
    const mixed = opts.preset === 'mixed';
    const seedStr = [
      opts.seed,
      mixed ? 'mixed:' + opts.mixedPool.join(',') : opts.preset,
      opts.bpm, K, opts.measures,
      opts.challenge ? `ch${opts.bpmEnd}/${opts.rampMeasures}/${opts.rampStep}` : 'fix',
      opts.restRatio.toFixed(2), opts.shiftAmount.toFixed(2),
      opts.axisHand, opts.axisStyle, opts.fancyRatio.toFixed(2),
    ].join('|');
    const rng = new RNG(hashString(seedStr));
    const beat = 60 / opts.bpm;          // 起始速度，用于预备拍等
    const tempo = buildTempo(opts);
    const restPeriod = restPeriodOf(opts.restRatio);

    const ctx = {
      rng, opts, K, notes: [],
      prevRows: [], runs: new Array(K).fill(0), stairDir: 0, stairLen: 0,
      hands: { x: [0.5 - 1 / K, 0.5 + 1 / K], t: [-1, -1], free: [true, true] },
      nextHand: 0, trillIdx: 0, lastCol: -1, phraseIndex: 0,
    };

    const phrases = [];
    let preset = null, pp = null, curKey = mixed ? null : opts.preset, lastKey = null;

    for (let m = 0; m < opts.measures; m++) {
      const isRest = restPeriod > 0 && ((m + 1) % restPeriod === 0);
      const div = isRest ? REST_DIV : MAIN_DIV;

      if (m % PHRASE_MEASURES === 0 || !pp) {
        if (mixed) {
          if (rng.chance(opts.fancyRatio)) {
            const pool = opts.mixedPool.length > 1 ? opts.mixedPool.filter(k => k !== lastKey) : opts.mixedPool;
            curKey = rng.pick(pool);
          } else {
            curKey = rng.chance(0.75) ? 'rand_low' : 'rand_mid';
          }
        }
        lastKey = curKey;
        preset = PRESETS[curKey];
        ctx.trillIdx = 0;
        pp = rollPhrase(ctx, preset, m, restPeriod, opts);
        ctx.phraseIndex++;
        // 乐句边界不清空行历史（否则切的相邻行会共列变成假纵连），
        // 只允许两手重新定位
        ctx.hands.free = [true, true];
        phrases.push({
          key: curKey, name: preset.name, startMeasure: m,
          measures: Math.min(PHRASE_MEASURES, opts.measures - m),
        });
      }
      if (isRest) breathe(ctx);

      // 纵连：整小节钉在一条轨上，进小节时换一次
      if (preset.kind === 'jackline') ctx.jackCol = pickJackCol(ctx, opts);

      const mBeat = 60 / tempo.measureBpm[m];
      for (let b = 0; b < 4; b++) {
        for (let r = 0; r < div; r++) {
          const t = tempo.measureTime[m] + (b + r / div) * mBeat;
          if (preset.kind === 'trill') {
            genTrillNote(ctx, preset, pp, t);
          } else if (preset.kind === 'jackline') {
            const mask = 1 << ctx.jackCol;
            commitRow(ctx, mask);
            pushRow(ctx, mask, t);
          } else {
            const mask = genRow(ctx, preset, pp, r, div, isRest);
            commitRow(ctx, mask);
            if (mask) pushRow(ctx, mask, t);
          }
        }
      }
      if (isRest) breathe(ctx);
    }

    const notes = ctx.notes;
    notes.sort((a, b) => (a.t - b.t) || (a.col - b.col));
    for (let i = 0; i < notes.length; i++) notes[i].id = i;

    const chart = {
      notes, keys: K, bpm: opts.bpm, beat, measures: opts.measures,
      duration: tempo.duration,
      beatTimes: tempo.beatTimes, measureTime: tempo.measureTime, measureBpm: tempo.measureBpm,
      challenge: opts.challenge,
      bpmStart: opts.bpm,
      bpmEnd: tempo.measureBpm[opts.measures - 1],
      rampMeasures: opts.rampMeasures, rampStep: opts.rampStep,
      restPeriod, restRatio: restPeriod ? 1 / restPeriod : 0,
      mainDiv: MAIN_DIV, restDiv: REST_DIV,
      phrases, opts, seedHash: rng.seed,
      presetName: mixed ? '散打' : PRESETS[opts.preset].name,
      warnings: [],
    };
    chart.warnings = validate(chart);
    return chart;
  }

  /* ---------- 自检 ---------- */
  function validate(chart) {
    const w = [];
    const notes = chart.notes, K = chart.keys;
    let oob = 0, dup = 0, tooClose = 0, bigChord = 0;
    const lastT = new Array(K).fill(-1);
    let i = 0;
    while (i < notes.length) {
      let j = i;
      const t = notes[i].t;
      const seen = new Set();
      while (j < notes.length && Math.abs(notes[j].t - t) < 1e-9) {
        const c = notes[j].col;
        if (c < 0 || c >= K) oob++;
        if (seen.has(c)) dup++;
        seen.add(c);
        if (lastT[c] >= 0 && (t - lastT[c]) * 1000 < 45) tooClose++;
        lastT[c] = t;
        j++;
      }
      if (seen.size > K) bigChord++;
      i = j;
    }
    if (oob) w.push(`有 ${oob} 个音符列越界`);
    if (dup) w.push(`有 ${dup} 处同一时刻同一列重复`);
    if (bigChord) w.push(`有 ${bigChord} 行押数超过键数`);
    if (tooClose) w.push(`有 ${tooClose} 处同列间隔 < 45ms（BPM 偏高，判定会很勉强）`);
    return w;
  }

  root.Generator = {
    generate, validate, PRESETS, PRESET_KEYS, FANCY_KEYS, DEFAULT_OPTS,
    normalizeOpts, restPeriodOf, challengeMeasures, challengeSteps, bpmOfMeasure,
    KEY_OPTIONS, MAIN_DIV, REST_DIV, PHRASE_MEASURES, MAX_MEASURES,
    colToX, xToCol, colHand,
  };
})(
  typeof module !== 'undefined' ? module.exports : (window.MG = window.MG || {}),
  typeof module !== 'undefined' ? require('./rng.js') : (window.MG = window.MG || {})
);
