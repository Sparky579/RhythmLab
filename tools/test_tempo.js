/* 测速自检：用合成的节拍信号验证 onsetEnvelope + detectTempo */
global.window = global;
global.indexedDB = { open() { return {}; } };
require('../js/bgmuser.js');
const U = global.MG.UserBgm;

const SR = 11025;
/* 生成一段带鼓点的信号：每拍一个衰减噪声，隔拍加一个低频 */
function click(bpm, secs, phase, swingPct) {
  const n = SR * secs, x = new Float32Array(n);
  const per = 60 / bpm * SR;
  let k = 0;
  for (let t = phase * SR; t < n; t += per, k++) {
    const start = Math.round(t + (swingPct && k % 2 ? per * swingPct : 0));
    const dur = Math.round(SR * 0.05);
    const low = k % 2 === 0;
    for (let i = 0; i < dur && start + i < n; i++) {
      const env = Math.exp(-i / (SR * 0.012));
      // 底鼓与军鼓都是宽带的，只是频谱倾斜不同；用纯正弦交替会让
      // 「隔拍完全相同」，把测速逼向半速，那是测试信号的毛病不是算法的
      const noise = Math.random() * 2 - 1;
      x[start + i] += env * (low
        ? 0.9 * (0.7 * Math.sin(2 * Math.PI * 60 * i / SR) + 0.3 * noise)
        : 0.8 * (0.3 * Math.sin(2 * Math.PI * 190 * i / SR) + 0.7 * noise));
    }
  }
  // 垫一层持续的和声，模拟真实音乐而不是纯鼓机
  for (let i = 0; i < n; i++) x[i] += 0.08 * Math.sin(2 * Math.PI * 220 * i / SR);
  return x;
}

let fails = 0;
const rows = [];
for (const bpm of [72, 90, 100, 120, 128, 140, 160, 174, 200]) {
  for (const phase of [0, 0.137]) {
    const x = click(bpm, 20, phase, 0);
    const { env, fps } = U._onsetEnvelope(x, SR);
    const r = U._detectTempo(env, fps, 60, 200);
    // 允许整拍倍数：测出 2x 或 0.5x 同样算对，界面上有 ×2 / ÷2 按钮
    const ratio = r.bpm / bpm;
    const okBpm = [0.5, 1, 2].some((k) => Math.abs(ratio - k) < 0.03 * k);
    // 相位误差按一拍取模
    const per = 60 / bpm;
    let dp = Math.abs((r.startSec - phase) % per);
    dp = Math.min(dp, per - dp);
    const okPhase = dp < 0.05;
    if (!okBpm || !okPhase) fails++;
    rows.push({ 真实BPM: bpm, 起拍: phase, 测得BPM: +r.bpm.toFixed(1),
                测得起拍: +r.startSec.toFixed(3), 倍率: +ratio.toFixed(2),
                BPM: okBpm ? 'ok' : 'FAIL', 相位: okPhase ? 'ok' : 'FAIL' });
  }
}
console.table(rows);
console.log('用例', rows.length, '失败', fails);
process.exit(fails ? 1 : 0);
