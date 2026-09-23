/* 位移幅度自检。
 * 要求：位移幅度 0 = 全程一点位移都没有 —— 交互类整首只落在起手的那两条轨上，
 * 纵连整首钉在同一条轨上。幅度调大，用到的轨数必须跟着变多。
 */
const G = require('../js/generator.js').Generator;

const TRILL = ['trill_basic', 'trill_shift4', 'trill_shift3', 'trill_axis', 'trill_converge'];
const SEEDS = ['demo', 'a1', 'zz9', 'k3m', 'q7'];

function colsUsed(opts) {
  const ch = G.generate(opts);
  const s = new Set();
  for (const n of ch.notes) s.add(n.col);
  return s.size;
}

let fails = 0;
const rows = [];

/* 幅度 0：交互两条轨、纵连一条轨，任何种子 / 键数 / 轴设置都不例外 */
for (const keys of [4, 7]) {
  for (const preset of TRILL.concat(['trill_jack'])) {
    for (const axisHand of ['left', 'right', 'alt']) {
      for (const axisStyle of ['tri', 'x', '8']) {
        let worst = 0, worstSeed = '';
        for (const seed of SEEDS) {
          const n = colsUsed({ preset, keys, seed, measures: 32, bpm: 160,
                               shiftAmount: 0, axisHand, axisStyle });
          if (n > worst) { worst = n; worstSeed = seed; }
        }
        // 收拢在 0 幅度下退化成原地纵连，只剩一条轨
        const limit = (preset === 'trill_jack' || preset === 'trill_converge') ? 1 : 2;
        const ok = worst <= limit;
        if (!ok) fails++;
        if (!ok || (axisHand === 'left' && axisStyle === 'tri')) {
          rows.push({ 预设: preset, 键数: keys, 轴: axisHand + '/' + axisStyle,
                      幅度0用到轨数: worst, 上限: limit, 最差种子: worstSeed,
                      结果: ok ? 'ok' : 'FAIL' });
        }
      }
    }
  }
}

/* 幅度调大必须真的更宽：0 与 1 在 7K 上要拉开差距 */
for (const preset of ['trill_shift4', 'trill_shift3', 'trill_axis', 'trill_jack']) {
  const lo = colsUsed({ preset, keys: 7, seed: 'demo', measures: 32, bpm: 160, shiftAmount: 0 });
  const hi = colsUsed({ preset, keys: 7, seed: 'demo', measures: 32, bpm: 160, shiftAmount: 1 });
  const ok = hi > lo + 1;
  if (!ok) fails++;
  rows.push({ 预设: preset, 键数: 7, 轴: '—', 幅度0用到轨数: lo, 上限: '幅度1→' + hi,
              最差种子: 'demo', 结果: ok ? 'ok' : 'FAIL' });
}

/* 幅度 0 时乐句之间也不能重抽：整首的音符列序列必须是同一段在循环 */
for (const preset of ['trill_shift4', 'trill_axis']) {
  const ch = G.generate({ preset, keys: 7, seed: 'demo', measures: 32, bpm: 160, shiftAmount: 0 });
  const cols = ch.notes.map(n => n.col);
  const head = cols.slice(0, 64).join(',');
  const tail = cols.slice(cols.length - 64).join(',');
  const ok = head === tail;
  if (!ok) fails++;
  rows.push({ 预设: preset, 键数: 7, 轴: '首尾同形', 幅度0用到轨数: '-', 上限: '-',
              最差种子: 'demo', 结果: ok ? 'ok' : 'FAIL' });
}

console.table(rows);
console.log('失败', fails);
process.exit(fails ? 1 : 0);
