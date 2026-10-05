// 16 Closing -- ask + contact over key art
const { IMG, HEAD, BODY, base, pageNum } = require('./_lib.js');

function createSlide(pres, theme) {
  const slide = pres.addSlide();
  slide.background = { color: theme.primary };

  slide.addImage({ path: IMG('cover2-16x9.jpg'), x: 0, y: 0, w: 10, h: 5.625 });
  slide.addShape('rect', { x: 0, y: 0, w: 10, h: 5.625, fill: { color: theme.primary, transparency: 24 } });

  slide.addText('What I am asking for', {
    x: 0.62, y: 0.66, w: 8.4, h: 0.66,
    fontSize: 36, bold: true, fontFace: HEAD, color: theme.bg, margin: 0,
  });

  const ASKS = [
    ['Play it', 'A 90-second self-riding demo exists in the build. It is the fastest honest answer to "is it good".'],
    ['Fund the Echo', 'The memory layer is the difference between a nice place and a story. It is the one thing this needs next.'],
    ['Port partners', 'The procedural pipeline is engine-agnostic by design, and the 12.8 MB budget survives the port.'],
  ];

  let y = 1.64;
  for (const [h, d] of ASKS) {
    slide.addShape('rect', { x: 0.62, y: y + 0.05, w: 0.05, h: 0.72, fill: { color: theme.accent } });
    slide.addText(h, {
      x: 0.82, y, w: 3.6, h: 0.3,
      fontSize: 14, bold: true, fontFace: HEAD, color: theme.bg, margin: 0,
    });
    slide.addText(d, {
      x: 0.82, y: y + 0.32, w: 5.1, h: 0.5,
      fontSize: 10.5, fontFace: BODY, color: theme.light, margin: 0,
    });
    y += 0.98;
  }

  slide.addShape('rect', { x: 0.62, y: 4.66, w: 2.2, h: 0.03, fill: { color: theme.accent } });
  slide.addText('Gift No.188  --  Liang Zhuowen', {
    x: 0.62, y: 4.82, w: 5.4, h: 0.32,
    fontSize: 14, bold: true, fontFace: HEAD, color: theme.bg, margin: 0,
  });
  slide.addText('Miles Lu, the Eighteenth Post, Route No.188 and the eight-hundred-year poet are fictional.', {
    x: 0.62, y: 5.14, w: 6.6, h: 0.26,
    fontSize: 9, fontFace: BODY, color: theme.light, margin: 0,
  });

  pageNum(slide, 16, theme);
  return slide;
}

module.exports = { createSlide };
