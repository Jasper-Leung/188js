// 06 Miles Lu's situation -- why he stays
const { HEAD, BODY, base, pageNum, footer, title, card } = require('./_lib.js');

const STEPS = [
  ['HE QUITS', 'Miles Lu has already left the job he was supposed to stay in. Not fired -- decided.'],
  ['HE WAVERS', 'The family business is his to take or not take. He has not said yes yet. The inn has stood empty six years.'],
  ['THE LETTER', 'A lawyer\u2019s letter gives him thirty days to open it. After that the land is taken, and something under the hot spring goes with it.'],
  ['HE STAYS', 'Not to inherit a story someone already finished. To find out what an old man was doing up here for thirty years -- and to keep the place off the auction block while he works it out.'],
];

function createSlide(pres, theme) {
  const slide = pres.addSlide();
  base(slide, theme);
  title(slide, 'Why Miles Lu stays', theme, 'Two motives, and the deadline that forces them into the same road.');

  slide.addShape('rect', { x: 0.78, y: 1.62, w: 0.035, h: 3.1, fill: { color: theme.light } });

  let y = 1.5;
  STEPS.forEach(([tag, d], i) => {
    slide.addShape('ellipse', {
      x: 0.66, y: y + 0.1, w: 0.28, h: 0.28, fill: { color: i === 3 ? theme.accent : theme.secondary },
    });
    slide.addText(tag, {
      x: 1.14, y, w: 1.7, h: 0.28,
      fontSize: 10, bold: true, fontFace: BODY, charSpacing: 1.1,
      color: i === 3 ? theme.accent : theme.secondary, margin: 0,
    });
    slide.addText(d, {
      x: 2.9, y: y - 0.04, w: 6.5, h: 0.66,
      fontSize: 11.5, fontFace: BODY, color: theme.primary, margin: 0,
    });
    y += 0.86;
  });

  card(slide, 0.55, 4.72, 8.9, 0.5, theme);
  slide.addText('Nobody in the valley thinks this is a spiritual quest. To him it is a job offer with a deadline that happens to require learning the history.', {
    x: 0.78, y: 4.72, w: 8.5, h: 0.5,
    fontSize: 10, fontFace: BODY, italic: true, color: theme.secondary,
    valign: 'middle', margin: 0,
  });

  footer(slide, theme);
  pageNum(slide, 6, theme);
  return slide;
}

module.exports = { createSlide };
