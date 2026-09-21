import asyncio, json, math, struct, io, wave, random
from playwright.async_api import async_playwright

def make_wav(bpm=128, secs=16, sr=22050):
    n = sr*secs; buf=bytearray()
    per = 60/bpm*sr
    samples=[0.0]*n
    k=0; t=0.0
    while t < n:
        st=int(t); dur=int(sr*0.05)
        for i in range(dur):
            if st+i>=n: break
            env=math.exp(-i/(sr*0.012))
            noise=random.random()*2-1
            samples[st+i]+= env*(0.9*(0.7*math.sin(2*math.pi*60*i/sr)+0.3*noise) if k%2==0
                                 else 0.8*(0.3*math.sin(2*math.pi*190*i/sr)+0.7*noise))
        t+=per; k+=1
    for i in range(n): samples[i]+=0.08*math.sin(2*math.pi*220*i/sr)
    out=io.BytesIO()
    with wave.open(out,'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(b''.join(struct.pack('<h', max(-32767,min(32767,int(s*20000)))) for s in samples))
    return out.getvalue()

async def main():
    data = make_wav()
    open('/tmp/test_bgm.wav','wb').write(data)
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',
            args=['--no-sandbox','--autoplay-policy=no-user-gesture-required'])
        pg=await b.new_page(viewport={'width':900,'height':700})
        errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto('http://127.0.0.1:8931/index.html'); await pg.wait_for_timeout(800)
        await pg.evaluate("MG.game.audio.ensure()")
        await pg.set_input_files('#bgmFile', '/tmp/test_bgm.wav')
        await pg.wait_for_selector('#bgmConfirm:not(.hidden)', timeout=20000)
        info = await pg.evaluate("""() => ({
            名称: document.getElementById('bgmcName').textContent,
            测得BPM: document.getElementById('bgmcBpm').value,
            起拍ms: document.getElementById('bgmcOff').value })""")
        print('确认面板:', json.dumps(info,ensure_ascii=False))
        await pg.click('#bgmcSave')
        await pg.wait_for_function("() => document.getElementById('bgmConfirm').classList.contains('hidden')", timeout=10000)
        after = await pg.evaluate("""() => ({
            选中: document.getElementById('bgm').value,
            下拉里有: [...document.querySelectorAll('#bgm optgroup')].map(g=>g.label),
            我的音乐条数: document.querySelectorAll('#myBgmList .my-bgm-row').length,
            管理按钮: !document.getElementById('btnManageBgm').classList.contains('hidden') })""")
        print('保存后:', json.dumps(after,ensure_ascii=False))
        # 刷新后仍在
        await pg.reload(); await pg.wait_for_timeout(1200)
        persisted = await pg.evaluate("""() => ({
            选中: document.getElementById('bgm').value,
            条数: document.querySelectorAll('#myBgmList .my-bgm-row').length,
            条目名: [...document.querySelectorAll('#myBgmList .my-bgm-row span')].map(e=>e.textContent) })""")
        print('刷新后:', json.dumps(persisted,ensure_ascii=False))
        # 删除
        pg.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
        await pg.click('#btnManageBgm')
        await pg.click('#myBgmList .my-bgm-row .link')
        await pg.wait_for_timeout(800)
        gone = await pg.evaluate("""() => ({
            条数: document.querySelectorAll('#myBgmList .my-bgm-row').length,
            选中: document.getElementById('bgm').value })""")
        print('删除后:', json.dumps(gone,ensure_ascii=False))
        print('错误', errs)
        await b.close()
asyncio.run(main())
