import asyncio
import os
import sys
VP={"width":int(sys.argv[1]),"height":int(sys.argv[2])}; TOUCH=sys.argv[3]=="1"; OUT=sys.argv[4]
from playwright.async_api import async_playwright
MOCK = r"""
(() => {
 const now = Math.floor(Date.now()/1000/60)*60; let p0 = 74500;
 const rows=[]; let p=p0; for(let i=0;i<300;i++){const t=now-i*60; const o=p, c=p+(Math.random()-0.5)*60; rows.push([t,Math.min(o,c)-10,Math.max(o,c)+10,o,c,Math.random()*20]); p=o-(c-o);} 
 window.fetch = async () => ({ok:true, json: async()=>rows});
 class FakeWS { constructor(url){ this.url=url; if(!String(url).includes("coinbase")) return; setTimeout(()=>{this.onopen&&this.onopen(); this.start();},50);} send(){} close(){}
  start(){ const up=[]; for(let i=1;i<3000;i++){ const bp=(p0-i*0.5).toFixed(2), ap=(p0+i*0.5).toFixed(2);
     let bq=Math.random()*0.3, aq=Math.random()*0.3; if(Math.abs(p0-i*0.5-74200)<1) bq=40; if(Math.abs(p0+i*0.5-75000)<1) aq=38; if(Math.abs(p0+i*0.5-74800)<1) aq=15;
     up.push({side:"bid",price_level:bp,new_quantity:String(bq)}); up.push({side:"offer",price_level:ap,new_quantity:String(aq)});}
   this.onmessage({data:JSON.stringify({channel:"l2_data",events:[{type:"snapshot",updates:up}]})});
   setInterval(()=>{ const px=(p0+(Math.random()-0.5)*40).toFixed(2); this.onmessage({data:JSON.stringify({channel:"market_trades",events:[{type:"update",trades:[{price:px,size:"0.1",side:"BUY",time:new Date().toISOString()}]}]})}); },200);
  } }
 window.WebSocket = FakeWS;
})();
"""
async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(**({"executable_path": os.environ["CHROME"]} if os.environ.get("CHROME") else {}), args=["--no-sandbox"])
        pg = await b.new_page(viewport=VP, has_touch=TOUCH, is_mobile=TOUCH)
        errs=[]; pg.on("console", lambda m: errs.append(m.type+": "+m.text) if m.type in ("error","warning") else None)
        pg.on("pageerror", lambda e: errs.append("pageerror "+str(e)))
        await pg.add_init_script(MOCK)
        await pg.goto("file://" + os.path.abspath(os.path.join(os.path.dirname(__file__), "../../walls/index.html")))
        await pg.wait_for_timeout(6000)
        fps = await pg.evaluate("new Promise(r=>{let n=0;const t0=performance.now();(function f(){n++; if(performance.now()-t0<2000) requestAnimationFrame(f); else r(n/2)})()})")
        print('fps', fps)
        await pg.mouse.move(400,300); await pg.mouse.wheel(0,-300); await pg.wait_for_timeout(600)
        if len(sys.argv)>5 and sys.argv[5]=="k":
            await pg.click('#srcSeg button[data-src="kalshi"]'); await pg.wait_for_timeout(2500)
        await pg.mouse.move(500, 300)
        await pg.wait_for_timeout(400)
        await pg.screenshot(path=OUT)
        print(errs)
        await b.close()
asyncio.run(main())
