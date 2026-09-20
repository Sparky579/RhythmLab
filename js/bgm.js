/* BGM 定义
 * 「录音」组是从 Wikimedia Commons 取的公有领域 / CC 授权录音，按原速截取整数小节的循环段，
 *   署名与处理说明见 audio/CREDITS.md，界面上也会展示。
 * 「合成」组由 Web Audio 现场合成，不含外部素材：
 *   每个节奏型以 16 分音为一步，打击轨用 'x' 触发，'.' 休止；
 *   带 progression 的条目里，音高轨字符指「当前和弦的第几个音」。
 * baseBpm 是原速，谱面 BPM 会按 2 的幂次贴到它上面。
 */
(function (MG) {
  'use strict';

  /* 小调音阶，给没有和弦进行的合成 groove 用 */
  const NOTE_CHARS = {
    '0': 0, '1': 2, '2': 3, '3': 5, '4': 7, '5': 8, '6': 10, '7': 12, '8': 14, '9': 15,
  };
  /* 0/1/2 = 根音/三音/五音，3/4/5 = 高八度的同三个音，T = 整个三和弦 */
  const CHORD_CHARS = {
    '0': [[0, 0]], '1': [[1, 0]], '2': [[2, 0]],
    '3': [[0, 12]], '4': [[1, 12]], '5': [[2, 12]],
    'T': [[0, 0], [1, 0], [2, 0]],
    'U': [[0, 0], [1, 0], [2, 0], [0, 12]],
  };
  function chordTones(ch) {
    const third = ch.q === 'min' ? 3 : 4;
    return [ch.r, ch.r + third, ch.r + 7];
  }
  const maj = (r) => ({ r, q: 'maj' });
  const min = (r) => ({ r, q: 'min' });

  const BGMS = [
    {
      id: 'metro', group: '基础', name: '节拍器', kind: 'metro',
      desc: '只有咔哒声，最适合抠准度',
    },
    {
      id: 'none', group: '基础', name: '无声', kind: 'none',
      desc: '什么都不放',
    },
    {
      id: 'canon_rec', group: '录音', name: '卡农 · 160', kind: 'file', baseBpm: 160,
      url: 'audio/canon-loop.ogg', loopBars: 8,
      desc: '帕赫贝尔《D大调卡农》，八小节循环，最耐听',
      credit: 'Kevin MacLeod，CC BY 3.0',
      creditUrl: 'https://commons.wikimedia.org/wiki/File:Kevin_MacLeod_-_Canon_in_D_Major.ogg',
    },
    {
      id: 'elise_rec', group: '录音', name: '致爱丽丝 · 72', kind: 'file', baseBpm: 72,
      url: 'audio/elise-loop.ogg', loopBars: 4,
      desc: '贝多芬《致爱丽丝》，慢速，适合抠准度',
      credit: 'Ludwig van Beethoven，CC BY-SA 2.5',
      creditUrl: 'https://commons.wikimedia.org/wiki/File:Beethoven_F%C3%BCr_Elise_Rondo.ogg',
    },
    {
      id: 'moonlight_rec', group: '录音', name: '月光 · 75', kind: 'file', baseBpm: 75,
      url: 'audio/moonlight-loop.ogg', loopBars: 4,
      desc: '贝多芬《月光奏鸣曲》，安静，干扰最小',
      credit: '见来源页，CC BY-SA 3.0',
      creditUrl: 'https://commons.wikimedia.org/wiki/File:Beethoven_Moonlight_sonata_sequenced.ogg',
    },
    {
      id: 'joy_rec', group: '录音', name: '欢乐颂 · 100', kind: 'file', baseBpm: 100,
      url: 'audio/joy-loop.ogg', loopBars: 4,
      desc: '贝多芬《欢乐颂》，明亮，适合长时间练习',
      credit: 'Ludwig van Beethoven，Public domain',
      creditUrl: 'https://commons.wikimedia.org/wiki/File:Ode_to_Joy.ogg',
    },
    {
      id: 'turkish_rec', group: '录音', name: '土耳其进行曲 · 120', kind: 'file', baseBpm: 120,
      url: 'audio/turkish-loop.ogg', loopBars: 8,
      desc: '莫扎特土耳其进行曲，轻快，冲高速谱用',
      credit: 'Wolfgang Amadeus Mozart，Public domain',
      creditUrl: 'https://commons.wikimedia.org/wiki/File:Rondo_Alla_Turka.ogg',
    },
    {
      id: 'kick_rec', group: '节奏激昂', name: 'Kick Shock · 138', kind: 'file', baseBpm: 138,
      url: 'audio/kick-loop.ogg', loopBars: 8,
      desc: '合成鼓 + 亮色琶音，节奏感最强',
      credit: 'Kevin MacLeod（incompetech.com），CC BY 4.0',
      creditUrl: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100523',
    },
    {
      id: 'club_rec', group: '节奏激昂', name: 'Club Diver · 140', kind: 'file', baseBpm: 140,
      url: 'audio/club-loop.ogg', loopBars: 8,
      desc: '重拍电子，鼓点扎实，最像正经音游曲',
      credit: 'Kevin MacLeod（incompetech.com），CC BY 4.0',
      creditUrl: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1200020',
    },
    {
      id: 'blown_rec', group: '节奏激昂', name: 'Blown Away · 170', kind: 'file', baseBpm: 170,
      url: 'audio/blown-loop.ogg', loopBars: 8,
      desc: '高速合成器，适合冲高 BPM 的切和交互',
      credit: 'Kevin MacLeod（incompetech.com），CC BY 4.0',
      creditUrl: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1200100',
    },
    {
      id: 'rawk_rec', group: '节奏激昂', name: 'Summon the Rawk · 209', kind: 'file', baseBpm: 209,
      url: 'audio/rawk-loop.ogg', loopBars: 8,
      desc: '吉他贝斯鼓，速度最快，配散打很带劲',
      credit: 'Kevin MacLeod（incompetech.com），CC BY 4.0',
      creditUrl: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1200050',
    },
    {
      id: 'lofi_rec', group: '舒缓', name: 'Late Night Radio · 72', kind: 'file', baseBpm: 72,
      url: 'audio/lofi-loop.ogg', loopBars: 4,
      desc: '电钢 + 贝斯的深夜 lo-fi，最放松',
      credit: 'Kevin MacLeod（incompetech.com），CC BY 4.0',
      creditUrl: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN2100003',
    },
    {
      id: 'dream_rec', group: '舒缓', name: 'Dream Culture · 70', kind: 'file', baseBpm: 70,
      url: 'audio/dream-loop.ogg', loopBars: 4,
      desc: '钢琴铺底，几乎没有压迫感',
      credit: 'Kevin MacLeod（incompetech.com），CC BY 4.0',
      creditUrl: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1300046',
    },
    {
      id: 'interstellar_rec', group: '舒缓', name: 'Canon 星际混音 · 96', kind: 'file', baseBpm: 96,
      url: 'audio/interstellar-loop.ogg', loopBars: 4,
      desc: '卡农的合成器慢版，和录音组那条同源',
      credit: 'Kevin MacLeod（incompetech.com），CC BY 4.0',
      creditUrl: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN2000018',
    },
    {
      id: 'carefree_rec', group: '舒缓', name: 'Carefree · 96', kind: 'file', baseBpm: 96,
      url: 'audio/carefree-loop.ogg', loopBars: 4,
      desc: '尤克里里 + 马林巴，轻快不吵',
      credit: 'Kevin MacLeod（incompetech.com），CC BY 4.0',
      creditUrl: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1400037',
    },
    {
      id: 'inspired_rec', group: '舒缓', name: 'Inspired · 120', kind: 'file', baseBpm: 120,
      url: 'audio/inspired-loop.ogg', loopBars: 8,
      desc: '吉他加合成器，舒缓里带点推进力',
      credit: 'Kevin MacLeod（incompetech.com），CC BY 4.0',
      creditUrl: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1600022',
    },
    {
      id: 'house', group: '合成节奏型', name: '电子鼓 · 128', kind: 'groove', baseBpm: 128,
      desc: '四踩底鼓 + 反拍开镲，节拍感最明确',
      drums: {
        kick:  'x...x...x...x...x...x...x...x...',
        clap:  '....x.......x.......x.......x...',
        hat:   '..x...x...x...x...x...x...x...x.',
      },
      tones: {
        bass: { seq: '0.......0...0...3.......3...3...', octave: -12, gain: 0.5 },
      },
    },
    {
      id: 'dnb', group: '合成节奏型', name: '鼓打贝斯 · 174', kind: 'groove', baseBpm: 174,
      desc: '碎拍鼓组 + 长贝斯，适合高速切',
      drums: {
        kick:  'x.......x.....x.x.......x.......',
        snare: '....x.......x.......x.......x...',
        hat:   'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.',
      },
      tones: {
        bass: { seq: '0...............4...............', octave: -12, gain: 0.55 },
      },
    },
    {
      id: 'chip', group: '合成节奏型', name: '芯片音乐 · 150', kind: 'groove', baseBpm: 150,
      desc: '方波琶音，读谱时不容易走神',
      drums: {
        kick:  'x.......x.......x.......x.......',
        snare: '....x.......x.......x.......x...',
        hat:   '..x...x...x...x...x...x...x...x.',
      },
      tones: {
        arp:  { seq: '0.4.7.4.0.4.7.4.3.7.9.7.3.7.9.7.', octave: 0, gain: 0.3 },
        bass: { seq: '0.......0.......3.......3.......', octave: -12, gain: 0.45 },
      },
    },
    {
      id: 'pulse', group: '合成节奏型', name: '极简脉冲 · 120', kind: 'groove', baseBpm: 120,
      desc: '接近节拍器但更好听，干扰最小',
      drums: {
        kick:  'x...x...x...x...x...x...x...x...',
        hat:   '....x.......x.......x.......x...',
      },
      tones: {},
    },
    {
      /* I–V–vi–IV，和弦进行本身不受版权保护 */
      id: 'pop4', group: '合成和弦', name: '四和弦 · 120', kind: 'groove', baseBpm: 120,
      desc: '最常见的四小节进行，任何速度都跟得住',
      progression: [maj(0), maj(7), min(9), maj(5)],
      drums: {
        kick: 'x...x...x...x...',
        clap: '....x.......x...',
        hat:  '..x...x...x...x.',
      },
      tones: {
        pad:  { seq: 'T.......T.......', octave: -12, gain: 0.17 },
        arp:  { seq: '..3...4...3...4.', octave: 0, gain: 0.22 },
        bass: { seq: '0...0...2...0...', octave: -12, gain: 0.5 },
      },
    },
    {
      /* i–VI–III–VII 小调循环 */
      id: 'minor4', group: '合成和弦', name: '小调循环 · 140', kind: 'groove', baseBpm: 140,
      desc: '暗一点的四和弦循环，任何速度都跟得住',
      progression: [min(0), maj(8), maj(3), maj(10)],
      drums: {
        kick:  'x...x..xx...x...',
        snare: '....x.......x...',
        hat:   'x.x.x.x.x.x.x.x.',
      },
      tones: {
        pad:  { seq: 'T...............', octave: -12, gain: 0.16 },
        arp:  { seq: '0.2.1.2.0.2.1.2.', octave: 0, gain: 0.22 },
        bass: { seq: '0.0.0...0.0.2...', octave: -12, gain: 0.5 },
      },
    },
  ];

  const BY_ID = {};
  for (const b of BGMS) BY_ID[b.id] = b;

  /* 把 BPM 贴到原速的 2 的幂次上：原速 128 → 32/64/128/256 都合适 */
  function snapBpm(bpm, baseBpm) {
    if (!baseBpm) return bpm;
    const k = Math.round(Math.log2(bpm / baseBpm));
    const v = baseBpm * Math.pow(2, Math.max(-3, Math.min(3, k)));
    return Math.max(40, Math.min(400, Math.round(v)));
  }
  /* 该 BPM 下 groove 要按几倍速率折算：返回 2 的幂，>1 表示谱面比原速快 */
  function tempoRatio(bpm, baseBpm) {
    if (!baseBpm) return 1;
    const k = Math.max(-2, Math.min(3, Math.round(Math.log2(bpm / baseBpm))));
    return Math.pow(2, k);
  }
  function suggestBpms(baseBpm) {
    const out = [];
    for (let k = -2; k <= 2; k++) {
      const v = Math.round(baseBpm * Math.pow(2, k));
      if (v >= 40 && v <= 400) out.push(v);
    }
    return out;
  }

  MG.BGMS = BGMS;
  MG.BGM_BY_ID = BY_ID;
  MG.BGM_NOTES = NOTE_CHARS;
  MG.BGM_CHORD_CHARS = CHORD_CHARS;
  MG.bgmChordTones = chordTones;
  MG.bgmSnapBpm = snapBpm;
  MG.bgmTempoRatio = tempoRatio;
  MG.bgmSuggestBpms = suggestBpms;
})(window.MG = window.MG || {});
