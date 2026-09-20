/* UI：设置面板、预览、游戏页与结果 */
(function (MG) {
  'use strict';
  const G = MG.Generator;
  const $ = (id) => document.getElementById(id);
  const BUILD = '31';
  MG.BUILD = BUILD;                 // 供页面末尾的版本自检使用
  /* 版本号直接印在标题下面：装没装上新版一眼就能看出来 */
  document.addEventListener('DOMContentLoaded', () => {
    const t = document.getElementById('buildTag');
    if (t) t.textContent = 'v' + BUILD + (/RhythmLabShell/.test(navigator.userAgent) ? ' App' : '');
  });
  const STORE_KEY = 'rhythmlab_v2';
  const GROUPS = { trill: '交互', stream: '切', jack: '叠' };

  const state = {
    group: 'trill',
    preset: 'trill_basic',
    keys: 4,
    bpm: 160,
    measures: 16,
    seed: 'demo',
    restRatio: 0,
    challenge: false,
    bpmEnd: 200,
    rampMeasures: 4,
    rampStep: 5,
    shiftAmount: 0.5,
    axisHand: 'left',
    axisStyle: 'tri',
    mixedPool: G.FANCY_KEYS.slice(),
    fancyRatio: 0.35,
    game: Object.assign({}, MG.GAME_DEFAULTS),
  };

  function loadState() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (s && typeof s === 'object') {
        Object.assign(state, s, { game: Object.assign({}, MG.GAME_DEFAULTS, s.game || {}) });
        if (!Array.isArray(state.mixedPool) || !state.mixedPool.length) state.mixedPool = G.FANCY_KEYS.slice();
        state.mixedPool = state.mixedPool.filter(k => G.FANCY_KEYS.indexOf(k) >= 0);
        if (!state.mixedPool.length) state.mixedPool = G.FANCY_KEYS.slice();
      }
    } catch (e) { /* ignore */ }
    const GROUP_IDS = ['trill', 'stream', 'jack', 'chaos'];
    if (GROUP_IDS.indexOf(state.group) < 0) state.group = 'trill';
    const okPreset = state.group === 'chaos'
      ? (state.preset === 'mixed' || (G.PRESETS[state.preset] && G.PRESETS[state.preset].group === 'chaos'))
      : (G.PRESETS[state.preset] && G.PRESETS[state.preset].group === state.group);
    if (!okPreset) {
      state.preset = state.group === 'chaos'
        ? 'rand_low'
        : (G.PRESET_KEYS.find(k => G.PRESETS[k].group === state.group) || 'trill_basic');
    }
    if (G.KEY_OPTIONS.indexOf(state.keys) < 0) state.keys = 4;
  }
  function saveState() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  const audio = new MG.AudioEngine();
  const game = new MG.Game($('game'), audio);
  // 原生壳（安卓 App）通过它把 MotionEvent 直接喂进来
  MG.nativeTouch = (type, id, x, age) => game.nativeTouch(type, id, x, age);
  let chart = null;
  let previewTimer = 0;

  const isMixed = () => state.preset === 'mixed';
  let scrollSave = 0;
  function exitFullscreen() {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) return;
    const fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (!fn) return;
    try { const r = fn.call(document); if (r && r.catch) r.catch(() => {}); } catch (e) { /* ignore */ }
  }

  function lockScroll(on) {
    if (on) { scrollSave = window.scrollY || 0; document.body.classList.add('playing'); }
    else { document.body.classList.remove('playing'); window.scrollTo(0, scrollSave); }
  }

  /* ---------- 预设卡片 ---------- */
  function renderPresets() {
    const grid = $('presetGrid');
    grid.innerHTML = '';
    const keys = state.group === 'chaos'
      ? G.PRESET_KEYS.filter(k => G.PRESETS[k].group === 'chaos').concat(['mixed'])
      : G.PRESET_KEYS.filter(k => G.PRESETS[k].group === state.group);
    for (const key of keys) {
      const p = key === 'mixed'
        ? { name: '散打', desc: '以乱为底，按比例插入交互 / 切 / 叠的花样乐句' }
        : G.PRESETS[key];
      const b = document.createElement('button');
      b.className = 'preset' + (state.preset === key ? ' active' : '');
      b.innerHTML = `<b>${p.name}</b><small>${p.desc}</small>`;
      b.addEventListener('click', () => {
        state.preset = key;
        renderPresets(); syncSubopts(); refresh();
      });
      grid.appendChild(b);
    }
    document.querySelectorAll('#groupTabs .tab').forEach(t => t.classList.toggle('active', t.dataset.group === state.group));
  }

  function renderMixedPool() {
    const box = $('mixedPool');
    box.innerHTML = '';
    for (const g of Object.keys(GROUPS)) {
      const h = document.createElement('div');
      h.className = 'grp'; h.textContent = GROUPS[g];
      box.appendChild(h);
      for (const key of G.FANCY_KEYS) {
        if (G.PRESETS[key].group !== g) continue;
        const lab = document.createElement('label');
        lab.innerHTML = `<input type="checkbox" ${state.mixedPool.indexOf(key) >= 0 ? 'checked' : ''}/> ${G.PRESETS[key].name}`;
        lab.querySelector('input').addEventListener('change', (e) => {
          if (e.target.checked) { if (state.mixedPool.indexOf(key) < 0) state.mixedPool.push(key); }
          else state.mixedPool = state.mixedPool.filter(k => k !== key);
          refresh();
        });
        box.appendChild(lab);
      }
    }
  }

  function syncSubopts() {
    const mixed = isMixed();
    const p = mixed ? null : G.PRESETS[state.preset];
    const trillShown = (p && p.kind === 'trill') || (mixed && state.mixedPool.some(k => G.PRESETS[k].kind === 'trill'));
    $('optTrill').classList.toggle('hidden', !trillShown);
    $('axisOpts').classList.toggle('hidden', !(mixed ? state.mixedPool.indexOf('trill_axis') >= 0 : state.preset === 'trill_axis'));
    $('optMixed').classList.toggle('hidden', !mixed);
    if (mixed) renderMixedPool();

    const K = state.keys;
    const labels = MG.KEYMAP[K].labels.join(' ');
    $('keysHint').textContent = K === 4
      ? '4 轨，键盘 D F J K。交互类也可用，两手位置会映射到最近的轨道。'
      : '7 轨，键盘 S D F 空格 J K L。中间那轨是拇指，会用紫色区分。';
    $('keyHelp').textContent = `桌面用 ${labels} 击打，或鼠标点击轨道；手机直接点轨道。Esc 暂停。`;

    const ch = state.challenge;
    $('optChallenge').classList.toggle('hidden', !ch);
    $('measures').disabled = ch;          // 挑战模式的小节数由爬升区间推出来
    setMeasuresDisplay(ch);
    const bpmLabel = $('bpmOut').parentElement;
    if (bpmLabel) bpmLabel.firstChild.nodeValue = ch ? '起始 BPM ' : 'BPM ';
  }

  /* 挑战模式下小节数是算出来的，用一个临时选项把真实值显示出来 */
  function setMeasuresDisplay(auto) {
    const sel = $('measures');
    if (!sel) return;
    let opt = sel.querySelector('option[value="auto"]');
    if (auto) {
      const n = G.challengeMeasures(G.normalizeOpts(genOpts()));
      if (!opt) {
        opt = document.createElement('option');
        opt.value = 'auto';
        sel.appendChild(opt);
      }
      opt.textContent = n + ' 小节（自动）';
      sel.value = 'auto';
    } else {
      if (opt) opt.remove();
      sel.value = String(state.measures);
    }
  }

  let setBpm = () => {};
  /* 只在用户主动点「对齐」时才动 BPM，平时绝不改动 */
  function snapBpmToBgm() {
    const g = MG.BGM_BY_ID[state.game.bgm];
    if (!g || !g.baseBpm) return false;
    const v = MG.bgmSnapBpm(state.bpm, g.baseBpm);
    if (v === state.bpm) return false;
    setBpm(v);
    return true;
  }
  /* BGM 提示：告诉用户这条 groove 的原速和几个合适的 BPM */
  function syncBgmHint() {
    const el = $('bgmHint');
    if (!el) return;
    const g = MG.BGM_BY_ID[state.game.bgm];
    if (!g) { el.textContent = ''; return; }
    if (!g.baseBpm) { el.textContent = g.desc + '。'; return; }
    const list = MG.bgmSuggestBpms(g.baseBpm).join(' / ');
    const ratio = MG.bgmTempoRatio(state.bpm, g.baseBpm);
    const rate = state.bpm / (g.baseBpm * ratio);
    const fit = Math.abs(rate - 1) < 0.005;
    let html = `${g.desc}。原速 ${g.baseBpm}，整倍速的 BPM：${list}。`;
    // BPM 随便设，音乐按倍速跟着走；这里把实际倍速说清楚
    html += fit
      ? ' 当前正好是整倍速。'
      : ` 当前 ${state.bpm} BPM，音乐按 <b>${rate.toFixed(2)} 倍速</b>跟着走`
        + ` <button type="button" id="bgmAlign" class="link">对齐到整倍速</button>`;
    if (state.challenge) html += ' 挑战模式下会跟着一起持续加速（音高随之升高）。';
    if (g.credit) {
      html += `<br><a href="${g.creditUrl}" target="_blank" rel="noopener" style="color:var(--accent)">${g.credit}</a>`;
    }
    el.innerHTML = html;
    const btn = $('bgmAlign');
    if (btn) btn.addEventListener('click', () => { snapBpmToBgm(); });
  }

  /* 判定与下落速度的说明 */
  function syncJudgeHint() {
    const el = $('judgeHint');
    if (!el) return;
    const g = state.game;
    const ms = Math.round(MG.JUDGE.BASE_APPROACH_MS / Math.max(0.1, g.speed));
    el.textContent = `PERFECT 计 100 分、GREAT 计 50 分、超出 GREAT 即 Miss。`
      + `默认 ${MG.JUDGE.PERFECT_MS} / ${MG.JUDGE.GREAT_MS} ms。`
      + `当前下落速度 ${(+g.speed).toFixed(1)} 倍，音符提前 ${ms} 毫秒出现。`;
  }

  function setSeg(id, v) {
    document.querySelectorAll(`#${id} button`).forEach(b => b.classList.toggle('active', b.dataset.v === String(v)));
  }
  function bindSeg(id, onChange) {
    document.querySelectorAll(`#${id} button`).forEach(b => b.addEventListener('click', () => {
      if (b.disabled) return;
      setSeg(id, b.dataset.v);
      onChange(b.dataset.v);
    }));
  }

  /* ---------- 生成 + 预览 ---------- */
  function genOpts() {
    return {
      preset: state.preset, keys: state.keys, bpm: state.bpm, seed: state.seed,
      measures: state.measures, restRatio: state.restRatio,
      challenge: state.challenge, bpmEnd: state.bpmEnd,
      rampMeasures: state.rampMeasures, rampStep: state.rampStep,
      shiftAmount: state.shiftAmount, axisHand: state.axisHand, axisStyle: state.axisStyle,
      mixedPool: state.mixedPool, fancyRatio: state.fancyRatio,
    };
  }

  function refresh() {
    saveState();
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      try {
        chart = G.generate(genOpts());
      } catch (err) {
        $('warnings').textContent = '谱面生成失败：' + err.message;
        return;
      }
      drawPreview(chart);
      const secs = chart.duration;
      const rowMs = (chart.beat / G.MAIN_DIV * 1000).toFixed(0);
      $('stats').innerHTML =
        `<span>音符数</span><b>${chart.notes.length}</b>` +
        `<span>时长</span><b>${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, '0')}</b>` +
        `<span>平均密度</span><b>${(chart.notes.length / secs).toFixed(1)} /s</b>` +
        (chart.challenge
          ? `<span>BPM 爬升</span><b>${chart.bpmStart} → ${chart.bpmEnd}</b>`
          : `<span>16 分间隔</span><b>${rowMs} ms</b>`) +
        `<span>种子码</span><b>${chart.seedHash.toString(16)}</b>`;
      $('warnings').textContent = chart.warnings.join('；');
      if (state.challenge) setMeasuresDisplay(true);
      const endBpm = chart.challenge ? chart.bpmEnd : state.bpm;
      $('bpmHint').textContent = chart.challenge
        ? `起步每秒 ${(state.bpm / 60 * 4).toFixed(1)} 行，冲到 ${endBpm} 时每秒 ${(endBpm / 60 * 4).toFixed(1)} 行。`
        : `主段 16 分音 = 每秒 ${(state.bpm / 60 * 4).toFixed(1)} 行，休息段 8 分音。难度只由 BPM 决定。`;
      if (chart.challenge) {
        const grades = Math.floor((chart.measures - 1) / state.rampMeasures) + 1;
        let txt = `${chart.bpmStart} → ${chart.bpmEnd} BPM，每 ${state.rampMeasures} 小节 +${state.rampStep}，`
          + `共 ${grades} 档 / ${chart.measures} 小节，约 ${Math.floor(chart.duration / 60)}:`
          + String(Math.round(chart.duration % 60)).padStart(2, '0') + '。';
        if (chart.bpmEnd !== state.bpmEnd) {
          txt += ` 受 ${G.MAX_MEASURES} 小节上限限制，实际只爬到 ${chart.bpmEnd}。`;
        }
        $('challengeHint').textContent = txt;
      }
      const period = G.restPeriodOf(state.restRatio);
      $('restHint').textContent = period
        ? `每 ${period} 小节休息 1 小节（实际 ${(100 / period).toFixed(0)}%），休息段只有 8 分音单键。`
        : '不插入休息段，全程 16 分音。';
    }, 60);
  }

  function drawPreview(ch) {
    const cv = $('preview');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = cv.clientWidth || 300, chh = cv.clientHeight || 360;
    cv.width = cw * dpr; cv.height = chh * dpr;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#080a12'; g.fillRect(0, 0, cw, chh);

    const K = ch.keys, span = ch.beat * 16, pad = 10;
    const yOf = (t) => chh - pad - (t / span) * (chh - pad * 2);
    const lw = cw / K;

    // 休息小节底色
    if (ch.restPeriod) {
      g.fillStyle = 'rgba(122,162,255,0.10)';
      for (let m = 0; m < 4; m++) {
        if ((m + 1) % ch.restPeriod !== 0) continue;
        const y1 = yOf((m + 1) * 4 * ch.beat), y2 = yOf(m * 4 * ch.beat);
        g.fillRect(0, y1, cw, y2 - y1);
      }
    }
    for (let b = 0; b <= 16; b++) {
      g.strokeStyle = b % 4 === 0 ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.05)';
      g.beginPath(); g.moveTo(0, yOf(b * ch.beat)); g.lineTo(cw, yOf(b * ch.beat)); g.stroke();
    }
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    for (let i = 1; i < K; i++) { g.beginPath(); g.moveTo(lw * i, 0); g.lineTo(lw * i, chh); g.stroke(); }

    g.font = '11px system-ui, sans-serif';
    g.fillStyle = 'rgba(255,255,255,0.5)';
    g.textBaseline = 'top';
    for (const p of ch.phrases) {
      const t = p.startMeasure * 4 * ch.beat;
      if (t >= span) break;
      const y = yOf(t + p.measures * 4 * ch.beat) + 4;
      const w = g.measureText(p.name).width + 8;
      g.fillStyle = 'rgba(8,10,18,0.85)';
      g.fillRect(4, y - 1, w, 14);
      g.fillStyle = 'rgba(255,255,255,0.6)';
      g.fillText(p.name, 8, y);
    }
    const h = Math.max(3, Math.min(7, lw * 0.32));
    for (const n of ch.notes) {
      if (n.t >= span) break;
      g.fillStyle = (K === 7 && n.col === 3) ? MG.JUDGE.THUMB_COLOR : MG.JUDGE.HAND_COLORS[n.hand];
      g.fillRect(n.col * lw + 2, yOf(n.t) - h / 2, lw - 4, h);
    }
  }

  /* ---------- 开始 / 结果 ---------- */
  async function startGame() {
    if (!chart) chart = G.generate(genOpts());
    // 个别浏览器的 AudioContext.resume() 可能永不 resolve，超时后照常开始
    await Promise.race([
      audio.unlock().catch(() => {}),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
    // 录音型 BGM 要先解码好，否则这一局会静音
    const bg = MG.BGM_BY_ID[state.game.bgm];
    if (bg && bg.kind === 'file') {
      await Promise.race([
        audio.loadFile(bg.url).catch(() => {}),
        new Promise((r) => setTimeout(r, 8000)),
      ]);
    }
    Object.assign(game.settings, state.game);
    $('setup').classList.add('hidden');
    $('play').classList.remove('hidden');
    lockScroll(true);
    // 全屏能挡掉浏览器自身的下拉刷新、地址栏伸缩等手势；需要借用户手势，这里正好是点了开始
    if (state.game.autoFullscreen && !document.fullscreenElement) {
      const el = document.documentElement;
      const fn = el.requestFullscreen || el.webkitRequestFullscreen;
      if (fn) { try { const r = fn.call(el); if (r && r.catch) r.catch(() => {}); } catch (e) { /* 忽略 */ } }
    }
    $('resultOverlay').classList.add('hidden');
    $('pauseOverlay').classList.add('hidden');
    game.load(chart);
    game.resize();
    game.start();
  }
  function backToSetup() {
    game.stop();
    exitFullscreen();
    lockScroll(false);
    $('play').classList.add('hidden');
    $('setup').classList.remove('hidden');
    refresh();
  }
  function showResult(res) {
    exitFullscreen();          // 一局打完就退出全屏，方便看结果和改设置
    $('resultOverlay').classList.remove('hidden');
    $('resTitle').textContent = res.chart.challenge
      ? `${res.chart.presetName} · ${res.chart.keys}K · ${res.chart.bpmStart} → ${res.chart.bpmEnd} BPM`
      : `${res.chart.presetName} · ${res.chart.keys}K · ${res.chart.bpm} BPM`;
    $('resScore').textContent = String(res.score).padStart(7, '0');
    $('resAcc').textContent = (res.accuracy * 100).toFixed(2) + '%';
    $('resP').textContent = res.counts[0];
    $('resG').textContent = res.counts[1];
    $('resM').textContent = res.counts[2];
    const mean = res.meanOffset;
    $('resMeta').innerHTML =
      `最大连击 <b>${res.maxCombo}</b> / ${res.total}` +
      (res.emptyMiss ? ` · 空打 ${res.emptyMiss}` : '') +
      `<br>平均偏差 <b>${mean >= 0 ? '+' : ''}${mean.toFixed(1)} ms</b>（${mean >= 0 ? '偏晚' : '偏早'}）· 标准差 ${res.stdOffset.toFixed(1)} ms` +
      `<br>提前 ${res.early} · 延后 ${res.late} · 判定 ${res.perfectMs}/${res.greatMs} ms · 种子码 ${res.chart.seedHash.toString(16)}` +
      (res.autoplay ? '<br>自动演奏' : inputLine(res)) +
      calibLine(res) +
      challengeLine(res);
    const dg = $('btnDiag');
    if (dg) dg.onclick = () => {
      const txt = diagText(res);
      const done = () => { dg.textContent = '已复制，直接粘贴发出即可'; };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(done, () => showDiagBox(txt));
      } else showDiagBox(txt);
    };
    const cb = $('btnCalib');
    if (cb) cb.addEventListener('click', () => {
      const want = res.suggestOffset;
      state.game.offsetMs = want;
      Object.assign(game.settings, state.game);
      const el = $('offsetMs');
      if (el) { el.value = want; $('offsetOut').textContent = (want > 0 ? '+' : '') + want + ' ms'; }
      saveState();
      cb.outerHTML = `<span style="color:#5ee8b0">判定偏移已设为 ${want} ms</span>`;
    });
    drawResultChart(res);
  }
  /* 输入诊断：命中数一定不会多于输入次数，否则就是触摸事件没送到页面 */
  function inputLine(res) {
    const hits = res.counts[0] + res.counts[1];
    let line = `<br>击打输入 <b>${res.taps}</b> 次 · 命中 ${hits} · 打空 ${res.emptyTaps}`;
    if (res.assistHits) line += ` · 边缘容错救回 ${res.assistHits}`;
    if (res.stateDrops) line += ` · 暂停期丢弃 ${res.stateDrops}`;
    const warn = [];
    if (res.blackouts && res.blackouts.length) {
      const b = res.blackouts;
      const total = Math.round(b.reduce((a, x) => a + x.ms, 0) / 100) / 10;
      warn.push(`检测到 ${b.length} 段连续打空（共 ${total} 秒、${b.reduce((a, x) => a + x.taps, 0)} 次触摸没打中任何音符），`
        + `最长一段 ${(Math.max.apply(null, b.map((x) => x.ms)) / 1000).toFixed(1)} 秒`);
    }
    // 原始事件空档：浏览器有没有连续一段时间不派发触摸事件。
    // 这一项最关键——它能把「事件没来」和「事件来了但判定/渲染出问题」彻底分开。
    if (res.rawGaps && res.rawGaps.length) {
      const worst = Math.max.apply(null, res.rawGaps.map((x) => x[1]));
      warn.push(`浏览器有 ${res.rawGaps.length} 段完全没有派发任何触摸事件（最长 ${worst}ms）。`
        + `这期间页面本身在正常跑，是事件根本没送进来`);
    }
    if (res.raw) {
      const r = res.raw;
      warn.push(`原始事件计数 按下${r.ts} 移动${r.tm} 抬起${r.te} 取消${r.tc}`
        + (r.tc > 0 ? '（有 touchcancel：系统或浏览器中途接管了手势）' : '')
        + (r.skipped > 0 ? ` 被过滤${r.skipped}` : ''));
    }
    if (res.inputGaps && res.inputGaps.length) {
      const worst = Math.max.apply(null, res.inputGaps.map((x) => x.ms));
      warn.push(`有 ${res.inputGaps.length} 段完全收不到输入（最长 ${worst}ms）`
        + (res.stalls && res.stalls.length ? '，同期有画面卡顿，多半是性能问题'
          : '，同期画面没有卡顿，说明触摸是在页面之外被丢掉的'));
    }
    if (res.presentStalls && res.presentStalls.length) {
      const worst = Math.max.apply(null, res.presentStalls.map((x) => x[1]));
      warn.push(`画面送显滞后 ${res.presentStalls.length} 次，最长 ${worst}ms`
        + `（JS 在正常跑但帧没能按时上屏，属于显示层问题，可试着关掉「低延迟画布」或降低渲染分辨率）`);
    }
    if (res.stalls && res.stalls.length) {
      const worst = Math.max.apply(null, res.stalls.map((x) => x[1]));
      // 把卡顿归因说清楚：是我的代码慢，还是浏览器/系统在我代码之外卡住
      const inMine = res.maxFrameDur || 0, outside = res.maxOutside || 0;
      const blame = outside > inMine * 2
        ? `其中最长 ${outside}ms 花在本程序代码之外（GC / 浏览器 / 系统），不是渲染或判定慢`
        : `本程序单帧最长 ${inMine}ms`;
      const s0 = res.stalls[res.stalls.length - 1] || [];
      const h = res.frameHist || [0, 0, 0, 0, 0];
      const runTxt = res.worstRunMs >= 400
        ? `连续掉帧最长 ${(res.worstRunMs / 1000).toFixed(1)} 秒（${res.worstRunFrames} 帧接连变慢，不是某一帧卡住）。`
        : '';
      warn.push(`本局画面卡顿 ${res.stalls.length} 次，最长一帧 ${worst}ms。${runTxt}${blame}。`
        + `帧分布 顺畅${h[0]} / 略慢${h[1]} / 卡${h[2] + h[3] + h[4]}。`
        + `最近一次拆分：绘制 ${s0[5] || 0}ms / 音频 ${s0[3] || 0}ms / 逻辑 ${s0[4] || 0}ms`
        + `（视口变化 ${res.resizeCount} 次 / 画布重建 ${res.canvasAllocs} 次）`
        + `（卡顿期间安卓会直接丢掉排队的触摸，这就是「一段完全点不上、面板数字也不动」的来源）`);
    }
    if (res.taps < hits) warn.push('输入次数少于命中数：有触摸事件没送到页面');
    if (res.tsAnomalies) {
      warn.push(`检测到 ${res.tsAnomalies} 次事件时间戳基准异常，已自动改用系统时钟`);
    }
    const missRate = res.total ? res.counts[2] / res.total : 0;
    if (missRate > 0.25 && res.emptyTaps > hits * 0.3) {
      warn.push('打空比例偏高：多半是落点压在轨道边线上，可把「触摸边缘容错」打开或换 4K');
    }
    if (warn.length) line += '<br><span style="color:#ffb86b">' + warn.join('；') + '</span>';
    return line;
  }

  /* 挑战摘要：准确率跌破阈值前守住的最高 BPM，一眼看出在哪一档崩 */
  function challengeLine(res) {
    const segs = res.segments;
    if (!segs || !segs.length) return '';
    const held = (th) => {
      let best = null;
      for (const s2 of segs) { if (s2.acc >= th) best = s2.bpm; else break; }
      return best;
    };
    const h95 = held(0.95), h90 = held(0.90);
    let line = `<br>挑战 <b>${res.chart.bpmStart} → ${res.chart.bpmEnd}</b> BPM`;
    line += `<br>95% 线守到 <b>${h95 === null ? '未达成' : h95 + ' BPM'}</b>`
         + ` · 90% 线守到 <b>${h90 === null ? '未达成' : h90 + ' BPM'}</b>`;
    const worst = segs.reduce((a, b) => (b.acc < a.acc ? b : a), segs[0]);
    line += `<br>最差一档 ${worst.bpm} BPM（${(worst.acc * 100).toFixed(1)}%）`;
    return line;
  }

  /* 判定偏移校准：系统性偏早/偏晚会让一半击打落到窗口外，看着就像随机断触 */
  function calibLine(res) {
    if (res.autoplay || res.suggestOffset === null || res.suggestOffset === undefined) return '';
    const cur = state.game.offsetMs, want = res.suggestOffset, delta = want - cur;
    if (Math.abs(delta) < 8) return '<br>判定偏移已经对准，无需调整。';
    if (state.game.autoCalibrate) {
      state.game.offsetMs = want;
      Object.assign(game.settings, state.game);
      const el = $('offsetMs');
      if (el) { el.value = want; $('offsetOut').textContent = (want > 0 ? '+' : '') + want + ' ms'; }
      saveState();
      return `<br><span style="color:#5ee8b0">判定偏移已自动从 ${cur} 调到 ${want} ms（你平均偏${delta > 0 ? '早' : '晚'} ${Math.abs(delta)}ms）</span>`;
    }
    return `<br>本局平均偏${delta > 0 ? '早' : '晚'} ${Math.abs(delta)}ms，`
      + `<button type="button" id="btnCalib" class="link">要的话点这里把判定偏移调到 ${want} ms</button>`;
  }

  /* 把本局所有诊断数字拼成一段纯文本，方便直接发出来，不用人工抄 */
  function diagText(res) {
    const c = res.chart, r = res.raw || {};
    const h = res.frameHist || [];
    return [
      `RhythmLab 诊断 v${BUILD}`,
      `谱面 ${c.presetName} ${c.keys}K ${c.bpm}BPM 音符${res.total} 时长${Math.round(c.duration)}s`,
      `判定 ${res.perfectMs}/${res.greatMs}ms 偏移${state.game.offsetMs}ms 余量${state.game.laneSlackPx}px`,
      `画质 dpr上限${state.game.maxDpr} 实际${res.dpr}${res.autoDprCap ? '(自动降档)' : ''} 极简${state.game.minimalFx ? '开' : '关'} 低延迟画布${res.lowLatency ? '开' : '关'}`,
      `音频 BGM=${state.game.bgm} 打击音${state.game.hitSound ? '开' : '关'}`,
      `成绩 P${res.counts[0]} G${res.counts[1]} M${res.counts[2]} 连击${res.maxCombo}`,
      `输入 触摸${res.taps} 命中${res.counts[0] + res.counts[1]} 打空${res.emptyTaps} 容错救回${res.assistHits} 暂停丢弃${res.stateDrops}`,
      `原始事件 按下${r.ts || 0} 移动${r.tm || 0} 抬起${r.te || 0} 取消${r.tc || 0} 指针${r.pd || 0} 被过滤${r.skipped || 0} 最多${res.maxFingers || 0}指`,
      `原始空档 ${(res.rawGaps || []).map((x) => x[1] + 'ms').join(' ') || '无'}`,
      `输入空档 ${(res.inputGaps || []).map((x) => x.ms + 'ms').join(' ') || '无'}`,
      `帧 卡顿${(res.stalls || []).length}次 最长${res.maxGap || 0}ms 我的代码${res.maxFrameDur}ms 代码之外${res.maxOutside}ms`,
      `连续掉帧 ${(res.worstRunMs / 1000).toFixed(1)}s/${res.worstRunFrames}帧 分布 ${h.join('/')}`,
      `送显滞后 ${(res.presentStalls || []).length}次 最长${res.maxRafLag}ms`,
      `视口 ${res.resizeCount}次 画布重建${res.canvasAllocs}次 时钟偏移${res.clockDelta === null ? '-' : Math.round(res.clockDelta)}ms 时间戳异常${res.tsAnomalies}`,
      `环境 ${navigator.userAgent}`,
    ].join('\n');
  }

  /* 剪贴板不可用时，退回到一个可全选的文本框 */
  function showDiagBox(txt) {
    let box = $('diagBox');
    if (!box) {
      box = document.createElement('textarea');
      box.id = 'diagBox';
      box.readOnly = true;
      box.style.cssText = 'width:100%;height:120px;margin-top:8px;background:rgba(0,0,0,.35);'
        + 'color:var(--text);border:1px solid var(--panel-border);border-radius:8px;padding:8px;font-size:11px';
      $('resMeta').parentElement.insertBefore(box, $('resChart'));
    }
    box.value = txt;
    box.select();
  }

  function drawResultChart(res) {
    const cv = $('resChart');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = cv.clientWidth || 320, chh = 90;
    cv.width = cw * dpr; cv.height = chh * dpr;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, chh);
    const mid = chh / 2;
    g.fillStyle = 'rgba(94,232,176,0.12)'; g.fillRect(0, mid - 40, cw, 80);
    const pr = Math.max(0.05, Math.min(1, (res.perfectMs || MG.JUDGE.PERFECT_MS) / (res.greatMs || MG.JUDGE.GREAT_MS)));
    g.fillStyle = 'rgba(255,215,94,0.15)'; g.fillRect(0, mid - 40 * pr, cw, 80 * pr);
    g.strokeStyle = 'rgba(255,255,255,0.4)';
    g.beginPath(); g.moveTo(0, mid); g.lineTo(cw, mid); g.stroke();
    const notes = res.chart.notes, dur = res.chart.duration;
    for (let i = 0; i < notes.length; i++) {
      const x = notes[i].t / dur * cw;
      if (game.status[i] === 2) { g.fillStyle = MG.JUDGE.COLORS[2]; g.fillRect(x - 1, 2, 2, 8); continue; }
      if (game.status[i] !== 1) continue;
      const y = mid + (game.offset[i] / (res.greatMs || MG.JUDGE.GREAT_MS)) * 40;
      g.fillStyle = MG.JUDGE.COLORS[game.judge[i]];
      g.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
    g.font = '10px system-ui'; g.fillStyle = 'rgba(255,255,255,0.4)';
    g.textBaseline = 'top'; g.fillText('EARLY', 4, 4);
    g.textBaseline = 'bottom'; g.fillText('LATE', 4, chh - 4);
  }

  /* ---------- 绑定 ---------- */
  function initControls() {
    document.querySelectorAll('#groupTabs .tab').forEach(t => t.addEventListener('click', () => {
      state.group = t.dataset.group;
      const inGroup = state.group === 'chaos'
        ? (state.preset === 'mixed' || (G.PRESETS[state.preset] && G.PRESETS[state.preset].group === 'chaos'))
        : (G.PRESETS[state.preset] && G.PRESETS[state.preset].group === state.group);
      if (!inGroup) {
        state.preset = state.group === 'chaos'
          ? 'rand_low'
          : G.PRESET_KEYS.find(k => G.PRESETS[k].group === state.group);
      }
      renderPresets(); syncSubopts(); refresh();
    }));

    const bindRange = (id, outId, key, fmt, target) => {
      const el = $(id), out = $(outId);
      if (!el || !out) return;            // 控件缺失（多半是缓存错配）时跳过，别把整页搞挂
      const obj = () => (target === 'game' ? state.game : state);
      el.value = obj()[key];
      const upd = () => { out.textContent = fmt(+el.value); };
      upd();
      el.addEventListener('input', () => {
        obj()[key] = +el.value;
        upd();
        if (target === 'game') {
          // GREAT 不能比 PERFECT 还窄
          if (key === 'perfectMs' && state.game.greatMs < state.game.perfectMs) {
            state.game.greatMs = state.game.perfectMs;
            const ge = $('greatMs'); if (ge) { ge.value = state.game.greatMs; $('greatMsOut').textContent = ge.value + ' ms'; }
          }
          if (key === 'greatMs' && state.game.greatMs < state.game.perfectMs) {
            state.game.perfectMs = state.game.greatMs;
            const pe = $('perfectMs'); if (pe) { pe.value = state.game.perfectMs; $('perfectMsOut').textContent = pe.value + ' ms'; }
          }
          Object.assign(game.settings, state.game);
          syncJudgeHint();
          if (key === 'bgmVolume') audio.setBgmVolume(state.game.bgmVolume);
          if (key === 'volume') audio.setVolume(state.game.volume);
          if (key === 'edgeMargin' || key === 'maxDpr') game.resize();
          saveState();
        }
        else refresh();
      });
    };
    bindRange('shiftAmount', 'shiftAmountOut', 'shiftAmount', v => Math.round(v * 100) + '%');
    bindRange('fancyRatio', 'fancyRatioOut', 'fancyRatio', v => Math.round(v * 100) + '%');
    bindRange('restRatio', 'restOut', 'restRatio', v => Math.round(v * 100) + '%');
    bindRange('rampMeasures', 'rampMeasuresOut', 'rampMeasures', v => v + ' 小节');
    bindRange('speed', 'speedOut', 'speed', v => v.toFixed(1) + ' 倍', 'game');
    bindRange('perfectMs', 'perfectMsOut', 'perfectMs', v => v + ' ms', 'game');
    bindRange('greatMs', 'greatMsOut', 'greatMs', v => v + ' ms', 'game');
    bindRange('judgeY', 'judgeYOut', 'judgeY', v => Math.round(v * 100) + '%', 'game');
    bindRange('offsetMs', 'offsetOut', 'offsetMs', v => (v > 0 ? '+' : '') + v + ' ms', 'game');
    bindRange('volume', 'volumeOut', 'volume', v => Math.round(v * 100) + '%', 'game');
    bindRange('edgeMargin', 'edgeMarginOut', 'edgeMargin', v => v + ' px', 'game');
    bindRange('laneSlackPx', 'laneSlackPxOut', 'laneSlackPx', v => v + ' px', 'game');
    bindRange('maxDpr', 'maxDprOut', 'maxDpr', v => v.toFixed(2).replace(/0$/, '') + 'x', 'game');
    bindRange('bgmVolume', 'bgmVolumeOut', 'bgmVolume', v => Math.round(v * 100) + '%', 'game');

    const bpm = $('bpm'), bpmNum = $('bpmNum');
    bpm.value = state.bpm; bpmNum.value = state.bpm; $('bpmOut').textContent = state.bpm;
    setBpm = (v) => {
      state.bpm = v; bpm.value = v; bpmNum.value = v; $('bpmOut').textContent = v;
      refresh(); syncBgmHint();
    };
    bpm.addEventListener('input', () => {
      state.bpm = +bpm.value; bpmNum.value = bpm.value; $('bpmOut').textContent = bpm.value;
      refresh(); syncBgmHint();
    });
    bpmNum.addEventListener('change', () => {
      const v = Math.max(40, Math.min(400, Math.round(+bpmNum.value || 160)));
      state.bpm = v; bpmNum.value = v; bpm.value = v; $('bpmOut').textContent = v;
      refresh(); syncBgmHint();
    });

    $('measures').value = state.measures;
    $('measures').addEventListener('change', (e) => {
      if (e.target.value === 'auto') return;
      state.measures = +e.target.value; refresh();
    });
    if ($('challenge')) {
      $('challenge').checked = !!state.challenge;
      $('challenge').addEventListener('change', (e) => {
        state.challenge = e.target.checked; syncSubopts(); refresh(); syncBgmHint();
      });
    }
    const bindNum = (id, key, lo, hi) => {
      const el = $(id);
      if (!el) return;
      el.value = state[key];
      el.addEventListener('change', () => {
        const v = Math.max(lo, Math.min(hi, Math.round(+el.value || state[key])));
        state[key] = v; el.value = v; refresh();
      });
    };
    bindNum('bpmEnd', 'bpmEnd', 40, 400);
    bindNum('rampStep', 'rampStep', 1, 50);
    $('seed').value = state.seed;
    $('seed').addEventListener('input', (e) => { state.seed = e.target.value || 'demo'; refresh(); });
    $('btnSeed').addEventListener('click', () => { state.seed = randomSeed(); $('seed').value = state.seed; refresh(); });

    bindSeg('keys', v => { state.keys = +v; syncSubopts(); refresh(); });
    bindSeg('axisHand', v => { state.axisHand = v; refresh(); });
    bindSeg('axisStyle', v => { state.axisStyle = v; refresh(); });
    setSeg('keys', state.keys);
    setSeg('axisHand', state.axisHand);
    setSeg('axisStyle', state.axisStyle);

    const ll = $('lowLatency');
    if (ll) {
      try { ll.checked = localStorage.getItem('rhythmlab_lowlatency') === '1'; } catch (e) { /* ignore */ }
      ll.addEventListener('change', (e) => {
        try { localStorage.setItem('rhythmlab_lowlatency', e.target.checked ? '1' : '0'); } catch (err) { /* ignore */ }
        location.reload();
      });
    }

    /* 只有原生壳里才有这个开关：给 ROM 的多指手势检测做 A/B 用。
       壳里但桥没注入上时，把开关显出来并置灰，免得静悄悄什么都不出现。 */
    const inShell = /RhythmLabShell/.test(navigator.userAgent);
    const bridge = !!(window.RLShell && window.RLShell.setSecure);
    if (bridge || inShell) {
      $('secureWrap').classList.remove('hidden');
      const cb = $('blockGestures');
      if (!bridge) {
        cb.disabled = true;
        $('secureWrap').querySelector('.hint').textContent = '当前 APK 不支持这个开关，请重新下载安装。';
      } else {
        cb.checked = !!state.game.blockGestures;
        const apply = () => { try { RLShell.setSecure(cb.checked); } catch (e) { /* ignore */ } };
        cb.onchange = () => { state.game.blockGestures = cb.checked; apply(); saveState(); };
        apply();
      }
    }
    for (const id of ['metroOverlay', 'hitSound', 'handColors', 'showErrorBar', 'missOnEmpty', 'autoplay', 'autoCalibrate', 'autoFullscreen', 'minimalFx', 'inputDebug']) {
      if (!$(id)) continue;
      $(id).checked = !!state.game[id];
      $(id).addEventListener('change', (e) => {
        state.game[id] = e.target.checked;
        Object.assign(game.settings, state.game);
        saveState();
      });
    }
    $('mixAll').addEventListener('click', () => { state.mixedPool = G.FANCY_KEYS.slice(); renderMixedPool(); refresh(); });
    $('mixNone').addEventListener('click', () => { state.mixedPool = []; renderMixedPool(); refresh(); });

    const bgmSel = $('bgm');
    if (bgmSel) {
      // 先按组归拢再渲染，避免数组顺序把同一组拆成几段
      const order = [], byGroup = {};
      for (const b of MG.BGMS) {
        const gname = b.group || '其他';
        if (!byGroup[gname]) { byGroup[gname] = []; order.push(gname); }
        byGroup[gname].push(b);
      }
      for (const gname of order) {
        const box = document.createElement('optgroup');
        box.label = gname;
        for (const b of byGroup[gname]) {
          const o = document.createElement('option');
          o.value = b.id;
          o.textContent = b.name;
          box.appendChild(o);
        }
        bgmSel.appendChild(box);
      }
      bgmSel.value = MG.BGM_BY_ID[state.game.bgm] ? state.game.bgm : 'metro';
      state.game.bgm = bgmSel.value;
      bgmSel.addEventListener('change', (e) => {
        state.game.bgm = e.target.value;
        Object.assign(game.settings, state.game);
        const sel = MG.BGM_BY_ID[state.game.bgm];
        if (sel && sel.kind === 'file') audio.loadFile(sel.url).catch(() => {});
        syncBgmHint();
        saveState();
      });
    }

    $('btnStart').addEventListener('click', startGame);
    $('btnFullscreen').addEventListener('click', toggleFullscreen);
    $('btnPause').addEventListener('click', () => game.togglePause());
    $('btnResume').addEventListener('click', () => game.resume());
    $('btnRestart').addEventListener('click', () => { $('pauseOverlay').classList.add('hidden'); game.stop(); startGame(); });
    $('btnQuit').addEventListener('click', backToSetup);
    $('btnAgain').addEventListener('click', () => startGame());
    $('btnNewSeed').addEventListener('click', () => {
      state.seed = randomSeed(); $('seed').value = state.seed; saveState();
      chart = G.generate(genOpts());
      startGame();
    });
    $('btnBack').addEventListener('click', backToSetup);

    game.onFinish = showResult;
    game.onPauseChange = (paused) => {
      $('pauseOverlay').classList.toggle('hidden', !paused);
      if (paused) exitFullscreen();     // 暂停也算「不在打」
    };
    window.addEventListener('resize', () => {
      if (!$('setup').classList.contains('hidden') && chart) drawPreview(chart);
    });
  }

  function randomSeed() {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }
  function toggleFullscreen() {
    const el = document.documentElement;
    if (!document.fullscreenElement) (el.requestFullscreen || el.webkitRequestFullscreen || function () {}).call(el);
    else (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
  }

  function boot() {
    loadState();
    initControls();
    renderPresets();
    syncSubopts();
    syncBgmHint();
    syncJudgeHint();
    refresh();
    MG.READY = true;
  }

  try {
    boot();
  } catch (err) {
    // 初始化挂掉会导致按钮全部没绑上、页面像卡死一样，这里兜住并给出自救入口
    MG.INIT_ERROR = err;
    console.error('RhythmLab 初始化失败', err);
  }
})(window.MG);
