const G = require('/home/chengsizhe/codes/MusicGames/js/generator.js').Generator;
const BPMS=[120,160,200,240], DIFFS=[0,0.5,1], SEEDS=['a','b','c'];
let total=0, warnTotal=0, fails=0;
const rows = [];
for (const key of G.PRESET_KEYS.concat(['mixed'])) {
  let nNotes=0, nCharts=0, warns=0, empties=0, divs=new Set(), cross=0, jackFast=0;
  for (const bpm of BPMS) for (const d of DIFFS) for (const s of SEEDS) {
    const opts={preset:key,bpm,difficulty:d,seed:s,measures:16, keys: d===1?7:4, axisStyle: key==='trill_axis'?['tri','x','8'][SEEDS.indexOf(s)]:'tri', axisHand:'alt'};
    const c1=G.generate(opts), c2=G.generate(opts);
    const j1=JSON.stringify(c1.notes), j2=JSON.stringify(c2.notes);
    if (j1!==j2) { fails++; console.log('NOT REPRODUCIBLE', key,bpm,d,s); }
    nNotes+=c1.notes.length; nCharts++;
    warns+=c1.warnings.length;
    if (c1.warnings.length) console.log('WARN', key,bpm,d,s,c1.warnings.join(';'));
    for (const p of c1.phrases) divs.add(p.div);
    // 边界
    for (const n of c1.notes) if (n.x<0.08-1e-9||n.x>0.92+1e-9) { fails++; console.log('OOB',key,n); break; }
    if (G.PRESETS[key] && G.PRESETS[key].kind==='jackline') {
      const per={};
      for (const n of c1.notes) { let m=0; while(m+1<c1.measureTime.length && n.t>=c1.measureTime[m+1]-1e-6) m++;
        (per[m]=per[m]||new Set()).add(n.col); }
      const seq=Object.keys(per).sort((a,b)=>a-b).map(m=>[...per[m]]);
      for (let i=0;i<seq.length;i++) {
        if (seq[i].length!==1) { fails++; console.log('JACKLINE 小节内多轨',key,bpm,d,s,i,seq[i]); break; }
        if (i>0 && seq[i][0]===seq[i-1][0]) { fails++; console.log('JACKLINE 连着两小节同轨',key,bpm,d,s,i); break; }
      }
    }
    // 交互不交叉 (仅 basic/shift/axis-tri)
    if (G.PRESETS[key] && G.PRESETS[key].kind==='trill' && key!=='trill_converge' && !(key==='trill_axis' && opts.axisStyle!=='tri')) {
      let L=null,R=null;
      for (const n of c1.notes) { if (n.hand===0) L=n.x; else R=n.x; if (L!==null&&R!==null&&R-L<0.12-1e-9) { cross++; break; } }
      // 交替
      for (let i=1;i<c1.notes.length;i++) if (c1.notes[i].hand===c1.notes[i-1].hand) { fails++; console.log('NOT ALTERNATING',key,bpm,d,s,i); break; }
    }
    // 押海：每一行都必须是同一个押数，共列只能是偶尔的换组手段
    if (G.PRESETS[key] && G.PRESETS[key].sea) {
      const byT=new Map(); for (const n of c1.notes){ if(!byT.has(n.t)) byT.set(n.t,[]); byT.get(n.t).push(n.col); }
      const ts=[...byT.keys()].sort((a,b)=>a-b);
      const want=+Object.keys(G.PRESETS[key].chord)[0];
      let shared=0;
      for (let i=0;i<ts.length;i++){
        if (byT.get(ts[i]).length!==want) { fails++; console.log('SEA 押数不齐',key,bpm,s,ts[i],byT.get(ts[i])); break; }
        if (i>0) { const a=byT.get(ts[i-1]); if (byT.get(ts[i]).some(c=>a.includes(c))) shared++; }
      }
      if (shared/ts.length > 0.35) { fails++; console.log('SEA 共列过多',key,opts.keys||4,bpm,s,(shared/ts.length*100).toFixed(0)+'%'); }
    }
    // 4K 硬约束
    if (G.PRESETS[key] && G.PRESETS[key].kind==='4k') {
      const byT=new Map(); for (const n of c1.notes){ if(!byT.has(n.t)) byT.set(n.t,[]); byT.get(n.t).push(n.col); }
      const ts=[...byT.keys()].sort((a,b)=>a-b);
      const beat=c1.beat;
      for (let i=1;i<ts.length;i++){
        const dt=ts[i]-ts[i-1]; if (dt>beat*0.51) continue; // 越过空行/换气
        const a=byT.get(ts[i-1]), b=byT.get(ts[i]);
        const shared=a.filter(x=>b.includes(x)).length;
        if (G.PRESETS[key].rule==='stream' && shared>0) { fails++; console.log('STREAM SHARED',key,bpm,d,s,ts[i]); break; }
      }
    }
  }
  rows.push({key, charts:nCharts, avgNotes:(nNotes/nCharts).toFixed(0), warns, cross, divs:[...divs].sort((a,b)=>a-b).join('/')});
  total+=nCharts; warnTotal+=warns;
}
console.table(rows);
console.log('charts', total, 'warnings', warnTotal, 'fails', fails);
// 示例：180 BPM 难度 0.5 单键切 分度
console.log('180/0.5 single div:', G.generate({preset:'stream_single',bpm:180,difficulty:0.5,seed:'x'}).phrases.map(p=>p.div).join(','));
console.log('240/0.5 single div:', G.generate({preset:'stream_single',bpm:240,difficulty:0.5,seed:'x'}).phrases.map(p=>p.div).join(','));

/* 无轨：按键不许叠、不许出界，且要真的用满二维 */
{
  let bad = 0;
  const seen = [];
  for (const key of G.PRESET_KEYS.concat(['mixed'])) {
    for (const size of [4, 6, 8, 10]) {
      for (const seed of ['a', 'b']) {
        const c = G.generate({ preset: key, free: true, freeSize: size, bpm: 200, seed, measures: 16 });
        if (c.warnings.length) { bad++; console.log('FREE WARN', key, size, seed, c.warnings.join(';')); }
        if (c.notes.some(n => typeof n.nx !== 'number' || typeof n.ny !== 'number')) {
          bad++; console.log('FREE 缺坐标', key, size, seed);
        }
        if (key === 'stream_single' && seed === 'a') {
          const ys = c.notes.map(n => n.ny);
          seen.push({ 按键: '1/' + size, 内部列数: c.keys,
                      不同x: new Set(c.notes.map(n => +n.nx.toFixed(4))).size,
                      y跨度: (Math.max(...ys) - Math.min(...ys)).toFixed(2) });
        }
      }
    }
  }
  console.table(seen);
  console.log('无轨用例失败', bad);
  if (bad) fails += bad;
}
console.log('总失败', fails);
process.exit(fails ? 1 : 0);
