/* 用户自己上传的 BGM：存进 IndexedDB 永久保留，上传时在浏览器里测一次速。
 * 测速只给个起点，最终以用户在确认面板里听到的为准 —— 节拍器叠在音乐上，
 * 对不齐就手动调 BPM 与起拍点。
 */
(function (MG) {
  'use strict';

  const DB_NAME = 'rhythmlab_bgm';
  const STORE = 'tracks';
  const MAX_BYTES = 30 * 1024 * 1024;   // 单曲上限，太大解码会把手机内存吃光

  /* ---------- IndexedDB ---------- */
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error || new Error('indexedDB 打不开'));
    });
    return dbp;
  }
  function tx(mode, fn) {
    return db().then((d) => new Promise((res, rej) => {
      const t = d.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    }));
  }
  const listAll = () => tx('readonly', (s) => s.getAll());
  const putOne = (rec) => tx('readwrite', (s) => s.put(rec));
  const delOne = (id) => tx('readwrite', (s) => s.delete(id));

  /* ---------- 轻量 FFT（迭代式基 2），只在上传时跑一次 ---------- */
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const nr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
  }

  /* 单声道 + 降采样到 ~11025Hz，后面所有分析都在这上面做 */
  function toMono(buf, sr, maxSec) {
    const ratio = buf.sampleRate / sr;
    let n = Math.floor(buf.length / ratio);
    if (maxSec) n = Math.min(n, Math.floor(sr * maxSec));
    const out = new Float32Array(n);
    const chs = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
    for (let i = 0; i < n; i++) {
      const src = Math.floor(i * ratio);
      let v = 0;
      for (let c = 0; c < chs.length; c++) v += chs[c][src];
      out[i] = v / chs.length;
    }
    return out;
  }

  /* 起音包络：谱通量（只取变强的部分），鼓点和琴键的起音都能抓到 */
  function onsetEnvelope(x, sr) {
    const N = 512, HOP = 128, BINS = N / 2;
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    const frames = Math.max(1, Math.floor((x.length - N) / HOP));
    const env = new Float32Array(frames);
    // 低频（< ~200Hz，底鼓 / 贝斯）单独一条包络：定「拍在哪」时用它，
    // 否则镲片和军鼓的谱通量更尖，拍点会被拉到十六分音上
    const envLow = new Float32Array(frames);
    const LOW_BINS = Math.max(2, Math.round(200 / (sr / N)));
    const re = new Float32Array(N), im = new Float32Array(N);
    let prev = new Float32Array(BINS);
    for (let f = 0; f < frames; f++) {
      const off = f * HOP;
      for (let i = 0; i < N; i++) { re[i] = x[off + i] * win[i]; im[i] = 0; }
      fft(re, im);
      let flux = 0, low = 0;
      const cur = new Float32Array(BINS);
      for (let k = 0; k < BINS; k++) {
        const m = Math.log1p(Math.sqrt(re[k] * re[k] + im[k] * im[k]) * 100);
        cur[k] = m;
        const d = m - prev[k];
        if (d > 0) { flux += d; if (k >= 1 && k <= LOW_BINS) low += d; }
      }
      env[f] = flux;
      envLow[f] = low;
      prev = cur;
    }
    // 减去局部均值，消掉整体响度起伏，只留下起音的尖峰
    const W = 20;
    const detrend = (e) => {
      const out = new Float32Array(frames);
      for (let f = 0; f < frames; f++) {
        let s = 0, c = 0;
        for (let k = Math.max(0, f - W); k < Math.min(frames, f + W); k++) { s += e[k]; c++; }
        out[f] = Math.max(0, e[f] - s / c);
      }
      return out;
    };
    return { env: detrend(env), envLow: detrend(envLow), fps: sr / HOP };
  }

  /* 自相关测速。倍数关系上取「本身与二倍都强」的那个，避免把 160 认成 80 */
  function detectTempo(env, fps, loBpm, hiBpm) {
    const n = env.length;
    const lagOf = (bpm) => Math.round(60 / bpm * fps);
    const minLag = lagOf(hiBpm), maxLag = lagOf(loBpm);
    const ac = new Float64Array(maxLag + 1);
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0; i + lag < n; i++) s += env[i] * env[i + lag];
      ac[lag] = s / (n - lag);
    }
    // 含谐波加权的分数：真实拍速处，其二倍、四倍延迟同样相关，
    // 所以把它们一起算进来，能把峰值稳在真正的拍上
    const scoreAt = (lag) => {
      let sc = ac[lag] || 0;
      if (lag * 2 <= maxLag) sc += 0.6 * ac[lag * 2];
      if (lag * 4 <= maxLag) sc += 0.3 * ac[lag * 4];
      return sc;
    };
    let best = minLag, bestScore = -1;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const sc = scoreAt(lag);
      if (sc > bestScore) { bestScore = sc; best = lag; }
    }
    // 八度歧义：128 与 64 在自相关上同样强，鼓点一低一高时甚至是半速更强。
    // 峰值位置仍由相关性定，只在「自己 / 半速 / 倍速」这一家里用速度先验挑一个，
    // 这样既不会像全局先验那样把 72 拉成 130，也不会随机掉到一半速。
    const prior = (bpm) => {
      const z = Math.log2(bpm / 120) / 0.9;
      return Math.exp(-0.5 * z * z);
    };
    let pick = best, pickScore = -1;
    for (const cand of [best, Math.round(best / 2), best * 2]) {
      if (cand < minLag || cand > maxLag) continue;
      const sc = scoreAt(cand) * prior(60 / (cand / fps));
      if (sc > pickScore) { pickScore = sc; pick = cand; }
    }
    best = pick;
    // 抛物线插值到亚帧精度
    let lag = best;
    if (best > minLag && best < maxLag) {
      const a = ac[best - 1], b = ac[best], c = ac[best + 1];
      const d = a - 2 * b + c;
      if (d !== 0) lag = best + 0.5 * (a - c) / d;
    }
    const bpm = 60 / (lag / fps);
    // 相位：让拍点落在包络能量最大的位置
    const P = lag;
    // 相位只用开头 8 秒：周期哪怕差千分之几，累到后面也会把相位带偏
    const nPhase = Math.min(n, Math.round(8 * fps));
    const score = (p) => {
      let s = 0;
      for (let t = p; t < nPhase; t += P) {
        const i = Math.round(t);
        if (i >= 0 && i < n) s += env[i];
      }
      return s;
    };
    let bestPhase = 0, bestSum = -1;
    for (let p = 0; p < Math.ceil(P); p++) {
      const s = score(p);
      if (s > bestSum) { bestSum = s; bestPhase = p; }
    }
    // 亚帧细化
    const a = score(bestPhase - 1), b = bestSum, c = score(bestPhase + 1);
    const d = a - 2 * b + c;
    let phase = d !== 0 ? bestPhase + 0.5 * (a - c) / d : bestPhase;
    // 谱通量在起音「进入分析窗」时就开始上升，峰值比真实起音早半个窗。
    // 窗长是 4 个 hop，所以补回 2 帧。
    phase += 2;
    let startSec = phase / fps;
    const perSec = P / fps;
    while (startSec < 0) startSec += perSec;
    startSec %= perSec;
    return { bpm, startSec, confidence: bestScore };
  }

  /* 给一个 Promise 套上超时：手机上 decodeAudioData 有时既不 resolve 也不 reject，
     界面就永远停在「正在解码」。超时就当失败，交给下一条路 */
  function withTimeout(p, ms, msg) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(msg)), ms);
      p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
    });
  }

  function decodeWith(ctx, arrayBuf) {
    return new Promise((res, rej) => {
      let done = false;
      const ok = (b) => { if (!done) { done = true; res(b); } };
      const bad = (e) => { if (!done) { done = true; rej(e || new Error('解码失败，换个格式试试')); } };
      try {
        // 老 WebKit 只认回调，新浏览器两种都给；各自复制一份，解码会把传入的 buffer 转移走
        const p = ctx.decodeAudioData(arrayBuf.slice(0), ok, bad);
        if (p && p.then) p.then(ok, bad);
      } catch (e) { bad(e); }
    });
  }

  /* 解码：实时上下文先上，5 秒还没出结果就再用离线上下文并行解一份，谁先好用谁。
     实时上下文在没被用户手势解锁时是 suspended，有的手机浏览器/WebView 上
     decodeAudioData 会就此挂住；OfflineAudioContext 不受自动播放策略管，不会这样。
     等实时那条彻底超时再换，用户得干等半分钟。 */
  function decode(arrayBuf, ctx) {
    const mb = arrayBuf.byteLength / 1048576;
    const limit = 15000 + mb * 1500;           // 30MB 给到 60 秒，慢手机也够
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const errs = [];
    return new Promise((res, rej) => {
      let pending = 0, settled = false;
      const run = (make) => {
        pending++;
        let p;
        try { p = decodeWith(make(), arrayBuf); } catch (e) { p = Promise.reject(e); }
        withTimeout(p, limit, '解码超时').then((b) => {
          if (!settled) { settled = true; clearTimeout(t); res(b); }
        }, (e) => {
          errs.push(e);
          // 实时那条早早失败了（格式不认），不必再等 5 秒
          if (--pending === 0 && !settled) {
            if (!triedOffline && OAC) { clearTimeout(t); startOffline(); return; }
            settled = true;
            rej(new Error(errs.some((x) => /超时/.test(x.message))
              ? '解码超时，这个文件本机解不动，换成 mp3 再试'
              : '解码失败，换个格式（mp3 / m4a / ogg）试试'));
          }
        });
      };
      let triedOffline = false;
      const startOffline = () => {
        if (triedOffline || settled || !OAC) return;
        triedOffline = true;
        run(() => new OAC(2, 1, ctx.sampleRate || 44100));
      };
      const t = setTimeout(startOffline, 5000);
      if (ctx.state !== 'running' && ctx.resume) {
        try { const r = ctx.resume(); if (r && r.catch) r.catch(() => {}); } catch (e) { /* ignore */ }
      }
      run(() => ctx);
    });
  }

  /* 让出一帧，好让「正在…」的提示先画出来，再开始占主线程的计算 */
  const nextFrame = () => new Promise((r) => setTimeout(r, 30));

  /* ---------- 变速检测 ----------
     思路：先做「速度图」——每 1 秒取一个 8 秒窗，算这个窗里每个候选 BPM 的周期性强度；
     再在整张图上用动态规划（Viterbi）找一条「分段恒定」的速度曲线：
     每换一次速度要付一笔固定代价，所以几秒钟的噪声、安静段、鼓点突然变密
     都不值得换，只有持续足够久、证据足够强的变速才会切开。
     比逐窗测速再设阈值稳得多：单窗测错一次（比如偶尔认成半速）根本改不动整条路径。 */
  const TG = {
    WIN: 8,          // 窗长（秒）
    HOP: 1,          // 步长（秒）
    LO: 60, HI: 200, STEP: 0.5,   // 结果只在这个范围里取
    EV_LO: 60, EV_HI: 200,        // 证据网格（放宽到 30~300 试过，没有收益）
    DRIFT: 0.04,     // 相邻格（±0.5 BPM）微调的代价：允许跟住测量抖动，但不鼓励漂
    CHANGE: 2.5,     // 真正换速的代价，约等于「要 5~8 秒明确证据」
    MIN_SEG: 8,      // 短于这么多秒的段并进邻居
  };

  function tempogram(env, fps) {
    const n = env.length;
    const W = Math.min(n, Math.round(TG.WIN * fps)), H = Math.max(1, Math.round(TG.HOP * fps));
    const S = Math.round((TG.EV_HI - TG.EV_LO) / TG.STEP) + 1;
    const bpmOf = (s) => TG.EV_LO + s * TG.STEP;
    const maxLag = Math.min(W - 1, Math.ceil(60 / TG.EV_LO * fps) * 4 + 2);
    const minLag = Math.max(1, Math.floor(60 / TG.EV_HI * fps) - 1);
    const frames = [];
    for (let i0 = 0; i0 + W <= n || (i0 === 0 && n > 0); i0 += H) {
      const ac = new Float64Array(maxLag + 2);
      let energy = 0;
      for (let i = i0; i < i0 + W; i++) energy += env[i];
      for (let L = minLag; L <= maxLag; L++) {
        let sum = 0;
        for (let i = i0; i + L < i0 + W; i++) sum += env[i] * env[i + L];
        ac[L] = sum / (W - L);
      }
      const acAt = (lag) => {                     // 分数延迟线性插值
        if (lag > maxLag) return 0;
        const k = Math.floor(lag), f = lag - k;
        return ac[k] * (1 - f) + ac[k + 1] * f;
      };
      const obs = new Float32Array(S);
      let mx = 0;
      for (let s = 0; s < S; s++) {
        const lag = 60 / bpmOf(s) * fps;
        const v = acAt(lag) + 0.6 * acAt(2 * lag) + 0.3 * acAt(4 * lag);
        obs[s] = v; if (v > mx) mx = v;
      }
      if (mx > 0) for (let s = 0; s < S; s++) obs[s] /= mx;
      frames.push({ t: (i0 + W / 2) / fps, obs, energy });
      if (i0 + W >= n) break;
    }
    // 安静的窗（前奏、间奏、淡出）没有节奏证据：观测抹平，让路径自己从两边延续过来
    const es = frames.map((f) => f.energy).sort((x, y) => x - y);
    const medE = es[Math.floor(es.length / 2)] || 0;
    for (const f of frames) if (f.energy < medE * 0.25) f.obs.fill(0.5);
    return { frames, S, bpmOf };
  }

  function viterbi(tg) {
    const { frames, S, bpmOf } = tg, T = frames.length;
    // 轻微的速度先验，只在八度之间犹豫（64 还是 128）时起作用
    const prior = new Float32Array(S);
    for (let s = 0; s < S; s++) {
      const z = Math.log2(bpmOf(s) / 120) / 0.9;
      prior[s] = 0.15 * Math.exp(-0.5 * z * z);
      // 证据网格比结果范围宽，路径只在结果范围里走
      if (bpmOf(s) < TG.LO || bpmOf(s) > TG.HI) prior[s] = -1e9;
    }
    let dp = new Float64Array(S), nd = new Float64Array(S);
    const back = new Int16Array(T * S);
    for (let s = 0; s < S; s++) dp[s] = frames[0].obs[s] + prior[s];
    for (let t = 1; t < T; t++) {
      let best = -Infinity, bestS = 0;
      for (let s = 0; s < S; s++) if (dp[s] > best) { best = dp[s]; bestS = s; }
      const o = frames[t].obs;
      for (let s = 0; s < S; s++) {
        let v = dp[s], from = s;
        if (s > 0 && dp[s - 1] - TG.DRIFT > v) { v = dp[s - 1] - TG.DRIFT; from = s - 1; }
        if (s < S - 1 && dp[s + 1] - TG.DRIFT > v) { v = dp[s + 1] - TG.DRIFT; from = s + 1; }
        if (best - TG.CHANGE > v) { v = best - TG.CHANGE; from = bestS; }
        nd[s] = v + o[s] + prior[s];
        back[t * S + s] = from;
      }
      const tmp = dp; dp = nd; nd = tmp;
    }
    let s = 0;
    for (let k = 1; k < S; k++) if (dp[k] > dp[s]) s = k;
    const path = new Array(T);
    for (let t = T - 1; t >= 0; t--) { path[t] = bpmOf(s); if (t > 0) s = back[t * S + s]; }
    return path;
  }

  const sameTempo = (a, b, tol) => Math.abs(a - b) <= Math.max(1.5, a * (tol || 0.012));
  const octaveOf = (a, b) => {           // b 是 a 的 2 倍或一半，就把 b 折到 a 的八度上
    for (const k of [2, 0.5]) if (sameTempo(a, b * k, 0.03)) return b * k;
    return null;
  };

  /* 从速度路径切段：同速连成一段；太短的段并进邻居；
     相邻两段正好差一个八度（鼓点加密成倍速）也算同一个速度 */
  function segmentPath(tg, path, duration) {
    const fr = tg.frames, hop = TG.HOP;
    let segs = [];
    for (let t = 0; t < path.length; t++) {
      const cur = segs[segs.length - 1];
      if (cur && sameTempo(cur.ref, path[t])) { cur.to = t; cur.vals.push(path[t]); }
      else segs.push({ from: t, to: t, ref: path[t], vals: [path[t]] });
    }
    const timeOf = (sg, i) => {
      const a = i === 0 ? 0 : fr[sg.from].t - hop / 2;
      const b = i === segs.length - 1 ? duration : fr[sg.to].t + hop / 2;
      return [Math.max(0, a), Math.min(duration, b)];
    };
    const median = (v) => { const x = v.slice().sort((p, q) => p - q); return x[Math.floor(x.length / 2)]; };
    let changed = true;
    while (changed && segs.length > 1) {
      changed = false;
      // 八度关系的相邻段合并，速度以更长的那段为准
      for (let i = 0; i + 1 < segs.length; i++) {
        const A = segs[i], B = segs[i + 1];
        const bIn = octaveOf(median(A.vals), median(B.vals));
        const same = sameTempo(median(A.vals), median(B.vals)) || bIn !== null;
        if (!same) continue;
        const aLong = A.vals.length >= B.vals.length;
        const ref = aLong ? median(A.vals) : median(B.vals);
        const fold = (v) => (sameTempo(ref, v) ? v : (octaveOf(ref, v) || v));
        segs.splice(i, 2, { from: A.from, to: B.to, ref, vals: A.vals.concat(B.vals).map(fold) });
        changed = true; break;
      }
      if (changed) continue;
      // 最短的一段如果太短，并进速度更接近的邻居
      let k = -1, kLen = Infinity;
      segs.forEach((sg, i) => {
        const [a, b] = timeOf(sg, i);
        if (b - a < TG.MIN_SEG && b - a < kLen) { k = i; kLen = b - a; }
      });
      if (k < 0) break;
      const me = median(segs[k].vals);
      const L = segs[k - 1], R = segs[k + 1];
      const dist = (o) => (o ? Math.abs(Math.log2(median(o.vals) / me)) : Infinity);
      const into = dist(L) <= dist(R) ? k - 1 : k + 1;
      const tgt = segs[into];
      const lo = Math.min(k, into);
      segs.splice(lo, 2, {
        from: Math.min(tgt.from, segs[k].from), to: Math.max(tgt.to, segs[k].to),
        // 短段的测量不可信，速度直接沿用邻居的
        ref: tgt.ref, vals: tgt.vals.slice(),
      });
      changed = true;
    }
    return segs.map((sg, i) => {
      const [start, end] = timeOf(sg, i);
      return { start, end, bpm: median(sg.vals) };
    });
  }

  /* 每段的速度单独判：路径只负责「哪里变速」，「到底是多少」看整段的平均速度曲线。
     在平均曲线的所有峰里挑「证据 × 速度先验」最大的——
     不只比半速 / 倍速：有的曲子鼓型每 2.5 拍一循环，路径会停在一个奇怪的周期上。
     先验以 130 为中心、宽约一个八度：音游曲大多在 100~200，
     军鼓两拍一次时半速的周期性往往更强，不加先验会系统性偏慢。 */
  const TEMPO_PRIOR = (bpm) => { const z = Math.log2(bpm / 130) / 0.8; return Math.exp(-0.5 * z * z); };
  function pickTempo(tg, sg) {
    const fr = tg.frames.filter((f) => f.t >= sg.start && f.t <= sg.end);
    const use = fr.length ? fr : tg.frames;
    const S = tg.S, mean = new Float64Array(S);
    for (const f of use) for (let s = 0; s < S; s++) mean[s] += f.obs[s] / use.length;
    // 试过把半速 / 倍速处的证据也加进来（格律一致性），在内置曲目上反而更差（160 被认成 105），
    // 所以只用峰值强度 × 先验
    let best = sg.bpm, bestSc = -1;
    for (let s = 0; s < S; s++) {
      const bpm = tg.bpmOf(s);
      if (bpm < TG.LO || bpm > TG.HI) continue;
      const isPeak = (s === 0 || mean[s] >= mean[s - 1]) && (s === S - 1 || mean[s] >= mean[s + 1]);
      if (!isPeak) continue;
      const sc = mean[s] * TEMPO_PRIOR(bpm);
      if (sc > bestSc) { bestSc = sc; best = bpm; }
    }
    return best;
  }

  /* 分数延迟的自相关：只在需要的几个延迟上算，段再长也不贵 */
  function acFrac(env, i0, i1, lag) {
    const k = Math.floor(lag), f = lag - k;
    const one = (L) => {
      let sum = 0;
      for (let i = i0; i + L < i1; i++) sum += env[i] * env[i + L];
      return sum / Math.max(1, i1 - i0 - L);
    };
    return one(k) * (1 - f) + one(k + 1) * f;
  }

  /* 在 [t0, t1] 这一段里精测。BPM 已知大概时只在它 ±3% 里细扫（0.05 BPM 一档），
     同时看 1~4 倍周期：周期越长，同样的帧误差占比越小，精度来自长延迟。
     相位用整段（最多 30 秒）折叠，比只看开头 8 秒稳。返回第一拍的绝对秒数。 */
  function detectRange(env, fps, t0, t1, bpmHint, envLow) {
    const i0 = Math.max(0, Math.floor(t0 * fps)), i1 = Math.min(env.length, Math.ceil(t1 * fps));
    if (!bpmHint || i1 - i0 < fps * 2) {
      const sub = env.subarray(i0, Math.max(i0 + 8, i1));
      const r = detectTempo(sub, fps, bpmHint ? bpmHint * 0.97 : TG.LO, bpmHint ? bpmHint * 1.03 : TG.HI);
      return { bpm: r.bpm, firstBeat: i0 / fps + r.startSec };
    }
    // 打分用「节拍网格对齐度」：给定周期，把整段按周期折叠，取最佳相位上的平均起音强度。
    // 网格点落在各不相同的小数帧上，帧量化误差被平均掉；
    // 自相关只在整数延迟上最准，会把 120 系统性地拉到 120.19（43 帧）。
    const iEnd = Math.min(i1, i0 + Math.round(240 * fps));
    const at = (x) => { const k = Math.floor(x), f = x - k; return k + 1 < env.length ? env[k] * (1 - f) + env[k + 1] * f : 0; };
    const comb = (P, phStep) => {
      let best = -1, bestPh = 0;
      for (let ph = 0; ph < P; ph += phStep) {
        let sum = 0, n = 0;
        for (let x = i0 + ph; x < iEnd; x += P) { sum += at(x); n++; }
        const v = n ? sum / n : 0;
        if (v > best) { best = v; bestPh = ph; }
      }
      return { v: best, ph: bestPh };
    };
    const scan = (lo, hi, step, phStep) => {
      let bb = lo, bs = -1;
      for (let bpm = lo; bpm <= hi + 1e-9; bpm += step) {
        const r = comb(60 / bpm * fps, phStep);
        if (r.v > bs) { bs = r.v; bb = bpm; }
      }
      return bb;
    };
    // 粗扫 ±3%，再在最优附近细扫
    const coarse = scan(bpmHint * 0.97, bpmHint * 1.03, 0.1, 1);
    const bestBpm = scan(coarse - 0.12, coarse + 0.12, 0.01, 0.5);
    const P = 60 / bestBpm * fps;
    // 相位：全频与低频两条包络各自归一后相加，低频权重更大——拍点跟着底鼓走。
    // 没有低频内容（纯钢琴、弦乐）时低频那条近乎全零，自动退化成只看全频
    let bestPh = comb(P, 0.25).ph;
    if (envLow) {
      const profile = (e) => {
        const prof = [];
        for (let ph = 0; ph < P; ph += 0.25) {
          let sum = 0, n = 0;
          for (let x = i0 + ph; x < iEnd; x += P) {
            const k = Math.floor(x), f = x - k;
            if (k + 1 < e.length) { sum += e[k] * (1 - f) + e[k + 1] * f; n++; }
          }
          prof.push(n ? sum / n : 0);
        }
        const mx = Math.max.apply(null, prof) || 1;
        return prof.map((v) => v / mx);
      };
      const a = profile(env), l = profile(envLow);
      let bi = 0, bv = -1;
      for (let i = 0; i < a.length; i++) { const v = a[i] + 2 * l[i]; if (v > bv) { bv = v; bi = i; } }
      bestPh = bi * 0.25;
    }
    // 谱通量在起音进入分析窗时就开始上升，峰值比真实起音早半个窗（2 帧），补回来
    // 谱通量峰比真实起音早约 2 帧；再往前推到这段里最早的一拍
    let fb = (i0 + bestPh + 2) / fps;
    const beatSec = 60 / bestBpm;
    while (fb - beatSec >= t0 - 0.08) fb -= beatSec;   // 段边界本身有几十毫秒误差
    return { bpm: bestBpm, firstBeat: Math.max(0, fb) };
  }

  /* 用户手动框了一段：在这段里从头测（不参考整首的结果） */
  function analyzeRange(env, envLow, fps, t0, t1) {
    const i0 = Math.max(0, Math.floor(t0 * fps)), i1 = Math.min(env.length, Math.ceil(t1 * fps));
    const sub = env.subarray(i0, i1);
    const tg = tempogram(sub, fps);
    const hint = pickTempo(tg, { start: 0, end: (i1 - i0) / fps, bpm: 120 });
    return detectRange(env, fps, t0, t1, hint, envLow);
  }

  /* 整首分析：速度图 -> 分段 -> 每段精测。返回的段按时间顺序，best 是最长那段的下标 */
  function analyzeTempo(env, fps, duration, envLow) {
    const tg = tempogram(env, fps);
    const path = viterbi(tg);
    const segs = segmentPath(tg, path, duration).map((sg) => {
      const r = detectRange(env, fps, sg.start, sg.end, pickTempo(tg, sg), envLow);
      return { start: sg.start, end: sg.end, bpm: r.bpm, firstBeat: r.firstBeat };
    });
    let best = 0;
    segs.forEach((sg, i) => { if (sg.end - sg.start > segs[best].end - segs[best].start) best = i; });
    return { segments: segs, best, curve: tg.frames.map((f, i) => ({ t: f.t, bpm: path[i] })) };
  }

  /* 上传入口：解码 -> 测速。返回的 bpm/startSec 只是建议值。
     onStage(text) 用来报告进行到哪一步，卡住时至少知道卡在哪 */
  function analyze(arrayBuf, ctx, onStage) {
    const stage = (t) => { if (onStage) onStage(t); };
    stage('正在解码…');
    return decode(arrayBuf, ctx).then((buf) => {
      stage('正在测速…');
      return nextFrame().then(() => {
        const SR = 11025;
        // 整首都分析才看得出中途变速；10 分钟封顶，手机上也就几秒
        const x = toMono(buf, SR, 600);
        const { env, envLow, fps } = onsetEnvelope(x, SR);
        const dur = Math.min(buf.duration, x.length / SR);
        const tm = analyzeTempo(env, fps, dur, envLow);
        if (buf.duration > dur) tm.segments[tm.segments.length - 1].end = buf.duration;
        const b = tm.segments[tm.best];
        return {
          buffer: buf,
          duration: buf.duration,
          env, envLow, fps,
          segments: tm.segments, best: tm.best, curve: tm.curve,
          bpm: Math.round(b.bpm * 10) / 10,
          startSec: Math.round(b.firstBeat * 1000) / 1000,       // 第一拍的绝对位置
          rangeStart: b.start, rangeEnd: b.end,
        };
      });
    });
  }

  /* ---------- 对外 ---------- */
  const urls = {};                       // id -> objectURL，按需创建
  function urlFor(rec) {
    if (!urls[rec.id]) urls[rec.id] = URL.createObjectURL(rec.blob);
    return urls[rec.id];
  }
  /* 存档记录 -> BGM 条目。barDur 用测得的 BPM 直接算，不依赖整数小节长度 */
  function toEntry(rec) {
    const barDur = 4 * 60 / rec.bpm;
    // 截取了范围的只在范围里循环
    const end = rec.endSec > rec.startSec ? Math.min(rec.endSec, rec.duration) : rec.duration;
    const usable = Math.max(barDur, end - rec.startSec);
    return {
      id: 'user_' + rec.id, group: '我的音乐', name: rec.name, kind: 'file',
      baseBpm: rec.bpm, url: urlFor(rec),
      custom: true, startSec: rec.startSec,
      loopBars: Math.max(1, Math.floor(usable / barDur)),
      desc: `自己上传 · ${rec.bpm} BPM`,
    };
  }

  MG.UserBgm = {
    MAX_BYTES,
    analyze,
    decode,
    list: () => listAll().then((rs) => rs.sort((a, b) => a.addedAt - b.addedAt)),
    save: (rec) => putOne(rec),
    remove: (id) => {
      if (urls[id]) { URL.revokeObjectURL(urls[id]); delete urls[id]; }
      return delOne(id);
    },
    toEntry,
    newId: () => 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    // 单元测试用
    detectRange,
    analyzeRange,
    _tempogram: tempogram,
    _fft: fft, _onsetEnvelope: onsetEnvelope, _detectTempo: detectTempo, _analyzeTempo: analyzeTempo,
  };
})(window.MG = window.MG || {});
