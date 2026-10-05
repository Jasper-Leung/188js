// 05 The Echo -- the one mechanic, three rules
const { HEAD, BODY, base, pageNum, footer, title, card } = require('./_lib.js');

const RULES = [
  ['A fragment, not a life',
   'Six seconds. A room, a season, a face going soft at the edges. You never get the year, and you never get the middle.'],
  ['The person, never the reason',
   'A cup knows who drank from it. It does not know why that cup was the one they kept.'],
  ['You cannot change the past',
   'Not one thing. You cannot warn them, fix it, or take the object away. The Echo finds things out. It does not help.'],
];

function createSlide(pres, theme) {
  const slide = pres.addSlide();
  base(slide, theme);
  title(slide, 'The Echo', theme, 'Walk up to an old object and touch it. That is the entire mechanic.');

  let x = 0.55;
  RULES.forEach(([h, d], i) => {
    card(slide, x, 1.5, 2.93, 2.42, theme);
    slide.addShape('rect', { x, y: 1.5, w: 2.93, h: 0.05, fill: { color: i === 2 ? theme.accent : theme.light } });
    slide.addText('0' + (i + 1), {
      x: x + 0.22, y: 1.68, w: 0.6, h: 0.36,
      fontSize: 17, bold: true, fontFace: HEAD, color: theme.accent, margin: 0,
    });
    slide.addText(h, {
      x: x + 0.22, y: 2.06, w: 2.5, h: 0.5,
      fontSize: 12.5, bold: true, fontFace: HEAD, color: theme.primary, margin: 0,
    });
    slide.addText(d, {
      x: x + 0.22, y: 2.6, w: 2.5, h: 1.2,
      fontSize: 10, fontFace: BODY, color: theme.secondary, margin: 0,
    });
    x += 3.03;
  });

  slide.addShape('rect', { x: 0.55, y: 4.1, w: 8.9, h: 0.78, fill: { color: theme.light, transparency: 72 } });
  slide.addText('Because of rule three, the game is mostly about arriving late. Every Echo is a record of someone who is already gone -- and the only thing you can still do for them is understand what they were doing up here.', {
    x: 0.78, y: 4.1, w: 8.5, h: 0.78,
    fontSize: 11, fontFace: BODY, italic: true, color: theme.primary,
    valign: 'middle', margin: 0,
  });

  footer(slide, theme);
  pageNum(slide, 5, theme);
  return slide;
}

module.exports = { createSlide };
