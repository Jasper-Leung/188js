// 01 Cover -- key art full bleed + title block
const { IMG, HEAD, BODY } = require('./_lib.js');

function createSlide(pres, theme) {
  const slide = pres.addSlide();
  slide.background = { color: theme.primary };

  slide.addImage({ path: IMG('cover2-16x9.jpg'), x: 0, y: 0, w: 10, h: 5.625 });

  // Scrim over the left half so the type stays legible over the painting.
  slide.addShape('rect', {
    x: 0, y: 0, w: 6.0, h: 5.625,
    fill: { color: theme.primary, transparency: 22 },
  });

  slide.addText('GIFT NO.188', {
    x: 0.62, y: 1.24, w: 5.2, h: 1.0,
    fontSize: 54, bold: true, fontFace: HEAD,
    color: theme.bg, charSpacing: 1, margin: 0, fit: 'shrink',
  });

  slide.addText('You cannot change the past.\nYou can only find out what happened there.', {
    x: 0.62, y: 2.3, w: 4.9, h: 0.95,
    fontSize: 15, fontFace: BODY, italic: true,
    color: theme.light, margin: 0,
  });

  slide.addShape('rect', { x: 0.62, y: 3.44, w: 1.15, h: 0.035, fill: { color: theme.accent } });

  slide.addText('Liang Zhuowen  (梁卓文)', {
    x: 0.62, y: 3.68, w: 4.9, h: 0.3,
    fontSize: 14, fontFace: BODY, color: theme.bg, margin: 0,
  });

  slide.addText('3D Cycling Narrative   |   Web (WebGL 2) + Godot 4.6   |   20-30 min   |   EN / 中文', {
    x: 0.62, y: 4.0, w: 5.2, h: 0.3,
    fontSize: 10.5, fontFace: BODY, color: theme.light, margin: 0,
  });

  return slide;
}

module.exports = { createSlide };
