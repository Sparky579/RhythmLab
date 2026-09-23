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
    const re = new Float32Array(N), im = new Float32Array(N);
    let prev = new Float32Array(BINS);
    for (let f = 0; f < frames; f++) {
      const off = f * HOP;
      for (let i = 0; i < N; i++) { re[i] = x[off + i] * win[i]; im[i] = 0; }
      fft(re, im);
      let flux = 0;
      const cur = new Float32Array(BINS);
      for (let k = 0; k < BINS; k++) {
        const m = Math.log1p(Math.sqrt(re[k] * re[k] + im[k] * im[k]) * 100);
        cur[k] = m;
        const d = m - prev[k];
        if (d > 0) flux += d;
      }
      env[f] = flux;
      prev = cur;
    }
    // 减去局部均值，消掉整体响度起伏，只留下起音的尖峰
    const W = 20;
    const out = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      let s = 0, c = 0;
      for (let k = Math.max(0, f - W); k < Math.min(frames, f + W); k++) { s += env[k]; c++; }
      out[f] = Math.max(0, env[f] - s / c);
    }
    return { env: out, fps: sr / HOP };
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

  /* 上传入口：解码 -> 测速。返回的 bpm/startSec 只是建议值。
     onStage(text) 用来报告进行到哪一步，卡住时至少知道卡在哪 */
  function analyze(arrayBuf, ctx, onStage) {
    const stage = (t) => { if (onStage) onStage(t); };
    stage('正在解码…');
    return decode(arrayBuf, ctx).then((buf) => {
      stage('正在测速…');
      return nextFrame().then(() => {
        const SR = 11025;
        // 只分析前 60 秒，够测速了，手机上也不至于卡太久
        const x = toMono(buf, SR, 60);
        const { env, fps } = onsetEnvelope(x, SR);
        const t = detectTempo(env, fps, 60, 200);
        return {
          buffer: buf,
          duration: buf.duration,
          bpm: Math.round(t.bpm * 10) / 10,
          startSec: Math.round(t.startSec * 1000) / 1000,
          confidence: t.confidence,
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
    const usable = Math.max(barDur, rec.duration - rec.startSec);
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
    _fft: fft, _onsetEnvelope: onsetEnvelope, _detectTempo: detectTempo,
  };
})(window.MG = window.MG || {});
