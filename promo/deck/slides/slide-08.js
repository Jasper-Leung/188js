// 08 One road, two timelines -- figure-eight diagram
const { HEAD, BODY, base, pageNum, footer, title } = require('./_lib.js');

function createSlide(pres, theme) {
  const slide = pres.addSlide();
  base(slide, theme);
  title(slide, 'One road, two timelines', theme, 'The loop crosses over itself, and the story is built the same way on purpose.');

  // figure-eight: two overlapping rings, line only
  const cx = 5.0, cy = 3.05, r = 1.05;
  const ring = (ox, col, dash) => {
    slide.addShape('ellipse', {
      x: cx - r + ox, y: cy - r, w: r * 2, h: r * 2,
      fill: { color: theme.bg, transparency: 100 },
      line: { color: col, width: 3.5, dashType: dash },
    });
  };
  ring(-r * 0.72, theme.accent, 'solid');
  ring(r * 0.72, theme.secondary, 'dash');

  slide.addShape('ellipse', { x: cx - 0.07, y: cy - 0.07, w: 0.14, h: 0.14, fill: { color: theme.primary } });
  slide.addText('the crossing', {
    x: cx - 0.8, y: cy + 1.12, w: 1.6, h: 0.24,
    fontSize: 9.5, fontFace: BODY, color: theme.secondary, align: 'center', margin: 0,
  });

  // legend left
  const legend = [
    ['solid', 'Present day', 'The letter. The deadline. The family business.'],
    ['dashed', 'Eight hundred years ago', 'The poet. The road he never left.'],
  ];
  let ly = 2.5;
  for (const [, name, d] of legend) {
    slide.addShape('rect', { x: 0.55, y: ly, w: 0.42, h: 0.05, fill: { color: name === 'Present day' ? theme.accent : theme.secondary } });
    slide.addText(name, {
      x: 1.08, y: ly - 0.09, w: 2.6, h: 0.28,
      fontSize: 12, bold: true, fontFace: HEAD, color: theme.primary, margin: 0,
    });
    slide.addText(d, {
      x: 1.08, y: ly + 0.19, w: 2.7, h: 0.5,
      fontSize: 9.5, fontFace: BODY, color: theme.secondary, margin: 0,
    });
    ly += 0.9;
  }

  // right explanation
  const pts = [
    'Start and finish are the same station. You only find the crossing by riding past where you began.',
    'The first lap is contemporary. The second is eight centuries old.',
    'Two exposures of the same photograph, laid on top of each other.',
  ];
  let py = 2.5;
  for (const p of pts) {
    slide.addShape('rect', { x: 7.3, y: py + 0.06, w: 0.07, h: 0.07, fill: { color: theme.accent } });
    slide.addText(p, {
      x: 7.47, y: py, w: 2.0, h: 0.6,
      fontSize: 9.5, fontFace: BODY, color: theme.secondary, margin: 0,
    });
    py += 0.66;
  }

  slide.addText('Nothing marks the crossing but the road itself.', {
    x: 7.3, y: 4.52, w: 2.15, h: 0.5,
    fontSize: 10, fontFace: HEAD, italic: true, bold: true, color: theme.accent, margin: 0,
  });

  footer(slide, theme);
  pageNum(slide, 8, theme);
  return slide;
}

module.exports = { createSlide };
