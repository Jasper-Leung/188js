// 07 The poet, 800 years ago
const { IMG, HEAD, BODY, base, pageNum, footer, title, card } = require('./_lib.js');

function createSlide(pres, theme) {
  const slide = pres.addSlide();
  base(slide, theme);
  title(slide, 'Eight hundred years ago', theme, 'A famous poet came up this road, gave up the life arranged for him, and stayed.');

  // left: the arc
  const beats = [
    ['He arrives', 'A young man with a name everyone knows and a future already settled.'],
    ['He stops', 'Somewhere on this loop he stops travelling. No announcement, no falling out. He simply does not leave.'],
    ['He is happy', 'And this is the part nobody expected. He was not waiting to die here. He was glad. The echoes agree, and echoes cannot flatter.'],
    ['He leaves objects', 'One in every station, on purpose. Not grave goods -- a trail. For whoever came next.'],
  ];

  let y = 1.5;
  for (const [h, d] of beats) {
    slide.addShape('rect', { x: 0.55, y: y + 0.04, w: 0.045, h: 0.62, fill: { color: theme.accent } });
    slide.addText(h, {
      x: 0.74, y, w: 1.55, h: 0.28,
      fontSize: 12, bold: true, fontFace: HEAD, color: theme.primary, margin: 0,
    });
    slide.addText(d, {
      x: 2.35, y: y - 0.02, w: 4.0, h: 0.72,
      fontSize: 10, fontFace: BODY, color: theme.secondary, margin: 0,
    });
    y += 0.84;
  }

  // right: the object card
  card(slide, 6.62, 1.5, 2.85, 3.42, theme);
  slide.addText('What is in the stations', {
    x: 6.85, y: 1.72, w: 2.4, h: 0.3,
    fontSize: 11, bold: true, fontFace: HEAD, color: theme.accent, margin: 0,
  });
  const objs = ['an ink brush', 'a chipped celadon cup', 'a folded letter', 'a length of frayed silk', 'a tuning peg, missing its string'];
  let oy = 2.1;
  for (const o of objs) {
    slide.addShape('rect', { x: 6.87, y: oy + 0.07, w: 0.07, h: 0.07, fill: { color: theme.accent } });
    slide.addText(o, {
      x: 7.04, y: oy, w: 2.25, h: 0.34,
      fontSize: 10, fontFace: BODY, italic: true, color: theme.primary, margin: 0,
    });
    oy += 0.4;
  }
  slide.addShape('rect', { x: 6.85, y: 4.18, w: 2.4, h: 0.03, fill: { color: theme.accent } });
  slide.addText('Touch any of them. He will tell you the rest, in six-second pieces, eight hundred years too late to warn him.', {
    x: 6.85, y: 4.3, w: 2.4, h: 0.56,
    fontSize: 9.5, fontFace: BODY, color: theme.secondary, margin: 0,
  });

  footer(slide, theme);
  pageNum(slide, 7, theme);
  return slide;
}

module.exports = { createSlide };
