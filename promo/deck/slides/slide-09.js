// 09 The five small joys
const { HEAD, BODY, base, pageNum, footer, title, card } = require('./_lib.js');

const JOYS = [
  ['Cloud', 'Cloudshadow Terrace', 'Trace a moving cloud-shadow across wet stone steps.'],
  ['Tea', 'Tea Smoke Cottage', 'Hold to pour. Let go and it drains back to zero.'],
  ['Music', 'Zither Grove', 'A guqin phrase is played once. Play it back from memory.'],
  ['Bamboo', 'Bamboo Rain Courtyard', 'Cut bamboo the instant it breaks the surface.'],
  ['Bird', 'Birdsong Cove', 'Remember one bird. Later, name which one it was.'],
];

function createSlide(pres, theme) {
  const slide = pres.addSlide();
  base(slide, theme);
  title(slide, 'The five small joys', theme, 'One per station, three visits each. The joy is not the reward -- it is why the object ended up there.');

  let x = 0.55;
  for (const [name, place, act] of JOYS) {
    card(slide, x, 1.5, 1.75, 3.35, theme);
    slide.addShape('rect', { x, y: 1.5, w: 1.75, h: 0.05, fill: { color: theme.accent } });
    slide.addText(name, {
      x: x + 0.16, y: 1.72, w: 1.45, h: 0.32,
      fontSize: 15, bold: true, fontFace: HEAD, color: theme.primary, margin: 0,
    });
    slide.addText(place, {
      x: x + 0.16, y: 2.06, w: 1.45, h: 0.46,
      fontSize: 9.5, fontFace: BODY, color: theme.accent, margin: 0,
    });
    slide.addText(act, {
      x: x + 0.16, y: 2.6, w: 1.45, h: 1.5,
      fontSize: 10, fontFace: BODY, color: theme.secondary, margin: 0,
    });
    slide.addText('3 visits', {
      x: x + 0.16, y: 4.42, w: 1.45, h: 0.26,
      fontSize: 9, fontFace: BODY, color: theme.secondary, margin: 0,
    });
    x += 1.82;
  }

  slide.addText('Rotate which joy appears on which visit, so no two rounds play the same order.', {
    x: 0.55, y: 4.98, w: 8.6, h: 0.28,
    fontSize: 10.5, fontFace: BODY, italic: true, color: theme.secondary, margin: 0,
  });

  footer(slide, theme);
  pageNum(slide, 9, theme);
  return slide;
}

module.exports = { createSlide };
