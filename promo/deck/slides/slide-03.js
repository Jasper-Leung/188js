// 03 Section divider -- 01 The Story
const { HEAD, BODY, base, pageNum } = require('./_lib.js');

function createSlide(pres, theme) {
  const slide = pres.addSlide();
  slide.background = { color: theme.primary };

  slide.addText('01', {
    x: 0.55, y: 1.05, w: 3.2, h: 1.7,
    fontSize: 110, bold: true, fontFace: HEAD, color: theme.light, margin: 0,
  });

  slide.addShape('rect', { x: 0.62, y: 2.92, w: 1.15, h: 0.04, fill: { color: theme.accent } });

  slide.addText('The Story', {
    x: 0.62, y: 3.12, w: 6.5, h: 0.72,
    fontSize: 40, bold: true, fontFace: HEAD, color: theme.bg, margin: 0,
  });

  slide.addText('Touch an old thing. It remembers. You cannot change what it tells you.', {
    x: 0.62, y: 3.86, w: 7.4, h: 0.36,
    fontSize: 13.5, fontFace: BODY, italic: true, color: theme.light, margin: 0,
  });

  pageNum(slide, 3, theme);
  return slide;
}

module.exports = { createSlide };
