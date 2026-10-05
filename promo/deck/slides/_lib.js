// Shared helpers for the Gift No.188 roadshow deck v2.
// Palette: Nature & Outdoors -- cream parchment, deep forest, olive, tan, rust.
const path = require('node:path');

// __dirname = <root>/promo/deck/slides  ->  up 3 to reach the project root
const ROOT = path.join(__dirname, '..', '..', '..');
const IMG = (name) => path.join(ROOT, 'promo', 'assets', name);

const HEAD = 'Georgia';
const BODY = 'Calibri';

function base(slide, theme) {
  slide.background = { color: theme.bg };
}

function pageNum(slide, n, theme) {
  slide.addText(String(n).padStart(2, '0'), {
    x: 9.3, y: 5.1, w: 0.5, h: 0.32,
    fontSize: 11, fontFace: BODY,
    color: theme.secondary, align: 'right', margin: 0,
  });
}

function title(slide, text, theme, sub) {
  slide.addText(text, {
    x: 0.55, y: 0.34, w: 8.9, h: 0.6,
    fontSize: 30, bold: true, fontFace: HEAD,
    color: theme.primary, margin: 0, fit: 'shrink',
  });
  if (sub) {
    slide.addText(sub, {
      x: 0.55, y: 0.94, w: 8.9, h: 0.34,
      fontSize: 13, fontFace: BODY,
      color: theme.secondary, margin: 0,
    });
  }
}

function card(slide, x, y, w, h, theme) {
  slide.addShape('rect', {
    x, y, w, h,
    fill: { color: theme.light, transparency: 72 },
    line: { color: theme.light, width: 0.75 },
    rectRadius: 0.15,
  });
}

function footer(slide, theme) {
  slide.addText('Gift No.188  |  Liang Zhuowen', {
    x: 0.55, y: 5.1, w: 4.5, h: 0.32,
    fontSize: 10, fontFace: BODY,
    color: theme.secondary, margin: 0,
  });
}

module.exports = { IMG, HEAD, BODY, base, pageNum, title, card, footer };
