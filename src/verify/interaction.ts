import { readFileSync } from 'node:fs';
import { Dialogue, dialogueLines } from '../ui/dialogue';
import { StoryCards } from '../ui/storyCard';
import { HudVisibility } from '../ui/visibility';
import { bindTouchButtons } from '../ui/dom';
import { ItemBar } from '../ui/itemBar';
import { World } from '../world/world';
import { lampHaloTexture } from '../world/rural';
import { drawBackdrop, hex } from '../game/minigames/chrome';
import { Vector3 } from 'three';
import { expect, fakeCtx, type CheckFn } from './harness';

export function registerInteractionChecks(check: CheckFn, parent: () => HTMLElement): void {
  check('verify_dialogue_jump_click', () => {
    let n=0;const bad:string[]=[];const a=(ok:boolean,s:string)=>{n++;if(!ok)bad.push(s);};
    const host=parent(), dlg=new Dialogue(host);
    const sections=[['1.1','1.2','1.3'],['2.1','2.2','2.3'],['3.1','3.2','3.3']];
    a(dialogueLines(sections).length===9,'all paragraph lines retained');
    void dlg.show('speaker',sections);
    host.querySelector<HTMLButtonElement>('.g-dlg-skip')!.click();
    a(host.querySelector('.g-dlg-text')!.textContent==='3.3','real skip button lands on paragraph 3 line 3');
    a(dlg.active,'last line remains readable');
    host.querySelector<HTMLButtonElement>('.g-dlg-next')!.click();
    a(!dlg.active,'next completes last line');
    void dlg.show('', ['one line']);host.querySelector<HTMLButtonElement>('.g-dlg-skip')!.click();
    a(dlg.active&&host.querySelector('.g-dlg-text')!.textContent==='one line','typing last line is revealed before completion');
    dlg.hide();
    for (const branch of ['minigame','synthesis']) {
      let entered=0;void dlg.show(branch,sections,()=>{entered++;});
      const skip=host.querySelector<HTMLButtonElement>('.g-dlg-skip')!;
      skip.click();skip.click();
      a(!dlg.active&&entered===1,`${branch} continuation executes once, bypassing text`);
    }
    void dlg.show('', [[],['', ' ']]);a(!dlg.active,'empty story never holds narrative lock');
    dlg.dispose();return expect(!bad.length,bad.join('; ')||'9-line paragraphs, actual click binding, last-line reveal, two terminal branches, repeat and empty guards',n);
  });
  check('verify_storycard_early_dismiss', () => {
    const host=parent(), cards=new StoryCards(host);let n=0;const bad:string[]=[];
    const a=(ok:boolean,s:string)=>{n++;if(!ok)bad.push(s);};
    cards.showSequence(['first','second','third'],{dismissible:true});
    a(cards.count===1&&cards.pending===2,'starts one card only');
    host.querySelector<HTMLButtonElement>('.g-card-next')!.click();
    a(cards.count===1&&cards.pending===1&&host.querySelector('.g-card-b')!.textContent==='second','early click advances exactly one card');
    cards.update(.01);a(cards.pending===1,'old timer cannot remove the next card');
    host.querySelector<HTMLButtonElement>('.g-card-skip')!.click();
    a(cards.count===1&&cards.pending===0&&host.querySelector('.g-card-b')!.textContent==='third','skip preserves final card');
    const last=host.querySelector<HTMLButtonElement>('.g-card-next')!;last.click();last.click();
    a(!cards.busy,'repeated final dismissal releases story gate');
    cards.update(99);a(!cards.busy,'expired timers do not resurrect cards');
    return expect(!bad.length,bad.join('; ')||'early click and timer share one idempotent queue',n);
  });
  check('verify_transition_skip_once', () => {
    let n=0;const bad:string[]=[];
    for(const stage of ['holding','outro','none','moving']) {
      let entered=0,unlocked=0;const fake={checkInStage:stage,checkInTarget:13,onCheckInComplete:(idx:number)=>{if(idx===13)entered++;},stageT:1,ride:{setCameraLocked:()=>{unlocked++;},snapCamera:()=>{},pos:new Vector3(2,0,3)},lastCheckInPos:new Vector3(),recheckArmed:true,homeBeat:true,narrativeBusy:true} as unknown as World;
      World.prototype.completeCheckInNow.call(fake);World.prototype.completeCheckInNow.call(fake);
      n++;if(entered!==(stage==='holding'||stage==='outro'?1:0))bad.push(`${stage}: callback duplication or wrong branch`);
      n++;if(entered&&(unlocked!==1||fake.narrativeBusy||fake.checkInStage!=='none'))bad.push('camera / narrative gate left locked');
    }
    return expect(!bad.length,bad.join('; ')||'holding/outro reuse one continuation; moving/idle cannot jump to an unrelated node',n);
  });
  check('verify_ui_visibility_items', () => {
    const host=parent();Object.assign(host,{dataset:{}});
    const input={moveX:.4,moveY:-1,holdPressed:true};
    const visibility=new HudVisibility(host,()=>{input.holdPressed=false;});
    let n=0;const bad:string[]=[];const a=(ok:boolean,s:string)=>{n++;if(!ok)bad.push(s);};
    visibility.setAvailable(true);visibility.setClean(true);
    a(host.classList.contains('is-clean')&&input.moveY===-1,'clean keeps joystick state');
    a(!input.holdPressed,'clean releases hidden action holds');
    visibility.setAvailable(false);a(!host.classList.contains('is-clean'),'blocking phase restores chrome');
    const css=readFileSync('src/ui/styles.css','utf8');
    a(/is-clean \.g-stick-base\s*\{[^}]*visibility: visible;[^}]*opacity: 0/.test(css),'invisible joystick remains hit-testable');
    const bar=new ItemBar(host);
    a(host.querySelector('.g-item-panel')!.classList.contains('g-hidden'),'inventory initially collapsed');
    host.querySelector<HTMLButtonElement>('.g-item-toggle')!.click();
    a(!host.querySelector('.g-item-panel')!.classList.contains('g-hidden'),'inventory click opens four slots');
    a(host.querySelectorAll('.g-item').length===4,'inventory contents retained');
    host.querySelector<HTMLButtonElement>('.g-item-toggle')!.click();
    a(host.querySelector('.g-item-panel')!.classList.contains('g-hidden'),'inventory closes');
    bar.setVisible(false);visibility.dispose();
    const listeners = new Map<string, (e: unknown) => void>();
    let clicked = 0, blocked = false;
    const btn = { disabled:false,isConnected:true,setPointerCapture(){},getBoundingClientRect:()=>({left:10,top:10,right:90,bottom:70}),click:()=>{clicked++;} };
    const root = { contains:(b:unknown)=>b===btn,addEventListener:(k:string,f:(e:unknown)=>void)=>listeners.set(k,f),removeEventListener:(k:string)=>listeners.delete(k) } as unknown as HTMLElement;
    const previous = globalThis.getComputedStyle;
    globalThis.getComputedStyle = (()=>({visibility:'visible'})) as unknown as typeof getComputedStyle;
    const tap = {pointerId:2,pointerType:'touch',isPrimary:false,target:{closest:()=>btn},clientX:30,clientY:30,preventDefault(){}};
    const unbind=bindTouchButtons(root);
    try {
      listeners.get('pointerdown')!(tap);listeners.get('pointerup')!(tap);
      a(clicked===1,'second touch routes to ordinary click handler');
      listeners.get('pointerup')!(tap);a(clicked===1,'duplicate release is ignored');
      listeners.get('click')!({...tap,isTrusted:true,detail:1,stopImmediatePropagation(){blocked=true;}});
      a(blocked,'native compatibility click is suppressed');
      blocked=false;
      listeners.get('click')!({...tap,target:{closest:()=>null},isTrusted:true,detail:1,stopImmediatePropagation(){blocked=true;}});
      a(blocked,'retargeted compatibility click cannot dismiss a new card');
      listeners.get('pointerdown')!({...tap,isPrimary:true});listeners.get('pointerup')!({...tap,isPrimary:true});
      blocked=false;
      listeners.get('click')!({...tap,isPrimary:true,isTrusted:true,detail:1,stopImmediatePropagation(){blocked=true;}});
      a(clicked===1&&!blocked,'primary touch keeps native activation without a second click');
      listeners.get('pointerdown')!(tap);listeners.get('pointerup')!({...tap,clientX:89});
      a(clicked===1,'scroll/drag does not activate button');
      listeners.get('pointerdown')!(tap);listeners.get('pointercancel')!(tap);listeners.get('pointerup')!(tap);
      a(clicked===1,'cancelled tap does not activate');
      listeners.get('pointerdown')!({...tap,pointerType:'pen'});listeners.get('pointerup')!(tap);
      a(clicked===2,'secondary pen follows same activation path');
    } finally { unbind();globalThis.getComputedStyle=previous; }

    return expect(!bad.length,bad.join('; ')||'chrome/input separation and collapsed inventory',n);
  });
  check('verify_soft_lamp_halo', () => {
    const tex=lampHaloTexture(),data=tex.image.data as Uint8Array,size=tex.image.width;
    let n=0;const bad:string[]=[];const a=(ok:boolean,s:string)=>{n++;if(!ok)bad.push(s);};
    for(let i=0;i<size;i++) for(const [x,y] of [[i,0],[i,size-1],[0,i],[size-1,i]]) a(data[(y*size+x)*4+3]===0,'texture edge must be transparent');
    let prev=256;
    for(let x=Math.ceil(size/2);x<size;x++) { const alpha=data[(Math.floor(size/2)*size+x)*4+3];a(alpha<=prev,'radial alpha cannot jump outward');prev=alpha; }
    a(data[(Math.floor(size/2)*size+Math.floor(size/2))*4+3]>240,'light centre retained');tex.dispose();
    return expect(!bad.length,bad.slice(0,5).join('; ')||'zero-alpha boundary and monotonic radial fade',n);
  });
  check('verify_backdrop_color_render', () => {
    let n=0;const bad:string[]=[];const a=(ok:boolean,s:string)=>{n++;if(!ok)bad.push(s);};
    a(hex('303D3B').every((c,i)=>c===[48,61,59][i]/255),'six-digit colors decoded without losing first digit');
    a(JSON.stringify(hex('#303D3B'))===JSON.stringify(hex('303D3B')),'optional hash has identical color');
    for(const [w,h] of [[667,375],[844,390],[1280,720]]) for(const theme of [0,1,2,3,4] as const) {
      drawBackdrop(fakeCtx(w,h),w,h,theme);a(true,`theme ${theme} draws at ${w}x${h}`);
    }
    return expect(!bad.length,bad.join('; ')||'palette parsing and five compositions at three sizes (no pixel/aesthetic claim)',n);
  });
}
