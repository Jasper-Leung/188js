// 02 Contents -- sidebar navigation
const { HEAD, BODY, base, pageNum, footer } = require('./_lib.js');

const SECTIONS = [
  ['01', 'The Story', 'The Echo, Miles Lu, and a poet eight centuries dead'],
  ['02', 'The Craft', 'Procedural world, 12.8 MB build, weak-hardware targets'],
  ['03', 'The Plan', 'Where the road goes next'],
];

function createSlide(pres, theme) {
  const slide = pres.addSlide();
  base(slide, theme);

  slide.addText('Contents', {
    x: 0.55, y: 0.6, w: 5, h: 0.7,
    fontSize: 34, bold: true, fontFace: HEAD, color: theme.primary, margin: 0,
  });

  let y = 1.9;
  for (const [num, name, desc] of SECTIONS) {
    slide.addShape('rect', { x: 0.55, y: y + 0.08, w: 0.055, h: 0.72, fill: { color: theme.accent } });
    slide.addText(num, {
      x: 0.78, y: y, w: 0.8, h: 0.5,
      fontSize: 24, bold: true, fontFace: HEAD, color: theme.accent, margin: 0,
    });
    slide.addText(name, {
      x: 1.66, y: y + 0.04, w: 4.0, h: 0.42,
      fontSize: 19, bold: true, fontFace: HEAD, color: theme.primary, margin: 0,
    });
    slide.addText(desc, {
      x: 1.66, y: y + 0.46, w: 6.6, h: 0.32,
      fontSize: 11.5, fontFace: BODY, color: theme.secondary, margin: 0,
    });
    y += 1.02;
  }

  footer(slide, theme);
  pageNum(slide, 2, theme);
  return slide;
}

module.exports = { createSlide };
