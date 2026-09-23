"""无轨 / 点圈端到端自检。

跑真实路径：设置页选模式 → 开始 → 按谱面坐标在 canvas 上派发 inputPoint。
判定走引擎里的 _findNoteAt，不是测试自己算的。

无轨是下落式、只看横坐标（纵向位置由时间决定，屏幕上哪儿点都行）；
点圈是二维的，得真点到那个圈上。

用法：先起静态服务，再跑本脚本。
    python3 -m http.server 8931 --bind 127.0.0.1 &
    python3 tools/test_free.py
"""
import asyncio, json
from playwright.async_api import async_playwright

URL = 'http://127.0.0.1:8931/index.html'

# 页面内的机器人：每帧找到「此刻该打」的音符，按它的屏幕坐标点一下。
# offsetPx 用来故意点偏，验证打空确实判不中。
ROBOT = """
(offsetPx) => new Promise((done) => {
  const g = MG.game, ch = g.chart;
  const r = g.canvas.getBoundingClientRect();
  const hit = new Set();
  let taps = 0;
  function tick() {
    if (g.state === 'finished') { done({ taps }); return; }
    const now = g.chartTime(performance.now());
    for (let i = 0; i < ch.notes.length; i++) {
      const n = ch.notes[i];
      if (hit.has(i)) continue;
      if (n.t > now + 0.004) break;
      if (n.t < now - 0.05) { hit.add(i); continue; }
      hit.add(i);
      const x = r.left + g.fieldX0 + n.nx * g.fieldW + offsetPx;
      // 无轨只看横坐标，纵向随便点（这里点在判定线上）；点圈得点到圈心
      const y = g.circle ? r.top + g.fieldY0 + n.ny * g.fieldH : r.top + g.judgePx;
      g.inputPoint(x, y, performance.now());
      taps++;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})
"""


async def run_once(pg, offset_px, label):
    await pg.click('#btnStart')
    await pg.wait_for_timeout(200)
    res = await pg.evaluate(ROBOT, offset_px)
    await pg.wait_for_selector('#resultOverlay:not(.hidden)', timeout=60000)
    out = await pg.evaluate("""() => ({
        准确率: document.getElementById('resAcc').textContent,
        P: +document.getElementById('resP').textContent,
        G: +document.getElementById('resG').textContent,
        M: +document.getElementById('resM').textContent,
        总数: MG.game.chart.notes.length })""")
    out['用例'] = label
    out['派发'] = res['taps']
    await pg.click('#btnBack')
    await pg.wait_for_timeout(300)
    return out


async def check_mode(pg, mode, name, fails):
    await pg.evaluate("""(m) => {
        document.querySelector(`#keys button[data-v="${m}"]`).click();
        const s = document.getElementById('measures');
        s.value = '8'; s.dispatchEvent(new Event('change'));
        const f = document.getElementById('autoFullscreen');
        f.checked = false; f.dispatchEvent(new Event('change'));
        const b = document.getElementById('bpm');
        b.value = 150; b.dispatchEvent(new Event('input'));
    }""", mode)
    await pg.wait_for_timeout(400)
    shape = await pg.evaluate("""(m) => {
        const c = MG.Generator.generate({preset:'stream_single',mode:m,freeSize:6,
                                         bpm:150,seed:'t',measures:8});
        return { 内部列数: c.keys, 音符宽: +c.noteD.toFixed(3),
                 有纵坐标: typeof c.notes[0].ny === 'number', 警告: c.warnings };
    }""", mode)
    print(name, '生成:', json.dumps(shape, ensure_ascii=False))

    rows = [await run_once(pg, 0, name + ' 点准')]
    # 偏出一整个音符宽：必须一下都判不中
    off = await pg.evaluate("() => MG.game.noteW + 20")
    rows.append(await run_once(pg, off, name + ' 点偏一个音符宽'))
    for r in rows:
        print(' ', json.dumps(r, ensure_ascii=False))
    good, bad = rows
    if good['P'] != good['总数'] or good['M']:
        fails.append('%s 点准了却没全中：P %d / 共 %d / miss %d'
                     % (name, good['P'], good['总数'], good['M']))
    if bad['P'] or bad['G'] or bad['M'] != bad['总数']:
        fails.append('%s 点偏了仍被判中：P %d G %d miss %d / 共 %d'
                     % (name, bad['P'], bad['G'], bad['M'], bad['总数']))


async def main():
    fails = []
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome',
                                    args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
        # has_touch 让 pointer: coarse 成立，这两个模式才允许选
        ctx = await b.new_context(viewport={'width': 880, 'height': 420},
                                  has_touch=True, is_mobile=True)
        pg = await ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto(URL)
        await pg.wait_for_timeout(600)

        for bid, label in [('keyFree', '无轨'), ('keyCircle', '点圈')]:
            if await pg.evaluate("(id) => document.getElementById(id).disabled", bid):
                fails.append('触屏设备上「%s」被置灰' % label)

        await check_mode(pg, 'free', '无轨', fails)
        await check_mode(pg, 'circle', '点圈', fails)

        print('页面错误', errs)
        if errs:
            fails.append('页面报错 %s' % errs)
        await b.close()
    print('失败:', fails if fails else '无')
    raise SystemExit(1 if fails else 0)


asyncio.run(main())
