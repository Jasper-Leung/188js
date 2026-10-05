// 13 Verification -- what the regression suite actually caught
const { HEAD, BODY, base, pageNum, footer, title, card } = require('./_lib.js');

function createSlide(pres, theme) {
  const slide = pres.addSlide();
  base(slide, theme);
  title(slide, 'Verification as a discipline', theme, 'Headless regression with hard invariants, not smoke tests.');

  const inv = ['961 pts', '1,228.8 m', '4 crossings', '16 stations', 'economy', 'water', '15 sessions', 'bilingual parity'];
  let x = 0.55;
  for (const t of inv) {
    slide.addShape('rect', { x, y: 1.44, w: 1.06, h: 0.34, fill: { color: theme.light, transparency: 60 } });
    slide.addText(t, {
      x, y: 1.44, w: 1.06, h: 0.34,
      fontSize: 8.5, fontFace: BODY, color: theme.primary,
      align: 'center', valign: 'middle', margin: 0,
    });
    x += 1.11;
  }

  const BUGS = [
    ['A missing fmod made the whole world a plateau',
     'One dropped modulo shifted the terrain noise range so clamping ate 79% of samples. Point count, length and range assertions all stayed green. The mountains simply had no valleys -- and nothing failed.'],
    ['Interleaved buffers put every tree 940 km up',
     'A vertex reader walked a 3-stride over interleaved data, so normal and UV components were read as Y. Every roadside tree was frustum-culled at 949,141 m. The placement table said they existed; nothing measured how many actually drew.'],
  ];

  let y = 2.06;
  for (const [h, d] of BUGS) {
    card(slide, 0.55, y, 8.9, 1.26, theme);
    slide.addShape('rect', { x: 0.55, y, w: 0.055, h: 1.26, fill: { color: theme.accent } });
    slide.addText(h, {
      x: 0.78, y: y + 0.16, w: 8.4, h: 0.3,
      fontSize: 13.5, bold: true, fontFace: HEAD, color: theme.primary, margin: 0,
    });
    slide.addText(d, {
      x: 0.78, y: y + 0.5, w: 8.4, h: 0.64,
      fontSize: 10, fontFace: BODY, color: theme.secondary, margin: 0,
    });
    y += 1.4;
  }

  slide.addText('Both bugs make the same point: a check that counts what you placed is not a check that anything appeared. Every new assertion is proven to fail before it is trusted.', {
    x: 0.55, y: 4.88, w: 8.9, h: 0.42,
    fontSize: 9.5, fontFace: BODY, italic: true, color: theme.secondary, margin: 0,
  });

  footer(slide, theme);
  pageNum(slide, 13, theme);
  return slide;
}

module.exports = { createSlide };
