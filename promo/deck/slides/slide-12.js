// 12 Weak-hardware targets -- comparison table
const { HEAD, BODY, base, pageNum, footer, title } = require('./_lib.js');

const ROWS = [
  ['Internal render scale', '0.60x', '0.85x', '1.00x'],
  ['Shadows', 'off', '1024 / 55 m', '2048 / 130 m'],
  ['Grass', 'removed entirely', '105 m / 70%', '190 m / 100%'],
  ['Roadside trees', '52 m / 35%', '92 m / 75%', '160 m / 100%'],
  ['Fog distance', '130 m', '260 m', '400 m'],
  ['Landmark load distance', '130 m', '220 m', '320 m'],
  ['Ambient audio layers', '1 (wind)', '2', '3'],
  ['Tone mapping', 'off', 'ACES', 'ACES'],
];

function createSlide(pres, theme) {
  const slide = pres.addSlide();
  base(slide, theme);
  title(slide, 'Built for weak hardware', theme, 'The low tier does not just look cheaper -- it spends its budget somewhere you can see.');

  const head = ['', 'LOW', 'MEDIUM', 'HIGH'].map((t, i) => ({
    text: t,
    options: {
      fill: { color: i === 0 ? theme.bg : theme.light },
      color: i === 0 ? theme.bg : theme.primary,
      bold: true, fontSize: 11, fontFace: BODY, align: i === 0 ? 'left' : 'center',
    },
  }));

  const body = ROWS.map((r, ri) =>
    r.map((cell, ci) => ({
      text: cell,
      options: {
        fill: { color: ri % 2 === 0 ? theme.bg : theme.light, transparency: ri % 2 === 0 ? 0 : 72 },
        color: ci === 0 ? theme.primary : theme.secondary,
        bold: ci === 0,
        fontSize: 10.5,
        fontFace: BODY,
        align: ci === 0 ? 'left' : 'center',
      },
    }))
  );

  slide.addTable([head, ...body], {
    x: 0.55, y: 1.5, w: 8.9, colW: [2.9, 2.0, 2.0, 2.0],
    rowH: 0.28, border: { pt: 0.5, color: theme.light }, margin: 0.06,
  });

  slide.addShape('rect', { x: 0.55, y: 4.32, w: 0.045, h: 0.62, fill: { color: theme.accent } });
  slide.addText('The low tier deletes grass entirely and gives that budget to resolution instead. Grass covering the screen is fill-rate bound; a slightly softer image is far more visible than slightly thinner grass. 0.6 x 0.6 = 36% of the pixels, and fog covers the rest.', {
    x: 0.74, y: 4.32, w: 8.6, h: 0.62,
    fontSize: 9.8, fontFace: BODY, color: theme.secondary, margin: 0,
  });

  footer(slide, theme);
  pageNum(slide, 12, theme);
  return slide;
}

module.exports = { createSlide };
