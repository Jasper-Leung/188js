// 04 Logline + portrait art -- mixed media
const { IMG, HEAD, BODY, base, pageNum, footer } = require('./_lib.js');

function createSlide(pres, theme) {
  const slide = pres.addSlide();
  base(slide, theme);

  slide.addText('The pitch in one line', {
    x: 0.55, y: 0.4, w: 6, h: 0.55,
    fontSize: 30, bold: true, fontFace: HEAD, color: theme.primary, margin: 0,
  });

  slide.addText('A man who has already quit his job rides up the mountain to keep his family road -- and finds someone kept it eight hundred years before him.', {
    x: 0.55, y: 1.08, w: 5.5, h: 1.3,
    fontSize: 17, fontFace: HEAD, italic: true,
    color: theme.accent, margin: 0,
  });

  const rows = [
    ['You ride', 'a figure-eight loop of 1,228.8 m through mist-layered mountains'],
    ['You touch', 'old objects. Each one plays back its owner\u2019s memory'],
    ['You find', 'a poet who came here eight centuries ago and stayed to die happy'],
    ['You keep', 'a postcard you can write on, or leave blank'],
  ];

  let y = 2.55;
  for (const [k, v] of rows) {
    slide.addShape('rect', { x: 0.55, y: y + 0.04, w: 0.045, h: 0.52, fill: { color: theme.light } });
    slide.addText(k, {
      x: 0.72, y: y, w: 1.25, h: 0.3,
      fontSize: 13, bold: true, fontFace: HEAD, color: theme.primary, margin: 0,
    });
    slide.addText(v, {
      x: 0.72, y: y + 0.26, w: 5.2, h: 0.32,
      fontSize: 11.5, fontFace: BODY, color: theme.secondary, margin: 0,
    });
    y += 0.62;
  }

  slide.addImage({ path: IMG('cover2-3x4.jpg'), x: 6.42, y: 0.55, w: 3.05, h: 4.07 });
  slide.addShape('rect', {
    x: 6.42, y: 0.55, w: 3.05, h: 4.07,
    fill: { color: theme.light, transparency: 100 },
    line: { color: theme.accent, width: 1 },
  });
  slide.addText('Key art', {
    x: 6.42, y: 4.68, w: 3.05, h: 0.26,
    fontSize: 9.5, fontFace: BODY, color: theme.secondary, align: 'center', margin: 0,
  });

  footer(slide, theme);
  pageNum(slide, 4, theme);
  return slide;
}

module.exports = { createSlide };
