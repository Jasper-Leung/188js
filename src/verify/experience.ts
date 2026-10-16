import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DayClock, clockSettings, daylightAt } from '../core/dayClock';
import { BUSINESS_RULES as R } from '../data/business';
import { actBusiness, advanceBusiness, newBusiness, readBusiness, claimBusinessStory } from '../game/business';
import { GameStateManager, type SaveStore } from '../game/state';
import { ruralPlan } from '../world/rural';
import { STATIONS, distToCenterline } from '../data/route';
import { stationStretch } from '../world/stations';
import { Sky } from '../world/sky';
import { Scene } from 'three';
import { expect, stripComments } from './harness';
import type { Check } from './entry';
export function registerExperienceChecks(check: (name: string, run: Check['run']) => void): void {
  check('verify_business_loop', () => {
    const s = newBusiness(); let coins=0, asserts=0; const bad:string[]=[];
    const assert=(ok:boolean,message:string)=>{asserts++;if(!ok)bad.push(message);};
    const act=(id:string,a:Parameters<typeof actBusiness>[2])=>{const r=actBusiness(s,id,a,coins,false);coins=r.coins;return r;};
    assert(!act('lantern','gather').ok,'锁定建筑不能领料');
    assert(!act('provisions','craft').ok,'不能无原料加工');
    for(let i=0;i<10;i++){
      const id = i < 3 ? 'provisions' : ['provisions','tea','lantern'][i%3];
      if(s.sites[id].raw<R.craftCost){advanceBusiness(s,R.gatherCooldown);assert(act(id,'gather').ok,'备料可重复');}
      assert(act(id,'craft').ok,'加工可用'); assert(act(id,'accept').ok,'接单可用');
      assert(!act(id,'deliver').ok,'服务中不能提前领钱');
      const old=coins;advanceBusiness(s,30);assert(act(id,'deliver').ok&&coins>old,'交付入账');
      assert(!act(id,'deliver').ok,'不能重复领取同单');
      if(i===1||i===5)assert(act('provisions','upgrade').ok,'赚取的钱可以升级');
    }
    assert(s.completed===10&&s.reputation===20,'订单与口碑正确');
    assert(s.chapter===3,'原主线未完成时经营结局保持等待');
    assert(claimBusinessStory(s,true)===4,'原主线完成后触发经营收束');
    assert(claimBusinessStory(s,true)===0,'剧情不重复');
    const v=s.sites.provisions; advanceBusiness(s,30);act('provisions','gather');act('provisions','craft');
    const stock=v.goods;act('provisions','accept');act('provisions','cancel');assert(v.goods===stock&&!v.order,'取消退还产品');
    assert(!act('unknown','gather').ok,'未知建筑无入口');
    assert(readBusiness({sites:{tea:{level:Infinity,raw:-4,goods:NaN}},reputation:-1}).sites.tea.level===1,'坏存档数值消毒');
    return expect(!bad.length,bad.join('；')||`10 单闭环、三建筑、升级、四段剧情；余款 ${coins}`,asserts);
  });
  check('verify_business_save',()=>{
    const map=new Map<string,string>();const store:SaveStore={read:k=>map.get(k)??null,write:(k,v)=>{map.set(k,v);},remove:k=>{map.delete(k);}};
    const a=new GameStateManager(store);a.lvbi=71;a.prologueDone=true;
    a.businessAct('tea','gather');a.businessAct('tea','craft');a.businessAct('tea','accept');a.tickBusiness(5);a.save();
    const b=new GameStateManager(store);const loaded=b.load();
    const data=JSON.parse([...map.values()][0]);delete data.business;store.write([...map.keys()][0],JSON.stringify(data));
    const c=new GameStateManager(store);const oldLoaded=c.load();
    const bad:string[]=[];
    if(!loaded||b.lvbi!==71||!b.prologueDone)bad.push('新档原进度丢失');
    if(b.business.sites.tea.order?.remaining!==9)bad.push('订单剩余时间未落盘');
    if(!oldLoaded||c.lvbi!==71||!c.prologueDone||c.business.completed!==0)bad.push('老档兼容失败');
    b.reset();if(b.business.sites.tea.order||b.business.reputation)bad.push('新旅程没有重置经营');
    return expect(!bad.length,bad.join('；')||'v3 老档兼容、经营往返、重开隔离',4);
  });
  check('verify_day_clock',()=>{
    let asserts=0;const bad:string[]=[];const a=(ok:boolean,m:string)=>{asserts++;if(!ok)bad.push(m);};
    const c=new DayClock();c.tick(75);a(Math.abs(c.hour-14)<1e-6,'75 秒推进六小时');c.tick(225);a(Math.abs(c.hour-8)<1e-6,'300 秒完整循环');
    c.configure({paused:true});c.tick(30);a(c.hour===8,'暂停不推进');c.configure({fixedHour:22});a(c.hour===22,'固定时刻优先');
    c.configure({fixedHour:null,paused:false,mode:'realtime',offsetHours:2});c.tick(0,new Date(2026,9,16,5,30,0));a(c.hour===7.5,'现实同步和偏移');
    const b=clockSettings({cycleSeconds:NaN,speed:Infinity,fixedHour:NaN});a(b.cycleSeconds===300&&b.speed===1&&b.fixedHour===null,'坏设置有默认值');
    const sky=new Sky(new Scene(),0,0);
    for(const hour of [0,5,8,12,18,22,24]){sky.setHour(hour);const d=daylightAt(hour);a(Number.isFinite(sky.sun.intensity)&&sky.sun.intensity>=0,'光强有效');a(Math.abs(sky.night-d.night)<1e-9,'路灯与天空同源');a(!sky.sun.castShadow,'最低档不投影');}
    sky.setHour(0);a(sky.night>.99&&sky.hemi.intensity>0,'夜晚可见');sky.setHour(12);a(sky.night===0&&sky.sun.intensity>2,'中午明亮');
    return expect(!bad.length,bad.join('；')||'24h 环、现实时间、暂停、固定时间、低档光照',asserts);
  });
  check('verify_rural_plan',()=>{
    const p=ruralPlan(),again=ruralPlan();let asserts=0;const bad:string[]=[];const a=(ok:boolean,m:string)=>{asserts++;if(!ok)bad.push(m);};
    a(JSON.stringify(p)===JSON.stringify(again),'同种子可重现');a(JSON.stringify(p)!==JSON.stringify(ruralPlan(7)),'种子改变田地');
    a(p.filter(v=>v.kind==='lamp').length>20,'足够沿路灯具');a(p.length<900,'实例数预算');
    for(const v of p){a(distToCenterline(v.x,v.z)>7.4,'设施不挡路');a(!STATIONS.some(s=>Math.hypot(v.x-s.x,v.z-s.z)<10),'设施避让建筑');}
    const [x,y]=stationStretch(2);a(x===y,'琴音林等比缩放');
    return expect(!bad.length,bad.slice(0,8).join('；')||`${p.length} 个确定性设施/田垄；路肩与建筑让位`,asserts);
  });
  check('verify_experience_wiring',()=>{
    const src=(n:string)=>stripComments(readFileSync(join(process.cwd(),'src',n),'utf8'));
    const bad:string[]=[];let asserts=0;const a=(ok:boolean,m:string)=>{asserts++;if(!ok)bad.push(m);};
    const main=src('main.ts'),ui=src('ui/businessPanel.ts'),touch=src('ui/touchControls.ts');
    const timeout=main.slice(main.indexOf('function withTimeout'),main.indexOf('function nextFrame'));
    a(timeout.includes('.finally(')&&timeout.includes('clearTimeout(timer)'), '资产完成后必须取消告警定时器，不能每次启动都误报超时');
    a(main.includes('this.business?.isOpen || screen.panelOpen'),'AI 观测识别经营面板');
    a(main.includes('game.tickBusiness(dt)')&&main.includes('this.business?.update('),'经营有运行时接线');
    a(main.slice(main.indexOf('  pause()'),main.indexOf('  resume()')).includes('this.ui.setWorldChromeVisible(false)'), '暂停必须收起触控与道具，避免拦截菜单');
    a(main.slice(main.indexOf('private toRoaming()'),main.indexOf('  pause()')).includes('this.ui.setWorldChromeVisible(true)'), '继续骑行恢复触控');
    a(main.slice(main.indexOf('private goPhase('),main.indexOf('  async ready()')).includes('this.business?.hideEntry()'), '离开骑行立即隐藏经营入口，不能依赖暂停后的 fixed');
    a(ui.includes("t('qin_option_game')")&&ui.includes("t('qin_option_free')"),'双琴入口独立');
    a(main.includes("this.mg.run('zither'")&&main.includes("this.mg.runFreePlay('qin'"),'双琴进入不同游戏');
    a(src('world/world.ts').includes('QIN_STATION = 13')&&main.includes('QIN_STATION = 13'),'琴音林实际第 13 站');
    a(touch.includes("codeOf('vehicle')")&&touch.includes("new KeyboardEvent('keyup'"),'触控换车复用重映射并松键');
    a(touch.includes("'orientationchange', dropAll"),'旋转释放触控');
    a(src('ui/lakesidePanel.ts').includes("'lake_panorama_fallback'"),'XR 不支持有普通全景说明');
    const css = readFileSync(join(process.cwd(),'src/index.css'),'utf8');
    a(/#ui-root\s*>\s*:not\(\.g-root\)\s*\{\s*pointer-events:\s*auto/.test(css), '宿主不得把全屏 HUD 改成可点击：会吞掉湖边拖动');
    a(!src('world/rural.ts').includes('PointLight'),'乡村设施不添加实时点光');
    return expect(!bad.length,bad.join('；')||'新入口、双琴、触控、时钟与相位接线',asserts);
  });
}
