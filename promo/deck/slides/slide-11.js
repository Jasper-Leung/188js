// 11 Under the hood
const { HEAD, BODY, base, pageNum, footer, title, card } = require('./_lib.js');

const ROWS = [
  ['Four ways to ride, three cameras', 'On foot, bicycle, motorcycle, skateboard. Forward, chase, or rider view. Switching ride and camera never touches game state -- swap mid-corner and nothing hiccups.'],
  ['3D generated in code, not modelled', 'Seven building types -- pavilion, tea shed, lookout, shrine, corridor, lantern -- are generated procedurally: upturned roofs, columns, plinths, railings. 5,512 triangles across 7 stations, 0 bytes downloaded, every facade turned to face the road.'],
  ['Zero textures in the whole project', 'Road, terrain, grass and water detail is computed in shaders. On weak GPUs that saves texture bandwidth, not just memory -- and grass covering the screen is exactly where sampling hurts most.'],
  ['One runtime dependency', 'three.js r169, TypeScript, Vite. Godot 4.6 for the original build. Nothing else in the bundle.'],
];

function createSlide(pres, theme) {
  const slide = pres.addSlide();
  base(slide, theme);
  title(slide, 'Under the hood', theme, 'The world is mostly arithmetic. That is the constraint, not a compromise.');

  let y = 1.5;
  for (const [h, d] of ROWS) {
    slide.addShape('rect', { x: 0.55, y: y + 0.05, w: 0.05, h: 0.72, fill: { color: theme.accent } });
    slide.addText(h, {
      x: 0.74, y, w: 5.6, h: 0.28,
      fontSize: 13, bold: true, fontFace: HEAD, color: theme.primary, margin: 0,
    });
    slide.addText(d, {
      x: 0.74, y: y + 0.28, w: 5.6, h: 0.52,
      fontSize: 9.8, fontFace: BODY, color: theme.secondary, margin: 0,
    });
    y += 0.87;
  }

  card(slide, 6.62, 1.5, 2.85, 3.4, theme);
  slide.addText('12.8', {
    x: 6.85, y: 1.78, w: 2.4, h: 0.95,
    fontSize: 62, bold: true, fontFace: HEAD, color: theme.accent, margin: 0,
  });
  slide.addText('MB', {
    x: 6.85, y: 2.72, w: 2.4, h: 0.32,
    fontSize: 15, fontFace: BODY, color: theme.primary, margin: 0,
  });
  slide.addText('Total shipped build, all assets included. It runs on a phone that cannot open a normal 3D game.', {
    x: 6.85, y: 3.12, w: 2.4, h: 0.8,
    fontSize: 10, fontFace: BODY, color: theme.secondary, margin: 0,
  });
  slide.addShape('rect', { x: 6.85, y: 4.02, w: 2.4, h: 0.03, fill: { color: theme.accent } });
  slide.addText('Fonts subset to 0.7% of source. GLB compression. Vegetation streamed per chunk.', {
    x: 6.85, y: 4.14, w: 2.4, h: 0.66,
    fontSize: 9.5, fontFace: BODY, color: theme.secondary, margin: 0,
  });

  footer(slide, theme);
  pageNum(slide, 11, theme);
  return slide;
}

module.exports = { createSlide };
