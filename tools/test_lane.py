"""轨道模式（4K / 7K）端到端自检。

走真实路径：设置页选预设 → 开始训练 → 按谱面逐个击打 → 读结算页。
判定走引擎里的 _judgeInput，不是测试自己算的。

用法：先起静态服务，再跑本脚本。
    python3 -m http.server 8931 --bind 127.0.0.1 &
    python3 tools/test_lane.py
"""
import asyncio, json
from playwright.async_api import async_playwright

URL = 'http://127.0.0.1:8931/index.html'

# 页面内的机器人：每帧找到「此刻该打」的音符，按它的轨道敲一下
ROBOT = """
() => new Promise((done) => {
  const g = MG.game, ch = g.chart, hit = new Set();
  function tick() {
    if (g.state === 'finished') { done(true); return; }
    const now = g.chartTime(performance.now());
    for (let i = 0; i < ch.notes.length; i++) {
      const n = ch.notes[i];
      if (hit.has(i)) continue;
      if (n.t > now + 0.004) break;
      if (n.t < now - 0.05) { hit.add(i); continue; }
      hit.add(i);
      g.inputLane(n.col, performance.now(), 0.5);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})
"""

CASES = [
    ('4', 'trill', '位移交互·4 键'),
    ('7', 'stream', '双押海'),
    ('4', 'jack', '大叠'),
]


async def main():
    fails = []
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome',
                                    args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
        ctx = await b.new_context(viewport={'width': 1280, 'height': 800})
        pg = await ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto(URL)
        await pg.wait_for_timeout(700)

        boot = await pg.evaluate("""() => ({ready: !!MG.READY, build: MG.BUILD,
            err: MG.INIT_ERROR ? String(MG.INIT_ERROR) : null})""")
        print('启动:', json.dumps(boot, ensure_ascii=False))
        if not boot['ready']:
            fails.append('初始化没跑完: %s' % boot['err'])

        # 无轨只认触屏，桌面上必须是灰的
        if not await pg.evaluate("() => document.getElementById('keyFree').disabled"):
            fails.append('桌面上「无轨」没置灰')

        for keys, group, name in CASES:
            await pg.evaluate("""([k, grp, nm]) => {
                document.querySelector(`#keys button[data-v="${k}"]`).click();
                document.querySelector(`#groupTabs .tab[data-group="${grp}"]`).click();
                [...document.querySelectorAll('#presetGrid .preset')]
                  .find(b => b.querySelector('b').textContent === nm).click();
                const m = document.getElementById('measures');
                m.value = '8'; m.dispatchEvent(new Event('change'));
                const f = document.getElementById('autoFullscreen');
                f.checked = false; f.dispatchEvent(new Event('change'));
            }""", [keys, group, name])
            await pg.wait_for_timeout(400)
            await pg.click('#btnStart')
            await pg.wait_for_timeout(150)
            await pg.evaluate(ROBOT)
            await pg.wait_for_selector('#resultOverlay:not(.hidden)', timeout=60000)
            r = await pg.evaluate("""() => ({
                准确率: document.getElementById('resAcc').textContent,
                P: +document.getElementById('resP').textContent,
                G: +document.getElementById('resG').textContent,
                M: +document.getElementById('resM').textContent,
                总数: MG.game.chart.notes.length})""")
            r['用例'] = '%sK %s' % (keys, name)
            print(json.dumps(r, ensure_ascii=False))
            if r['P'] != r['总数'] or r['M']:
                fails.append('%s 逐个打准却没全中：P %d / 共 %d / miss %d'
                             % (r['用例'], r['P'], r['总数'], r['M']))
            await pg.click('#btnBack')
            await pg.wait_for_timeout(300)

        print('页面错误', errs)
        if errs:
            fails.append('页面报错 %s' % errs)
        await b.close()
    print('失败:', fails if fails else '无')
    raise SystemExit(1 if fails else 0)


asyncio.run(main())
