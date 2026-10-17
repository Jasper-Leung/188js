/** Deterministic canvas illustrations. Only the current scene/size is cached per game canvas. */
type Painter = (g: CanvasRenderingContext2D, w: number, h: number, theme: number) => void;
const cache = new WeakMap<CanvasRenderingContext2D, { key: string; image: HTMLCanvasElement }>();
export function cachedBackdrop(g: CanvasRenderingContext2D, w: number, h: number, theme: number, paint: Painter): void {
  if (typeof HTMLCanvasElement === 'undefined' || !(g.canvas instanceof HTMLCanvasElement)) {
    paint(g, w, h, theme); return;
  }
  const key = `${theme}:${w}:${h}`;
  let stored = cache.get(g);
  if (stored?.key !== key) {
    const image = document.createElement('canvas');
    const scale = Math.min(1.5, 1600 / w, 1000 / h);
    image.width = Math.max(1, Math.round(w * scale)); image.height = Math.max(1, Math.round(h * scale));
    const bg = image.getContext('2d', { alpha: false });
    if (!bg) { paint(g, w, h, theme); return; }
    bg.scale(image.width / w, image.height / h);
    paint(bg, w, h, theme);
    stored = { key, image }; cache.set(g, stored);
  }
  g.drawImage(stored.image, 0, 0, w, h);
}

function wash(g: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, color: string): void {
  g.save(); g.translate(x, y); g.scale(rx, ry);
  const glow = g.createRadialGradient(0, 0, 0, 0, 0, 1);
  glow.addColorStop(0, color); glow.addColorStop(1, 'rgba(210,215,201,0)');
  g.fillStyle = glow; g.fillRect(-1, -1, 2, 2); g.restore();
}
function ridge(g: CanvasRenderingContext2D, w: number, h: number, y: number, amplitude: number, color: string, seed: number): void {
  g.fillStyle = color; g.beginPath(); g.moveTo(0, h);
  for (let i = 0; i <= 100; i++) {
    const t = i / 100;
    g.lineTo(w * t, h * (y + amplitude * (Math.sin(t * 7 + seed) + .32 * Math.sin(t * 21 + seed))));
  }
  g.lineTo(w, h); g.closePath(); g.fill();
}
function stroke(g: CanvasRenderingContext2D, x: number, y: number, ex: number, ey: number, color: string, width = 1): void {
  g.strokeStyle = color; g.lineWidth = width; g.beginPath(); g.moveTo(x, y); g.lineTo(ex, ey); g.stroke();
}
function foliage(g: CanvasRenderingContext2D, x: number, y: number, size: number, lean: number, color: string): void {
  g.save(); g.translate(x, y); g.rotate(lean); g.fillStyle = color;
  g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(size * .3, -size * .45, size, -size * .15);
  g.quadraticCurveTo(size * .5, size * .18, 0, 0); g.fill(); g.restore();
}

/** Five compositions reserve their centre for gameplay; detailed silhouettes frame the margins. */
export function sceneBackdrop(g: CanvasRenderingContext2D, w: number, h: number, theme: number, far: string, near: string): void {
  g.save();
  if (theme === 0) {
    // A high lookout above terraced hills; long cloud banks leave the tracing board clear.
    wash(g, w * .8, h * .18, w * .45, h * .5, 'rgba(245,234,206,.32)');
    ridge(g, w, h, .48, .065, far, 3);
    ridge(g, w, h, .65, .08, '#718b95', 5);
    for (let i = 0; i < 6; i++) wash(g, w * (i / 5), h * (.57 + .025 * (i % 2)), w * .28, h * .09, 'rgba(222,231,227,.65)');
    ridge(g, w, h, .85, .065, near, 1);
    for (let i = 0; i < 4; i++) stroke(g, 0, h * (.84 + i * .035), w * .2, h * (.88 + i * .025), '#b7bcaa55', 2);
    stroke(g, 0, h * .89, w * .16, h * .92, '#394e53', h * .012);
    for (let i = 0; i < 3; i++) stroke(g, w * i * .06, h * .86, w * i * .06, h, '#394e53', w * .008);
  } else if (theme === 1) {
    // Timber tea room, open window on the left, pottery shelves on the right.
    const windowLight = g.createLinearGradient(0, h * .17, 0, h * .71);
    windowLight.addColorStop(0, '#8c9e95'); windowLight.addColorStop(1, '#c0b99d');
    g.fillStyle = windowLight; g.fillRect(w * .035, h * .16, w * .25, h * .54);
    g.save(); g.beginPath(); g.rect(w * .035, h * .16, w * .25, h * .54); g.clip();
    ridge(g, w, h, .53, .075, '#697f72', 4);
    ridge(g, w, h, .65, .055, '#415d4e', 6); g.restore();
    for (const x of [.035, .16, .285]) stroke(g, w*x, h*.16, w*x, h*.71, '#352e25', w*.008);
    for (const y of [.16, .43, .71]) stroke(g, w*.03, h*y, w*.29, h*y, '#352e25', h*.012);
    wash(g, w*.3, h*.46, w*.34, h*.46, 'rgba(214,189,136,.13)');
    for (let row = 0; row < 2; row++) {
      const y = h*(.38 + row*.23);
      for (let i = 0; i < 3; i++) {
        const x = w*(.79+i*.065); g.fillStyle = ['#877964','#626f63','#9c8a72'][i];
        g.beginPath(); g.ellipse(x, y-h*.045, w*.021, h*.054, 0, 0, Math.PI*2); g.fill();
        g.fillStyle = '#40372d'; g.fillRect(x-w*.013, y-h*.103, w*.026, h*.012);
      }
      stroke(g, w*.75, y+h*.012, w*.99, y+h*.012, '#302922', h*.015);
    }
    const desk = g.createLinearGradient(0, h*.79, 0, h);
    desk.addColorStop(0, '#5b4937'); desk.addColorStop(1, '#302b25');
    g.fillStyle = desk; g.fillRect(0,h*.79,w,h*.21);
    for(let i=0;i<9;i++) stroke(g,0,h*(.8+i*.025),w,h*(.79+i*.028),'#d3b37d12');
  } else if (theme === 2) {
    // Ink-green forest, mist and a quiet stream: muted chroma, no luminous green blocks.
    ridge(g,w,h,.45,.055,far,1); ridge(g,w,h,.67,.04,'#435550',5);
    wash(g,w*.48,h*.58,w*.64,h*.22,'rgba(179,188,173,.36)');
    for(let i=0;i<17;i++) {
      const x=w*(i/16), depth=i%3;
      stroke(g,x,h*.76,x+w*.018*Math.sin(i),h*(.17+(i%4)*.045),['#52625c88','#3b4e4788','#2a3b3588'][depth],w*(.005+depth*.002));
    }
    ridge(g,w,h,.86,.03,near,3);
    g.fillStyle='#73867b33';g.beginPath();g.moveTo(w*.48,h*.65);g.bezierCurveTo(w*.38,h*.8,w*.72,h*.9,w*.8,h);g.lineTo(w*.62,h);g.bezierCurveTo(w*.55,h*.86,w*.34,h*.83,w*.48,h*.65);g.fill();
    for(const side of [0,1]) for(let i=0;i<4;i++) {
      const x=w*(side ? .91+i*.032 : .09-i*.032);
      stroke(g,x,h,x+w*.04*(side?1:-1),h*.12,'#23332f',w*(.008+i*.003));
      for(let j=0;j<7;j++) foliage(g,x,h*(.21+j*.09),w*.06,side?2.8:-.5,'#34463dcc');
    }
    wash(g,w*.7,h*.19,w*.25,h*.25,'rgba(186,188,161,.12)');
  } else if (theme === 3) {
    // Sheltered rainy courtyard: bamboo along the margins and wet paving at the bottom.
    ridge(g,w,h,.48,.045,far,4); ridge(g,w,h,.69,.035,near,6);
    wash(g,w*.5,h*.6,w*.7,h*.2,'rgba(135,161,159,.24)');
    for(const side of [0,1]) for(let i=0;i<6;i++) {
      const x=w*(side ? .85+i*.03 : .15-i*.03);
      stroke(g,x,h,x+w*.035,h*.1,'#283c35',w*.008);
      for(let j=0;j<7;j++) {
        const y=h*(.15+j*.13);stroke(g,x-w*.008,y,x+w*.014,y,'#8a9b7555',2);
        foliage(g,x,y,w*.07,side?3.4:-.6,'#30473e');
      }
    }
    for(let i=0;i<85;i++) { const x=w*((i*.618033)%1),y=h*((i*.381966)%1);stroke(g,x,y,x-w*.007,y+h*.032,'#b5c9ca24'); }
    ridge(g,w,h,.9,.006,'#253733',3);
    for(let i=0;i<12;i++) { g.strokeStyle='#b3c1b326';g.beginPath();g.ellipse(w*((i*.618)%1),h*(.91+(i%3)*.03),w*.035,h*.005,0,0,Math.PI*2);g.stroke(); }
  } else {
    // Dawn bird hide: distant banks, a broad lake, reeds framing the recognition cards.
    ridge(g,w,h,.44,.035,far,2); ridge(g,w,h,.58,.04,near,4);
    const lake=g.createLinearGradient(0,h*.6,0,h);lake.addColorStop(0,'#829b9b');lake.addColorStop(1,'#3c575b');
    g.fillStyle=lake;g.fillRect(0,h*.6,w,h*.4);
    wash(g,w*.73,h*.67,w*.3,h*.2,'rgba(224,208,168,.24)');
    for(let i=0;i<45;i++) { const x=w*((i*.618)%1),y=h*(.62+(i%13)*.029);stroke(g,x,y,x+w*.03,y,'#d8dcc21c'); }
    for(const side of [0,1]) for(let i=0;i<13;i++) {
      const x=w*(side ? .87+(i%5)*.03 : .13-(i%5)*.03), y=h*(.66+(i%4)*.06);
      stroke(g,x,h,x+w*.025*(side?-1:1),y,'#304943',w*.002);
      foliage(g,x,y+h*.1,w*.05,side?-2.4:-.8,'#486256');
      stroke(g,x+w*.025*(side?-1:1),y,x+w*.025*(side?-1:1),y-h*.045,'#665f4a',w*.005);
    }
  }
  // Fine paper grain, reproducible and cached; high frequency stays below foreground contrast.
  let seed = 188 + theme;
  const random = () => { seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296; };
  g.fillStyle='rgba(222,211,185,.026)';
  for(let i=0;i<1400;i++) g.fillRect(random()*w,random()*h,1+random()*1.4,.6);
  if (theme !== 0) {
    const shade=g.createLinearGradient(0,0,0,h*.23);shade.addColorStop(0,'rgba(15,24,23,.7)');shade.addColorStop(1,'rgba(15,24,23,0)');
    g.fillStyle=shade;g.fillRect(0,0,w,h*.23);
  }
  g.restore();
}
