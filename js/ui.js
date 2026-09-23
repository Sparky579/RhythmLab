/* UI：设置面板、预览、游戏页与结果 */
(function (MG) {
  'use strict';
  const G = MG.Generator;
  const $ = (id) => document.getElementById(id);
  const BUILD = '55';
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
    mode: 'lane',           // 'lane' 4K/7K | 'free' 无轨 | 'circle' 点圈（后两者只能触屏打）
    freeSize: 6,            // 无轨 / 点圈的音符宽度 = 场地宽的 1/freeSize
    bpm: 160,
    measures: 16,           // 旧存档字段，只用来迁移成 beats
    lenMode: 'beats',       // 'time' 改 BPM 时保持时长 | 'beats' 保持拍数
    lenSec: 120,
    beats: 64,
    noteDiv: 16,            // 主段几分音；休息段自动取一半
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
        // 老存档只有小节数：换算成拍数，行为不变
        if (s.beats === undefined && s.measures) { s.beats = s.measures * 4; s.lenMode = 'beats'; }
        Object.assign(state, s, { game: Object.assign({}, MG.GAME_DEFAULTS, s.game || {}) });
        // 老存档里留白还是 28px，而取消恰好密集发生在离屏幕边缘 40–80px 处，
        // 停在旧默认值上的一律抬到新默认值（自己调过的不动）
        if (s.game && s.game.edgeMargin === 28) state.game.edgeMargin = MG.GAME_DEFAULTS.edgeMargin;
        if (!Array.isArray(state.mixedPool) || !state.mixedPool.length) state.mixedPool = G.FANCY_KEYS.slice();
        state.mixedPool = state.mixedPool.filter(k => G.FANCY_KEYS.indexOf(k) >= 0);
        if (!state.mixedPool.length) state.mixedPool = G.FANCY_KEYS.slice();
      }
    } catch (e) { /* ignore */ }
    // 双押海从「切」挪到了「乱 / 散打」，老存档跟着搬过去
    if (state.preset === 'js_sea') state.group = 'chaos';
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
    if (G.NOTE_DIVS.indexOf(+state.noteDiv) < 0) state.noteDiv = 16;
    state.noteDiv = +state.noteDiv;
    if (state.lenMode !== 'time') state.lenMode = 'beats';
    state.beats = clampBeats(state.beats);
    state.lenSec = Math.max(1, Math.min(3600, +state.lenSec || 120));
    if (G.KEY_OPTIONS.indexOf(state.keys) < 0) state.keys = 4;
    if (state.mode !== 'free' && state.mode !== 'circle') state.mode = 'lane';
    state.freeSize = Math.max(4, Math.min(10, Math.round(+state.freeSize || 6)));
    // 这两种模式都要点到屏幕上的任意横坐标，键盘映射不了——非触屏设备不给选
    if (state.mode !== 'lane' && !isTouch()) state.mode = 'lane';
  }
  /* ---------- 长度：时长 ⇄ 拍数 ---------- */
  const MAX_BEATS = G.MAX_MEASURES * 4;
  function clampBeats(v) { return Math.max(4, Math.min(MAX_BEATS, Math.round(+v || 64))); }
  /* 实际生成用的拍数：按时长时由时长和 BPM 折算，取最近的整拍 */
  function effBeats() {
    return state.lenMode === 'time' ? clampBeats(state.lenSec * state.bpm / 60) : clampBeats(state.beats);
  }
  function fmtTime(sec) {
    const s = Math.round(sec);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  /* 「2:00」「2:5」「90」（纯数字按秒）都认；认不出返回 NaN */
  function parseTime(str) {
    const t = String(str || '').trim().replace('：', ':');
    let m = /^(\d+):(\d{1,2})$/.exec(t);
    if (m) return +m[1] * 60 + +m[2];
    m = /^(\d+(?:\.\d+)?)$/.exec(t);
    return m ? Math.round(+m[1]) : NaN;
  }

  function saveState() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  const audio = new MG.AudioEngine();
  const game = new MG.Game($('game'), audio);
  MG.game = game;   // 供自动化测试驱动真实路径
  // 原生壳（安卓 App）通过它把 MotionEvent 直接喂进来
  MG.nativeTouch = (type, id, x, age, y) => game.nativeTouch(type, id, x, age, y);
  /* 原生壳攒批下发：一条字符串里是若干 "类型,id,x,age" 或 "类型,id,x,y,age"，分号分隔。
     无轨模式需要 y，壳从 RhythmLabShell/4 起改发 5 段；4 段是旧壳，照旧只有 x。 */
  MG.nativeBatch = (s) => {
    if (!s) return;
    const recs = s.split(';');
    for (let i = 0; i < recs.length; i++) {
      const f = recs[i].split(',');
      if (f.length === 5) game.nativeTouch(f[0], +f[1], +f[2], +f[4], +f[3]);
      else if (f.length === 4) game.nativeTouch(f[0], +f[1], +f[2], +f[3]);
    }
  };
  let chart = null;
  let previewTimer = 0;

  const isMixed = () => state.preset === 'mixed';
  let scrollSave = 0;

  /* ---------- 横屏 ---------- */
  /* 安卓 Chrome 的 screen.orientation.lock 只在全屏时才允许调用；iOS Safari 完全不支持。
     所以锁定只能当作「尽力而为」，真正的兜底是 #rotateGate 那块竖屏挡板。
     原生壳里整个 Activity 已经锁死横屏，这两条都不会触发。 */
  const isTouch = () => typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  function lockLandscape() {
    const so = screen && screen.orientation;
    if (!so || !so.lock) return;
    try { const r = so.lock('landscape'); if (r && r.catch) r.catch(() => {}); } catch (e) { /* 不支持就算了 */ }
  }
  function unlockOrientation() {
    const so = screen && screen.orientation;
    if (!so || !so.unlock) return;
    try { so.unlock(); } catch (e) { /* ignore */ }
  }
  /* 竖屏挡板：只在触屏设备、游戏页、且确实是竖屏时挡。桌面窗口再高也不挡。 */
  function syncRotateGate() {
    const gate = $('rotateGate');
    if (!gate) return;
    const playing = !$('play').classList.contains('hidden');
    const portrait = window.innerHeight > window.innerWidth;
    const need = playing && portrait && isTouch();
    gate.classList.toggle('hidden', !need);
    // 挡板期间把游戏停住，免得音符白白掉过去算成 miss
    if (need && (game.state === 'playing' || game.state === 'countin')) game.pause();
  }

  function exitFullscreen() {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) return;
    const fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (!fn) return;
    try { const r = fn.call(document); if (r && r.catch) r.catch(() => {}); } catch (e) { /* ignore */ }
  }

  /* 有弹层时必须放开 touch-action：#play 上的 none 会顺着祖先链
     把结束页的上下滑也一并挡掉，手机上就变成整页锁死滚不动。 */
  function syncOverlayScroll() {
    const open = !$('resultOverlay').classList.contains('hidden')
      || !$('pauseOverlay').classList.contains('hidden');
    $('play').classList.toggle('overlay-open', open);
  }

  function lockScroll(on) {
    if (on) { scrollSave = window.scrollY || 0; document.body.classList.add('playing'); }
    else { document.body.classList.remove('playing'); window.scrollTo(0, scrollSave); }
  }


  /* ---------- 我的音乐（用户上传） ---------- */
  let userEntries = [];          // 自定义 BGM 条目，跟内置的拼在一起进下拉框
  let userBgmLoaded = false;     // IndexedDB 是异步的，加载完之前别把选中项重置掉
  let pending = null;            // 确认面板正在处理的这一首
  let preview = null;            // 试听用的音频节点

  function allBgms() { return MG.BGMS.concat(userEntries); }

  function renderBgmSelect() {
    const sel = $('bgm');
    if (!sel) return;
    const keep = state.game.bgm;
    sel.innerHTML = '';
    // 先按组归拢再渲染，避免数组顺序把同一组拆成几段
    const order = [], byGroup = {};
    for (const b of allBgms()) {
      const gname = b.group || '其他';
      if (!byGroup[gname]) { byGroup[gname] = []; order.push(gname); }
      byGroup[gname].push(b);
    }
    for (const gname of order) {
      const box = document.createElement('optgroup');
      box.label = gname;
      for (const b of byGroup[gname]) {
        const o = document.createElement('option');
        o.value = b.id; o.textContent = b.name;
        box.appendChild(o);
      }
      sel.appendChild(box);
    }
    if (MG.BGM_BY_ID[keep]) {
      sel.value = keep;
    } else if (!userBgmLoaded && /^user_/.test(keep)) {
      // 自定义曲目还没从 IndexedDB 读出来：界面上先显示节拍器，
      // 但不要改 state，等加载完这里会重渲染并选回去
      sel.value = 'metro';
      return;
    } else {
      sel.value = 'metro';
    }
    state.game.bgm = sel.value;
    Object.assign(game.settings, state.game);
  }

  function reloadUserBgms() {
    if (!MG.UserBgm) return Promise.resolve();
    return MG.UserBgm.list().then((recs) => {
      userBgmLoaded = true;
      userEntries = recs.map(MG.UserBgm.toEntry);
      for (const e of userEntries) MG.BGM_BY_ID[e.id] = e;
      $('btnManageBgm').classList.toggle('hidden', !userEntries.length);
      if (!userEntries.length) $('myBgmList').classList.add('hidden');
      renderBgmSelect();
      renderMyBgmList();
    }).catch(() => {
      // 存储不可用就当没有自定义曲目，但要放行选中项的兜底
      userBgmLoaded = true;
      renderBgmSelect();
    });
  }

  function renderMyBgmList() {
    const box = $('myBgmList');
    box.innerHTML = '';
    for (const e of userEntries) {
      const row = document.createElement('div');
      row.className = 'my-bgm-row';
      row.innerHTML = `<span>${e.name}</span><small>${e.baseBpm} BPM</small>`;
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'link'; del.textContent = '删除';
      del.addEventListener('click', () => {
        if (!confirm(`删除「${e.name}」？`)) return;
        const rawId = e.id.slice(5);
        MG.UserBgm.remove(rawId).then(() => {
          delete MG.BGM_BY_ID[e.id];
          if (state.game.bgm === e.id) { state.game.bgm = 'metro'; saveState(); }
          return reloadUserBgms();
        });
      });
      row.appendChild(del);
      box.appendChild(row);
    }
  }

  /* ---------- 上传与确认 ---------- */
  /* 原生壳的版本。旧壳（/3 及以前）没实现 onShowFileChooser，
     页面里的 <input type="file"> 点下去连事件都不会产生——就是「啥反应都没有」。
     没法从 JS 侧补救，只能把原因说清楚并指路。 */
  const SHELL_FILE_OK = 4;
  function shellVersion() {
    const m = /RhythmLabShell\/(\d+)/.exec(navigator.userAgent || '');
    return m ? +m[1] : 0;
  }
  function uploadUnsupportedReason() {
    const v = shellVersion();
    if (v && v < SHELL_FILE_OK) {
      return '这个版本的安卓 App 不支持选文件（WebView 默认就不处理，点了没有任何反应）。'
        + '请回站点下载新版 APK，或先用手机浏览器打开上传一次——曲目存在本机，两边各存各的。';
    }
    return '';
  }

  /* file.arrayBuffer() 在老 Safari / 老 WebView 上没有，退回 FileReader */
  function readArrayBuffer(file) {
    if (file.arrayBuffer) return file.arrayBuffer();
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(r.error || new Error('读不出文件内容'));
      r.readAsArrayBuffer(file);
    });
  }

  function onPickFile(file) {
    const hint = $('bgmUploadHint');
    if (!file) return;
    if (file.size > MG.UserBgm.MAX_BYTES) {
      hint.textContent = `文件太大（${(file.size / 1048576).toFixed(1)}MB），上限 `
        + `${MG.UserBgm.MAX_BYTES / 1048576}MB。截一段再传。`;
      return;
    }
    hint.textContent = '正在读取文件…';
    const ctx = audio.ensure();
    if (!ctx) { hint.textContent = '音频未就绪，先点一下页面再试。'; return; }
    // 从网盘/云端选的文件要先下载到本机，读取可能一直不返回
    const readLimit = 20000 + file.size / 1048576 * 2000;
    Promise.race([
      readArrayBuffer(file),
      new Promise((_, rej) => setTimeout(() => rej(new Error('读取文件超时，先把它存到手机本地再选')), readLimit)),
    ])
      .then((ab) => MG.UserBgm.analyze(ab, ctx, (t) => { hint.textContent = t; })
        .then((info) => ({ ab, info })))
      .then(({ ab, info }) => {
        hint.textContent = '';
        pending = {
          id: MG.UserBgm.newId(),
          name: file.name.replace(/\.[^.]+$/, '').slice(0, 40) || '未命名',
          blob: new Blob([ab], { type: file.type || 'audio/mpeg' }),
          duration: info.duration,
          buffer: info.buffer,
          env: info.env, envLow: info.envLow, fps: info.fps,
          segments: info.segments, curve: info.curve,
          bpm: round2(info.bpm),
          from: info.rangeStart, to: info.rangeEnd,
          anchor: info.startSec,          // 某一拍的绝对位置；网格以它为原点，调范围时拍点不动
        };
        openConfirm();
      })
      .catch((e) => { hint.textContent = '读不了这个文件：' + e.message; });
  }

  const round2 = (v) => Math.round(v * 100) / 100;
  const fmtPos = (sec) => Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0');
  const barSec = () => 240 / pending.bpm;
  /* 起拍点 = 截取起点之后、与网格对齐的第一个小节起点（相对起点的秒数） */
  const offSec = () => {
    const bar = barSec(), v = (((pending.anchor - pending.from) % bar) + bar) % bar;
    return v > bar - 0.03 ? 0 : v;     // 拍点比起点早几毫秒时别绕到小节末尾去
  };

  /* 把 pending 同步到面板上的所有控件 */
  function syncConfirm() {
    const p = pending;
    const bpmEl = $('bgmcBpm');
    bpmEl.value = p.bpm;
    if (document.activeElement !== $('bgmcBpmNum')) $('bgmcBpmNum').value = p.bpm;
    $('bgmcBpmOut').textContent = p.bpm;
    // 起拍点能调一整小节：测速只定得出拍的相位，定不出哪一拍是重拍
    const offEl = $('bgmcOff');
    offEl.max = Math.round(barSec() * 1000);
    offEl.value = Math.round(offSec() * 1000);
    $('bgmcOffOut').textContent = offEl.value + ' ms';
    const fromEl = $('bgmcFrom'), toEl = $('bgmcTo');
    fromEl.max = toEl.max = Math.floor(p.duration * 10) / 10;
    fromEl.value = p.from; toEl.value = p.to;
    $('bgmcRangeOut').textContent = `${fmtPos(p.from)} – ${fmtPos(p.to)}（${Math.round(p.to - p.from)} 秒）`;
    const posEl = $('bgmcPos');
    // 试听位置存在 pending 里：滑块的值会被浏览器按 min/max 夹住，改范围时会被拖着跑
    posEl.min = p.from; posEl.max = Math.max(p.from + 0.5, p.to - 0.5);
    if (!(p.pos >= p.from && p.pos <= p.to - 0.5)) p.pos = p.from;
    posEl.value = p.pos;
    if (!preview) $('bgmcPosOut').textContent = fmtPos(p.pos);
    drawCurve();
  }

  /* 速度曲线：横轴整首时间，纵轴 BPM。检测出的各段用色块分开，
     截取范围外面压暗；点某一段就选中它 */
  function drawCurve(playAt) {
    const cv = $('bgmcCurve'), p = pending;
    if (!cv || !p) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(10, cv.clientWidth), H = cv.clientHeight || 110;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const segs = p.segments || [], curve = p.curve || [];
    const vals = segs.map((sg) => sg.bpm).concat(curve.map((c) => c.bpm), [p.bpm]);
    let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    const padV = Math.max(6, (hi - lo) * 0.25); lo -= padV; hi += padV;
    const x = (t) => (t / p.duration) * W;
    const y = (b) => H - 16 - ((b - lo) / (hi - lo)) * (H - 30);
    const palette = ['rgba(122,162,255,0.18)', 'rgba(192,132,252,0.18)'];
    segs.forEach((sg, i) => {
      g.fillStyle = palette[i % 2];
      g.fillRect(x(sg.start), 0, x(sg.end) - x(sg.start), H);
    });
    // 曲线
    g.strokeStyle = 'rgba(232,236,255,0.35)'; g.lineWidth = 1;
    g.beginPath();
    curve.forEach((c, i) => { const px = x(c.t), py = y(c.bpm); if (i) g.lineTo(px, py); else g.moveTo(px, py); });
    g.stroke();
    // 每段的精测值
    g.font = '11px system-ui, sans-serif'; g.textAlign = 'center';
    segs.forEach((sg) => {
      g.strokeStyle = '#7aa2ff'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(x(sg.start) + 2, y(sg.bpm)); g.lineTo(x(sg.end) - 2, y(sg.bpm)); g.stroke();
      if (x(sg.end) - x(sg.start) > 38) {
        g.fillStyle = 'rgba(232,236,255,0.85)';
        g.fillText(sg.bpm.toFixed(1), (x(sg.start) + x(sg.end)) / 2, Math.max(12, y(sg.bpm) - 6));
      }
    });
    // 截取范围外压暗，边界画线
    g.fillStyle = 'rgba(5,6,12,0.6)';
    g.fillRect(0, 0, x(p.from), H);
    g.fillRect(x(p.to), 0, W - x(p.to), H);
    g.strokeStyle = '#fff'; g.lineWidth = 1.5;
    for (const t of [p.from, p.to]) { g.beginPath(); g.moveTo(x(t), 0); g.lineTo(x(t), H); g.stroke(); }
    if (playAt !== undefined) {
      g.strokeStyle = '#ffd166'; g.beginPath(); g.moveTo(x(playAt), 0); g.lineTo(x(playAt), H); g.stroke();
    }
    // 时间刻度：首尾
    g.fillStyle = 'rgba(232,236,255,0.5)'; g.textAlign = 'left';
    g.fillText('0:00', 4, H - 4);
    g.textAlign = 'right'; g.fillText(fmtPos(p.duration), W - 4, H - 4);
  }

  function segHintText() {
    const segs = pending.segments || [];
    if (segs.length <= 1) return '全曲速度稳定，默认用整首。想只用其中一段就拖下面的截取范围。';
    const best = segs.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
    return `检测到变速（${segs.length} 段）：`
      + segs.map((sg) => `${fmtPos(sg.start)}–${fmtPos(sg.end)} ${sg.bpm.toFixed(1)}`).join('，')
      + `。已自动选最长的一段（${fmtPos(best.start)}–${fmtPos(best.end)}），点曲线上的其它段可以换，也可以自己拖范围。`;
  }

  function openConfirm() {
    $('bgmcName').textContent = `${pending.name} · ${Math.round(pending.duration)} 秒`;
    $('bgmcSegHint').textContent = segHintText();
    pending.pos = pending.from;
    $('bgmConfirm').classList.remove('hidden');
    document.body.classList.add('modal-open');   // 背景别跟着滚
    syncConfirm();                               // 面板显示出来之后才量得到画布宽度
  }

  function closeConfirm() {
    stopPreview();
    $('bgmConfirm').classList.add('hidden');
    document.body.classList.remove('modal-open');
    pending = null;
  }

  function stopPreview() {
    if (!preview) return;
    try { preview.src.stop(); } catch (e) { /* ignore */ }
    for (const o of preview.clicks) { try { o.stop(); } catch (e) { /* ignore */ } }
    clearInterval(preview.timer);
    preview = null;
    if ($('bgmcPos')) $('bgmcPosOut').textContent = fmtPos(+$('bgmcPos').value);
    if (pending) drawCurve();
    $('bgmcPlay').textContent = '▶ 试听';
  }

  /* 试听：音乐照原速放，节拍器按当前 BPM 与起拍点叠上去。
     从「试听位置」开始放；节拍网格始终以起拍点为原点，所以放到 1:00 也是对齐的 */
  function startPreview() {
    const ctx = audio.ensure();
    if (!ctx || !pending) return;
    stopPreview();
    if (ctx.state !== 'running' && ctx.resume) ctx.resume().catch(() => {});
    const bpm = pending.bpm, off = pending.from + offSec();   // 截取范围里的第一拍（绝对秒）
    const pos = pending.pos || pending.from;
    const end = pending.to;
    const beat = 60 / bpm, SECS = Math.max(1, Math.min(15, end - Math.max(pos, pending.from)));
    const t0 = ctx.currentTime + 0.2;
    const src = ctx.createBufferSource();
    src.buffer = pending.buffer;
    const g = ctx.createGain(); g.gain.value = 0.8;
    src.connect(g); g.connect(audio.master || ctx.destination);
    // 从开头试听时从第一拍前半秒起播，省得等前奏
    const from = pos > pending.from + 0.01 ? Math.min(pos, Math.max(0, end - 1)) : Math.max(pending.from, off - 0.5);
    src.start(t0, from);
    const clicks = [];
    for (let k = Math.ceil((from - off) / beat); ; k++) {
      const at = t0 + (off + k * beat - from);
      if (at > t0 + SECS) break;
      if (at < t0) continue;
      const o = ctx.createOscillator(), cg = ctx.createGain();
      o.frequency.value = ((k % 4) + 4) % 4 === 0 ? 1600 : 1100;
      cg.gain.setValueAtTime(0.0001, at);
      cg.gain.exponentialRampToValueAtTime(0.5, at + 0.002);
      cg.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
      o.connect(cg); cg.connect(audio.master || ctx.destination);
      o.start(at); o.stop(at + 0.06);
      clicks.push(o);
    }
    src.stop(t0 + SECS);
    // 播放时把当前位置显示出来（拖动滑块期间不去抢它）
    const timer = setInterval(() => {
      const now = from + Math.max(0, ctx.currentTime - t0);
      $('bgmcPosOut').textContent = fmtPos(now) + ' ▶';
      drawCurve(now);
    }, 200);
    preview = { src, clicks, timer };
    $('bgmcPlay').textContent = '■ 停止';
    src.onended = () => { if (preview && preview.src === src) stopPreview(); };
  }

  function saveConfirm() {
    if (!pending) return;
    stopPreview();
    const rec = {
      id: pending.id, name: pending.name, blob: pending.blob,
      duration: pending.duration,
      // BPM 留两位小数：3 分钟的歌 137.88 存成 138，结尾会差出 150ms
      bpm: round2(pending.bpm),
      startSec: Math.round((pending.from + offSec()) * 1000) / 1000,   // 截取范围里第一个小节的起点
      endSec: pending.to,
      addedAt: Date.now(),
    };
    MG.UserBgm.save(rec)
      .then(() => reloadUserBgms())
      .then(() => {
        state.game.bgm = 'user_' + rec.id;
        $('bgm').value = state.game.bgm;
        Object.assign(game.settings, state.game);
        saveState(); syncBgmHint(); refresh();
        closeConfirm();
      })
      .catch((e) => { $('bgmUploadHint').textContent = '保存失败：' + e.message; });
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
    // 纵连（kind 'jackline'）也吃位移幅度——它决定换轨跳多远，以前滑条被藏起来，
    // 看着就像「调了没用」。凡是真的会用到这个值的预设都要把滑条露出来。
    const usesShift = (k) => G.PRESETS[k] && (G.PRESETS[k].kind === 'trill' || G.PRESETS[k].kind === 'jackline');
    const trillShown = (!mixed && usesShift(state.preset)) || (mixed && state.mixedPool.some(usesShift));
    $('optTrill').classList.toggle('hidden', !trillShown);
    $('shiftHint').textContent = shiftHintText();
    $('axisOpts').classList.toggle('hidden', !(mixed ? state.mixedPool.indexOf('trill_axis') >= 0 : state.preset === 'trill_axis'));
    $('optMixed').classList.toggle('hidden', !mixed);
    if (mixed) renderMixedPool();

    $('optFree').classList.toggle('hidden', state.mode === 'lane');
    if (state.mode !== 'lane') {
      const cols = G.freeCols(state.freeSize);
      const free = state.mode === 'free';
      $('keysHint').textContent = free
        ? '无轨：照样是下落式，判定线也还在，只是没有轨道分隔——音符宽度固定，'
          + '横坐标连续，落哪儿就得点哪儿。只能触屏打。'
        : '点圈：不下落。固定大小的圈直接出现在屏幕上，外面那圈提示环收拢到贴合时'
          + '就是判定时刻。练瞄准。只能触屏打。';
      $('freeSizeLabel').textContent = free ? '音符宽度 ' : '圈的大小 ';
      $('freeHint').textContent = (free
        ? `音符宽度 = 屏宽的 1/${state.freeSize}，横向落点由 ${cols} 列的骨架加游走摊开，`
          + '越窄越要瞄得准。'
        : `圈的直径 = 场地宽的 1/${state.freeSize}，横向 ${cols} 个位置打底、纵向连续，`
          + '越小位置越多、越考验瞄准。');
      $('keyHelp').textContent = free
        ? '音符落到判定线时点它所在的横向位置，键盘打不了。Esc 暂停。'
        : '点到哪个圈就打哪个，键盘打不了。Esc 暂停。';
    } else {
      const K = state.keys;
      const labels = MG.KEYMAP[K].labels.join(' ');
      $('keysHint').textContent = K === 4
        ? '4 轨，键盘 D F J K。交互类也可用，两手位置会映射到最近的轨道。'
        : '7 轨，键盘 S D F 空格 J K L。中间那轨是拇指，会用紫色区分。';
      $('keyHelp').textContent = `桌面用 ${labels} 击打，或鼠标点击轨道；手机直接点轨道。Esc 暂停。`;
    }

    const ch = state.challenge;
    $('optChallenge').classList.toggle('hidden', !ch);
    syncLen();
    const bpmLabel = $('bpmOut').parentElement;
    if (bpmLabel) bpmLabel.firstChild.nodeValue = ch ? '起始 BPM ' : 'BPM ';
  }

  /* 位移幅度对每个预设的含义不同，直接把当前这个说清楚，省得来回试 */
  function shiftHintText() {
    const pct = Math.round(state.shiftAmount * 100) + '%';
    const zero = state.shiftAmount <= 0;
    const what = {
      trill_basic: zero ? '两手紧挨着原地互搓' : '两手最多能拉开多远',
      trill_shift4: zero ? '两手钉死不动，等于原地交互' : '每组平移多远',
      trill_shift3: zero ? '两手钉死不动，等于原地交互' : '每组平移多远',
      trill_axis: zero ? '反手也钉死不动，两手都在原地' : '反手往返的摆幅',
      trill_converge: zero ? '起始间距就是 0，整段是原地纵连' : '收拢的起始间距',
      trill_jack: zero ? '整首钉在同一条轨上，永不换轨' : '换轨最多跳几条',
    }[isMixed() ? '' : state.preset];
    return `当前 ${pct}：${what || '每个交互 / 纵连乐句各自的活动范围'}。`
      + (zero ? '0% 就是全程零位移，乐句之间也不再重抽位置。' : '');
  }

  /* 选中的是自己上传的曲子时，整首（截取范围）刚好放完需要多少拍。
     音乐按 BPM / 原速 变速，所以拍数与谱面 BPM 无关，只和曲子本身有关；
     开了自适应调速时一拍音乐对应 ratio 拍谱面 */
  function songBeats() {
    const g = MG.BGM_BY_ID[state.game.bgm];
    if (!g || !g.custom || !g.baseBpm) return 0;
    const ratio = state.game.bgmAdaptive ? MG.bgmTempoRatio(state.bpm, g.baseBpm) : 1;
    return clampBeats(Math.floor(g.loopBars * 4 * ratio));
  }

  /* 长度两栏互相跟随：正在编辑的那栏不去覆盖，免得打字时被改掉。
     挑战模式的长度由爬升区间推出来，两栏只显示、不能改 */
  function syncLen() {
    const tEl = $('lenTime'), bEl = $('lenBeats'), hint = $('lenHint');
    if (!tEl) return;
    const ch = state.challenge;
    tEl.disabled = bEl.disabled = ch;
    document.querySelectorAll('#lenMode button').forEach(b => { b.disabled = ch; });
    setSeg('lenMode', state.lenMode);
    let beats, sec;
    if (ch) {
      const o = G.normalizeOpts(genOpts());
      beats = o.measures * 4;
      sec = chart && chart.challenge ? chart.duration : NaN;
    } else {
      beats = effBeats();
      sec = beats * 60 / state.bpm;
    }
    const focus = document.activeElement;
    if (focus !== tEl) tEl.value = !ch && state.lenMode === 'time' ? fmtTime(state.lenSec) : (isNaN(sec) ? '' : fmtTime(sec));
    if (focus !== bEl) bEl.value = beats;
    const songBtn = $('lenSong');
    if (songBtn) {
      const nb = songBeats();
      songBtn.classList.toggle('hidden', ch || !nb);
      if (nb) songBtn.textContent = `＝ 当前歌曲的长度（${nb} 拍）`;
    }
    if (!hint) return;
    if (ch) {
      hint.textContent = '挑战模式的长度由爬升区间决定。';
    } else {
      const exact = beats * 60 / state.bpm;
      hint.textContent = (state.lenMode === 'time'
        ? `改 BPM 时保持时长，拍数跟着变。${state.bpm} BPM 下 ${beats} 拍`
          + (Math.abs(exact - state.lenSec) >= 0.05 ? `，实际 ${exact.toFixed(1)} 秒` : '')
        : `改 BPM 时保持拍数，时长跟着变。${state.bpm} BPM 下约 ${exact.toFixed(1)} 秒`)
        + (beats % 4 ? `（${Math.floor(beats / 4)} 小节又 ${beats % 4} 拍）。` : `（${beats / 4} 小节）。`);
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
    syncLen();                      // 「＝ 当前歌曲的长度」按钮跟着选中的曲子走
    const el = $('bgmHint');
    if (!el) return;
    const g = MG.BGM_BY_ID[state.game.bgm];
    if (!g) { el.textContent = ''; return; }
    if (!g.baseBpm) { el.textContent = g.desc + '。'; return; }
    const list = MG.bgmSuggestBpms(g.baseBpm).join(' / ');
    const ratio = state.game.bgmAdaptive ? MG.bgmTempoRatio(state.bpm, g.baseBpm) : 1;
    const rate = state.bpm / (g.baseBpm * ratio);
    const fit = Math.abs(rate - 1) < 0.005;
    let html;
    if (state.game.bgmAdaptive) {
      html = `${g.desc}。原速 ${g.baseBpm}，整倍速的 BPM：${list}。`;
      // 自适应：音乐只按 2 的幂变速，BPM 不在整倍速上时才有额外的变速
      html += fit
        ? ' 当前正好是整倍速。'
        : ` 当前 ${state.bpm} BPM，音乐按 <b>${rate.toFixed(2)} 倍速</b>跟着走`
          + ` <button type="button" id="bgmAlign" class="link">对齐到整倍速</button>`;
    } else {
      // 默认：谱面多快音乐就多快
      html = `${g.desc}。原速 ${g.baseBpm}，`;
      html += fit
        ? '当前按原速播放。'
        : `当前 ${state.bpm} BPM，音乐按 <b>${rate.toFixed(2)} 倍速</b>播放`
          + ` <button type="button" id="bgmToBase" class="link">设为原速 ${g.baseBpm}</button>`;
    }
    if (state.challenge) html += ' 挑战模式下会跟着一起持续加速（音高随之升高）。';
    if (g.credit) {
      html += `<br><a href="${g.creditUrl}" target="_blank" rel="noopener" style="color:var(--accent)">${g.credit}</a>`;
    }
    el.innerHTML = html;
    const btn = $('bgmAlign');
    if (btn) btn.addEventListener('click', () => { snapBpmToBgm(); });
    const toBase = $('bgmToBase');
    if (toBase) toBase.addEventListener('click', () => { setBpm(Math.round(g.baseBpm)); });
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
      mode: state.mode, freeSize: state.freeSize,
      beats: effBeats(), noteDiv: state.noteDiv, restRatio: state.restRatio,
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
      const D = state.noteDiv, perSec = (b) => (b / 60 * D / 4).toFixed(1);
      const rowMs = (chart.beat * 4 / D * 1000).toFixed(0);
      $('stats').innerHTML =
        `<span>音符数</span><b>${chart.notes.length}</b>` +
        `<span>时长</span><b>${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, '0')}</b>` +
        `<span>平均密度</span><b>${(chart.notes.length / secs).toFixed(1)} /s</b>` +
        (chart.challenge
          ? `<span>BPM 爬升</span><b>${chart.bpmStart} → ${chart.bpmEnd}</b>`
          : `<span>${D} 分间隔</span><b>${rowMs} ms</b>`) +
        `<span>种子码</span><b>${chart.seedHash.toString(16)}</b>`;
      $('warnings').textContent = chart.warnings.join('；');
      syncLen();
      const endBpm = chart.challenge ? chart.bpmEnd : state.bpm;
      $('bpmHint').textContent = chart.challenge
        ? `起步每秒 ${perSec(state.bpm)} 行，冲到 ${endBpm} 时每秒 ${perSec(endBpm)} 行。`
        : `主段 ${D} 分音 = 每秒 ${perSec(state.bpm)} 行，休息段 ${D / 2} 分音。`;
      $('noteDivHint').textContent = `一小节 ${D} 行（每拍 ${D / 4} 行）`
        + (D % 3 === 0 ? '，三连音系' : '') + `；休息段取一半，${D / 2} 分音。默认 16。`;
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
        ? `每 ${period} 小节休息 1 小节（实际 ${(100 / period).toFixed(0)}%），休息段只有 ${state.noteDiv / 2} 分音单键。`
        : `不插入休息段，全程 ${state.noteDiv} 分音。`;
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
    if (ch.mode === 'circle') return drawPreviewCircle(g, ch, cw, chh);

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
    // 无轨没有轨道分隔线可画——那正是它和 4K / 7K 的区别
    if (ch.mode === 'lane') {
      g.strokeStyle = 'rgba(255,255,255,0.08)';
      for (let i = 1; i < K; i++) { g.beginPath(); g.moveTo(lw * i, 0); g.lineTo(lw * i, chh); g.stroke(); }
    }

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
    const nw = ch.mode === 'free' ? cw * ch.noteD : lw;
    const h = Math.max(3, Math.min(7, nw * 0.32));
    for (const n of ch.notes) {
      if (n.t >= span) break;
      g.fillStyle = (ch.mode === 'lane' && K === 7 && n.col === 3)
        ? MG.JUDGE.THUMB_COLOR : MG.JUDGE.HAND_COLORS[n.hand];
      const x = ch.mode === 'free' ? n.nx * cw - nw / 2 : n.col * lw;
      g.fillRect(x + 2, yOf(n.t) - h / 2, nw - 4, h);
    }
  }

  /* 点圈没有「下落」可画，改成俯视的落点图：按时间先后从暗到亮，
     连线表示同一只手的移动路线，一眼看出手要在屏幕上跑多远。 */
  function drawPreviewCircle(g, ch, cw, chh) {
    const pad = 8;
    const aspect = ch.aspect || 0.5;
    let fw = cw - pad * 2, fh = fw * aspect;
    if (fh > chh - pad * 2) { fh = chh - pad * 2; fw = fh / aspect; }
    const x0 = (cw - fw) / 2, y0 = (chh - fh) / 2;
    const R = fw * ch.noteD / 2;
    g.fillStyle = 'rgba(255,255,255,0.04)';
    g.fillRect(x0, y0, fw, fh);
    const span = ch.beat * 16;
    const shown = ch.notes.filter(n => n.t < span);
    const px = (n) => x0 + n.nx * fw, py = (n) => y0 + n.ny * fh;
    // 手的路线
    for (const hand of [0, 1]) {
      const seq = shown.filter(n => n.hand === hand);
      if (seq.length < 2) continue;
      g.strokeStyle = hand === 0 ? 'rgba(79,200,255,0.22)' : 'rgba(255,111,174,0.22)';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(px(seq[0]), py(seq[0]));
      for (let i = 1; i < seq.length; i++) g.lineTo(px(seq[i]), py(seq[i]));
      g.stroke();
    }
    for (let i = 0; i < shown.length; i++) {
      const n = shown[i];
      g.globalAlpha = 0.25 + 0.75 * (i / Math.max(1, shown.length - 1));
      g.fillStyle = MG.JUDGE.HAND_COLORS[n.hand];
      g.beginPath(); g.arc(px(n), py(n), Math.max(2, R), 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;
    g.fillStyle = 'rgba(255,255,255,0.5)';
    g.font = '11px system-ui, sans-serif';
    // 场地是 2:1 的一条，上下都空着；说明文字放到框外面去，别压在按键上
    g.textBaseline = y0 > 18 ? 'bottom' : 'top';
    g.fillText('前 4 小节的落点（越亮越晚，连线是手的路线）', x0, y0 > 18 ? y0 - 5 : y0 + 4);
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
        // 实时解码卡住时要等 5 秒才换离线解码，8 秒不够兜住
        new Promise((r) => setTimeout(r, 20000)),
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
      // 方向锁要在全屏生效之后才允许调用，所以挂在它的 resolve 上；
      // 同步的旧实现（webkit）拿不到 Promise，就直接试一次
      if (fn) {
        try {
          const r = fn.call(el);
          if (r && r.then) r.then(lockLandscape, () => {}); else lockLandscape();
        } catch (e) { /* 忽略 */ }
      }
    } else {
      lockLandscape();
    }
    $('resultOverlay').classList.add('hidden');
    $('pauseOverlay').classList.add('hidden');
    syncOverlayScroll();
    game.load(chart);
    game.resize();
    game.start();
    // 锁定是异步的（要等全屏先生效），所以隔一下再看还是不是竖屏；
    // 真转过来了，resize / orientationchange 会把挡板收掉
    syncRotateGate();
    setTimeout(syncRotateGate, 400);
  }
  function backToSetup() {
    game.stop();
    unlockOrientation();
    $('rotateGate').classList.add('hidden');
    exitFullscreen();
    lockScroll(false);
    $('play').classList.add('hidden');
    $('setup').classList.remove('hidden');
    refresh();
  }
  function showResult(res) {
    exitFullscreen();          // 一局打完就退出全屏，方便看结果和改设置
    unlockOrientation();
    $('rotateGate').classList.add('hidden');
    rollSeed();                // 每局一换，「再来一次」拿到的是新谱不是背下来的旧谱
    $('resultOverlay').classList.remove('hidden');
    syncOverlayScroll();
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
      `<br>提前 ${res.early} · 延后 ${res.late} · 判定 ${res.perfectMs}/${res.greatMs} ms` +
      (res.autoplay ? '<br>自动演奏' : '') +
      calibLine(res) +
      challengeLine(res);
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
    return `<br><button type="button" id="btnCalib" class="link">校准判定偏移到 ${want} ms</button>`;
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

    const bindRange = (id, outId, key, fmt, target, after) => {
      const el = $(id), out = $(outId);
      if (!el || !out) return;            // 控件缺失（多半是缓存错配）时跳过，别把整页搞挂
      const obj = () => (target === 'game' ? state.game : state);
      el.value = obj()[key];
      const upd = () => { out.textContent = fmt(+el.value); if (after) after(); };
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
    bindRange('shiftAmount', 'shiftAmountOut', 'shiftAmount', v => Math.round(v * 100) + '%',
      null, () => { $('shiftHint').textContent = shiftHintText(); });
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

    setSeg('noteDiv', state.noteDiv);
    bindSeg('noteDiv', v => { state.noteDiv = +v; refresh(); });
    bindSeg('lenMode', v => {
      // 切换时以当前实际值为准，另一栏数值不跳
      if (v === 'beats') state.beats = effBeats();
      else state.lenSec = effBeats() * 60 / state.bpm;   // 不取整，否则 130 拍会变成 129
      state.lenMode = v; syncLen(); refresh();
    });
    // 输入过程中实时联动另一栏；失焦时再把自己规整一遍
    $('lenTime').addEventListener('input', (e) => {
      const v = parseTime(e.target.value);
      if (!(v > 0)) return;
      state.lenSec = Math.min(3600, v); state.lenMode = 'time'; syncLen(); refresh();
    });
    $('lenTime').addEventListener('change', () => syncLen());
    $('lenSong').addEventListener('click', () => {
      const nb = songBeats();
      if (!nb) return;
      state.beats = nb; state.lenMode = 'beats'; syncLen(); refresh();
    });
    $('lenBeats').addEventListener('input', (e) => {
      if (!(+e.target.value >= 1)) return;
      state.beats = clampBeats(e.target.value); state.lenMode = 'beats'; syncLen(); refresh();
    });
    $('lenBeats').addEventListener('change', () => syncLen());
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

    bindSeg('keys', v => {
      state.mode = (v === 'free' || v === 'circle') ? v : 'lane';
      if (state.mode === 'lane') state.keys = +v;
      syncSubopts(); refresh();
    });
    bindRange('freeSize', 'freeSizeOut', 'freeSize', v => `1/${v} 屏宽`, null,
      () => { if ($('optFree') && state.mode !== 'lane') syncSubopts(); });
    // 非触屏设备上把这两个置灰：它们靠的就是点屏幕上的任意横坐标
    if (!isTouch()) {
      for (const id of ['keyFree', 'keyCircle']) {
        const b = $(id);
        if (b) { b.disabled = true; b.title = '只能触屏打'; }
      }
    }
    bindSeg('axisHand', v => { state.axisHand = v; refresh(); });
    bindSeg('axisStyle', v => { state.axisStyle = v; refresh(); });
    setSeg('keys', state.mode === 'lane' ? state.keys : state.mode);
    setSeg('axisHand', state.axisHand);
    setSeg('axisStyle', state.axisStyle);

    const ll = $('lowLatency');
    if (ll) {
      // 没存过就跟默认值（开），存过就按存的来
      try {
        const v = localStorage.getItem('rhythmlab_lowlatency');
        ll.checked = v === null ? true : v === '1';
      } catch (e) { ll.checked = true; }
      ll.addEventListener('change', (e) => {
        try { localStorage.setItem('rhythmlab_lowlatency', e.target.checked ? '1' : '0'); } catch (err) { /* ignore */ }
        location.reload();
      });
    }

    for (const id of ['bgmAdaptive', 'metroOverlay', 'hitSound', 'handColors', 'showErrorBar', 'missOnEmpty', 'autoplay', 'autoFullscreen', 'minimalFx']) {
      if (!$(id)) continue;
      $(id).checked = !!state.game[id];
      $(id).addEventListener('change', (e) => {
        state.game[id] = e.target.checked;
        Object.assign(game.settings, state.game);
        saveState();
        if (id === 'bgmAdaptive') syncBgmHint();
      });
    }
    $('mixAll').addEventListener('click', () => { state.mixedPool = G.FANCY_KEYS.slice(); renderMixedPool(); refresh(); });
    $('mixNone').addEventListener('click', () => { state.mixedPool = []; renderMixedPool(); refresh(); });

    const bgmSel = $('bgm');
    if (bgmSel) {
      renderBgmSelect();
      bgmSel.addEventListener('change', (e) => {
        state.game.bgm = e.target.value;
        Object.assign(game.settings, state.game);
        const sel = MG.BGM_BY_ID[state.game.bgm];
        if (sel && sel.kind === 'file') audio.loadFile(sel.url).catch(() => {});
        syncBgmHint();
        saveState();
      });
    }

    $('btnUploadBgm').addEventListener('click', () => {
      const why = uploadUnsupportedReason();
      if (why) { $('bgmUploadHint').textContent = why; return; }
      $('bgmUploadHint').textContent = '';
      // 借这次点击解锁音频：没解锁的 AudioContext 在部分手机上解码会一直挂住
      audio.unlock().catch(() => {});
      $('bgmFile').click();
    });
    $('bgmFile').addEventListener('change', (e) => {
      onPickFile(e.target.files && e.target.files[0]);
      e.target.value = '';       // 同一个文件再选一次也要能触发
    });
    $('btnManageBgm').addEventListener('click', () => {
      $('myBgmList').classList.toggle('hidden');
    });
    $('bgmcCancel').addEventListener('click', closeConfirm);
    $('bgmcSave').addEventListener('click', saveConfirm);
    $('bgmcPlay').addEventListener('click', () => (preview ? stopPreview() : startPreview()));
    const bpmC = $('bgmcBpm'), bpmN = $('bgmcBpmNum'), offC = $('bgmcOff'), posC = $('bgmcPos');
    // 正在试听时改参数：停一下马上按新参数重放，边听边调（连点按钮只重放最后一次）
    let replayT = 0;
    const retune = () => {
      if (!pending) return;
      syncConfirm();
      if (!preview) return;
      stopPreview();
      clearTimeout(replayT);
      replayT = setTimeout(startPreview, 250);
    };
    const setBpmC = (v) => {
      if (!pending || !(v > 0)) return;
      pending.bpm = round2(Math.max(40, Math.min(240, v)));
      retune();
    };
    bpmC.addEventListener('input', () => setBpmC(+bpmC.value));
    bpmN.addEventListener('input', () => { if (+bpmN.value >= 40 && +bpmN.value <= 240) setBpmC(+bpmN.value); });
    bpmN.addEventListener('change', () => { setBpmC(+bpmN.value || pending.bpm); bpmN.value = pending.bpm; });
    document.querySelectorAll('#bgmConfirm .stepper button').forEach((btn) => {
      btn.addEventListener('click', () => setBpmC(pending.bpm + +btn.dataset.d));
    });
    // 起拍点：挪的是网格原点
    offC.addEventListener('input', () => { if (pending) { pending.anchor = pending.from + +offC.value / 1000; retune(); } });
    // 截取范围：至少留 4 秒；动起点时网格不动，起拍点自动换算
    const MIN_RANGE = 4;
    $('bgmcFrom').addEventListener('input', (e) => {
      if (!pending) return;
      pending.from = Math.max(0, Math.min(+e.target.value, pending.to - MIN_RANGE));
      retune();
    });
    $('bgmcTo').addEventListener('input', (e) => {
      if (!pending) return;
      pending.to = Math.min(pending.duration, Math.max(+e.target.value, pending.from + MIN_RANGE));
      retune();
    });
    $('bgmcRedetect').addEventListener('click', () => {
      if (!pending) return;
      const r = MG.UserBgm.analyzeRange(pending.env, pending.envLow, pending.fps, pending.from, pending.to);
      pending.bpm = round2(r.bpm); pending.anchor = r.firstBeat;
      retune();
    });
    // 点曲线上的某一段：整段选中，并用这段的测速结果
    $('bgmcCurve').addEventListener('click', (e) => {
      if (!pending || !pending.segments) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const t = (e.clientX - rect.left) / rect.width * pending.duration;
      const sg = pending.segments.find((x) => t >= x.start && t <= x.end);
      if (!sg) return;
      pending.from = sg.start; pending.to = sg.end;
      pending.bpm = round2(sg.bpm); pending.anchor = sg.firstBeat;
      pending.pos = sg.start;
      retune();
    });
    window.addEventListener('resize', () => { if (pending) drawCurve(); });
    posC.addEventListener('input', () => {
      if (pending) pending.pos = +posC.value;
      $('bgmcPosOut').textContent = fmtPos(+posC.value);
      if (preview) { stopPreview(); clearTimeout(replayT); replayT = setTimeout(startPreview, 250); }
    });
    reloadUserBgms();

    $('btnStart').addEventListener('click', startGame);
    $('btnFullscreen').addEventListener('click', toggleFullscreen);
    $('btnPause').addEventListener('click', () => game.togglePause());
    $('btnResume').addEventListener('click', () => game.resume());
    $('btnRestart').addEventListener('click', () => {
      $('pauseOverlay').classList.add('hidden'); syncOverlayScroll(); game.stop(); startGame();
    });
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
      syncOverlayScroll();
      if (paused) exitFullscreen();     // 暂停也算「不在打」
    };
    window.addEventListener('resize', () => {
      if (!$('setup').classList.contains('hidden') && chart) drawPreview(chart);
      syncRotateGate();
    });
    window.addEventListener('orientationchange', () => setTimeout(syncRotateGate, 250));
  }

  /* 换一个种子并重算谱面。设置页的种子框与预览同步更新，
     这样无论是点「再来一次」还是退回设置页，拿到的都是同一张新谱。 */
  function rollSeed() {
    state.seed = randomSeed();
    const el = $('seed');
    if (el) el.value = state.seed;
    saveState();
    try { chart = G.generate(genOpts()); } catch (e) { chart = null; }
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
