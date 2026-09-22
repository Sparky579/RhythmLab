"""无轨模式端到端自检。

跑真实路径：设置页选「无轨」→ 开始 → 按谱面坐标在 canvas 上派发 inputPoint。
判定走的是引擎里的 _findNoteAt，不是测试自己算的。
"""
import asyncio, json
from playwright.async_api import async_playwright

URL = 'http://127.0.0.1:8931/index.html'

# 页面内的机器人：每帧找到「此刻该打」的音符，按它的屏幕坐标点一下。
# offset 用来故意点偏，验证打空确实会判空。
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
      const x = r.left + g.freeX0 + n.nx * g.freeW + offsetPx;
      const y = r.top + g.freeY0 + n.ny * g.freeH;
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
        打空: MG.game.emptyTaps, 击打: MG.game.taps })""")
    out['用例'] = label
    out['派发'] = res['taps']
    await pg.click('#btnBack')
    await pg.wait_for_timeout(300)
    return out

async def main():
    fails = []
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome',
                                    args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
        # has_touch 让 pointer: coarse 成立，「无轨」才允许选
        ctx = await b.new_context(viewport={'width': 880, 'height': 420}, has_touch=True, is_mobile=True)
        pg = await ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto(URL)
        await pg.wait_for_timeout(600)

        enabled = await pg.evaluate("() => !document.getElementById('keyFree').disabled")
        print('触屏设备上「无轨」可选:', enabled)
        if not enabled: fails.append('无轨在触屏设备上被置灰')

        await pg.evaluate("""() => {
            document.querySelector('#keys button[data-v=free]').click();
            document.getElementById('measures').value = '8';
            document.getElementById('measures').dispatchEvent(new Event('change'));
            document.getElementById('autoFullscreen').checked = false;
            document.getElementById('autoFullscreen').dispatchEvent(new Event('change'));
            document.getElementById('bpm').value = 150;
            document.getElementById('bpm').dispatchEvent(new Event('input'));
        }""")
        await pg.wait_for_timeout(400)
        chart = await pg.evaluate("""() => {
            const c = MG.Generator.generate({preset:'stream_single',free:true,freeSize:6,bpm:150,seed:'t',measures:8});
            return { 内部列数: c.keys, 按键直径: +c.noteD.toFixed(3), 音符: c.notes.length, 警告: c.warnings };
        }""")
        print('生成检查:', json.dumps(chart, ensure_ascii=False))

        rows = []
        rows.append(await run_once(pg, 0, '点准位置'))
        # 偏出一个按键直径：必须全部打空
        d = await pg.evaluate("() => MG.game.freeR * 2 + 20")
        rows.append(await run_once(pg, d, '故意点偏一个按键'))

        for r in rows: print(json.dumps(r, ensure_ascii=False))
        good, bad = rows[0], rows[1]
        if good['M'] > good['P'] * 0.02:
            fails.append('点准了还 miss %d 个' % good['M'])
        if good['打空'] > 2:
            fails.append('点准了却打空 %d 次' % good['打空'])
        if bad['打空'] < bad['击打'] * 0.95:
            fails.append('点偏了仍被判中：打空 %d / 击打 %d' % (bad['打空'], bad['击打']))
        print('页面错误', errs)
        if errs: fails.append('页面报错 %s' % errs)
        await b.close()
    print('失败:', fails if fails else '无')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
