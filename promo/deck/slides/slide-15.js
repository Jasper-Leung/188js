// 15 Roadmap -- timeline
const { HEAD, BODY, base, pageNum, footer, title } = require('./_lib.js');

const STEPS = [
  ['NOW', 'Playable build', 'Full loop, five joys, postcard export, both endings. Four rides, three cameras. Bilingual. Web + Godot.'],
  ['NEXT', 'The Echo', 'Objects, memory fragments, the eight-hundred-year trail across the stations. This is the layer the trailer is selling.'],
  ['THEN', 'Delivery pass', 'Real-device export test, touch feel on real hardware, all three tiers measured on a genuine low-end machine.'],
  ['LATER', 'Second road', 'A second route. The postcard carries fragments of both.'],
];

function createSlide(pres, theme) {
  const slide = pres.addSlide();
  base(slide, theme);
  title(slide, 'Where it goes next', theme, 'Sequenced by what unblocks the next, not by ambition.');

  slide.addShape('rect', { x: 0.75, y: 2.02, w: 0.035, h: 2.5, fill: { color: theme.light } });

  let y = 1.72;
  STEPS.forEach(([tag, head, desc], i) => {
    slide.addShape('ellipse', {
      x: 0.62, y: y + 0.08, w: 0.32, h: 0.32, fill: { color: i === 1 ? theme.accent : theme.secondary },
    });
    slide.addText(tag, {
      x: 1.18, y, w: 0.85, h: 0.26,
      fontSize: 10, bold: true, fontFace: BODY, charSpacing: 1.2,
      color: i === 1 ? theme.accent : theme.secondary, margin: 0,
    });
    slide.addText(head, {
      x: 2.12, y: y - 0.04, w: 3.4, h: 0.32,
      fontSize: 15, bold: true, fontFace: HEAD, color: theme.primary, margin: 0,
    });
    slide.addText(desc, {
      x: 5.6, y: y - 0.02, w: 3.85, h: 0.5,
      fontSize: 10, fontFace: BODY, color: theme.secondary, margin: 0,
    });
    y += 0.78;
  });

  slide.addShape('rect', { x: 0.55, y: 4.66, w: 8.9, h: 0.62, fill: { color: theme.light, transparency: 72 } });
  slide.addText('The Echo is the piece that makes this a story instead of a place. Everything else is already built and running.', {
    x: 0.78, y: 4.66, w: 8.5, h: 0.62,
    fontSize: 11, fontFace: BODY, italic: true, color: theme.primary,
    valign: 'middle', margin: 0,
  });

  footer(slide, theme);
  pageNum(slide, 15, theme);
  return slide;
}

module.exports = { createSlide };
