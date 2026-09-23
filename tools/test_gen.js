/* 生成器自检：全预设 × BPM × 键数 × 种子
 * 覆盖可复现性、各类硬约束、押海的押数、无轨坐标。
 */
const G = require('/home/chengsizhe/codes/MusicGames/js/generator.js').Generator;

const BPMS = [120, 160, 200, 240], SEEDS = ['a', 'b', 'c'];
let total = 0, warnTotal = 0, fails = 0;
const rows = [];

/* 把音符按时刻分行 */
function toRows(notes) {
  const out = [];
  let i = 0;
  while (i < notes.length) {
    let j = i;
    const cols = [];
    while (j < notes.length && Math.abs(notes[j].t - notes[i].t) < 1e-9) { cols.push(notes[j].col); j++; }
    out.push({ t: notes[i].t, cols });
    i = j;
  }
  return out;
}

for (const key of G.PRESET_KEYS.concat(['mixed'])) {
  const preset = G.PRESETS[key];
  let nNotes = 0, nCharts = 0, warns = 0;
  for (const bpm of BPMS) for (const keys of [4, 7]) for (const s of SEEDS) {
    const opts = {
      preset: key, bpm, seed: s, measures: 16, keys,
      axisStyle: key === 'trill_axis' ? ['tri', 'x', '8'][SEEDS.indexOf(s)] : 'tri',
      axisHand: 'alt',
    };
    const c1 = G.generate(opts), c2 = G.generate(opts);
    if (JSON.stringify(c1.notes) !== JSON.stringify(c2.notes)) {
      fails++; console.log('不可复现', key, bpm, keys, s);
    }
    nNotes += c1.notes.length; nCharts++;
    warns += c1.warnings.length;
    if (c1.warnings.length) console.log('WARN', key, bpm, keys, s, c1.warnings.join(';'));

    for (const n of c1.notes) {
      if (n.col < 0 || n.col >= keys) { fails++; console.log('列越界', key, n.col); break; }
    }

    const rs = toRows(c1.notes);

    /* 纵连：整小节钉在一条轨上 */
    if (preset && preset.kind === 'jackline') {
      const per = {};
      for (const n of c1.notes) {
        let m = 0;
        while (m + 1 < c1.measureTime.length && n.t >= c1.measureTime[m + 1] - 1e-6) m++;
        (per[m] = per[m] || new Set()).add(n.col);
      }
      for (const m of Object.keys(per)) {
        if (per[m].size !== 1) { fails++; console.log('纵连 小节内多轨', key, bpm, keys, s, m, [...per[m]]); break; }
      }
    }

    /* 交互：严格一左一右交替，且两手不交叉（收拢与跨手样式例外） */
    if (preset && preset.kind === 'trill') {
      for (let i = 1; i < c1.notes.length; i++) {
        if (c1.notes[i].hand === c1.notes[i - 1].hand) {
          fails++; console.log('交互没交替', key, bpm, keys, s, i); break;
        }
      }
      const crossOk = key === 'trill_converge' || (key === 'trill_axis' && opts.axisStyle !== 'tri');
      if (!crossOk) {
        let L = null, R = null;
        for (const n of c1.notes) {
          if (n.hand === 0) L = n.col; else R = n.col;
          if (L !== null && R !== null && L >= R) {
            fails++; console.log('交互两手交叉', key, bpm, keys, s, L, R); break;
          }
        }
      }
    }

    /* 切：相邻行不共列（押海另有规则，单独测） */
    if (preset && preset.rule === 'stream' && !preset.sea) {
      for (let i = 1; i < rs.length; i++) {
        if (rs[i].t - rs[i - 1].t > c1.beat * 0.51) continue;   // 越过空行 / 换气
        if (rs[i].cols.some(c => rs[i - 1].cols.includes(c))) {
          fails++; console.log('切 相邻行共列', key, bpm, keys, s, rs[i].t); break;
        }
      }
    }

    /* 押海：每一行押数必须一致，共列只能是偶尔的换组手段 */
    if (preset && preset.sea) {
      const want = +Object.keys(preset.chord)[0];
      let shared = 0;
      for (let i = 0; i < rs.length; i++) {
        if (rs[i].cols.length !== want) {
          fails++; console.log('押海 押数不齐', key, bpm, keys, s, rs[i].cols); break;
        }
        if (i > 0 && rs[i].cols.some(c => rs[i - 1].cols.includes(c))) shared++;
      }
      if (shared / rs.length > 0.35) {
        fails++; console.log('押海 共列过多', key, keys, bpm, s, (shared / rs.length * 100).toFixed(0) + '%');
      }
    }
  }
  rows.push({ 预设: key, 谱面数: nCharts, 平均音符: (nNotes / nCharts).toFixed(0), 警告: warns });
  total += nCharts; warnTotal += warns;
}
console.table(rows);
console.log('谱面', total, '警告', warnTotal, '失败', fails);

/* 无轨：坐标齐全、不叠不出界 */
{
  let bad = 0;
  const seen = [];
  for (const key of G.PRESET_KEYS.concat(['mixed'])) {
    for (const size of [4, 6, 8, 10]) {
      for (const seed of ['a', 'b']) {
        const c = G.generate({ preset: key, free: true, freeSize: size, bpm: 200, seed, measures: 16 });
        if (c.warnings.length) { bad++; console.log('无轨 WARN', key, size, seed, c.warnings.join(';')); }
        if (c.notes.some(n => typeof n.nx !== 'number' || typeof n.ny !== 'number')) {
          bad++; console.log('无轨 缺坐标', key, size, seed);
        }
        if (key === 'stream_single' && seed === 'a') {
          const ys = c.notes.map(n => n.ny);
          seen.push({
            按键: '1/' + size, 内部列数: c.keys,
            不同x: new Set(c.notes.map(n => +n.nx.toFixed(4))).size,
            y跨度: (Math.max(...ys) - Math.min(...ys)).toFixed(2),
          });
        }
      }
    }
  }
  console.table(seen);
  console.log('无轨失败', bad);
  fails += bad;
}

console.log('总失败', fails);
process.exit(fails ? 1 : 0);
