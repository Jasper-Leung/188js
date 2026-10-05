const pptxgen = require('pptxgenjs');
const path = require('node:path');

// Palette 3 "Nature & Outdoors" -- cream parchment, deep forest, olive, tan, rust.
const theme = {
  primary: '283618',
  secondary: '606c38',
  accent: 'bc6c25',
  light: 'dda15e',
  bg: 'fefae0',
};

const pres = new pptxgen();
pres.layout = 'LAYOUT_16x9';
pres.author = 'Liang Zhuowen';
pres.company = 'Gift No.188';
pres.title = 'Gift No.188 -- Roadshow Deck';
pres.subject = '3D cycling narrative game';

const N = 16;
for (let i = 1; i <= N; i++) {
  const f = `./slide-${String(i).padStart(2, '0')}.js`;
  require(f).createSlide(pres, theme);
}

const out = path.join(__dirname, '..', 'output', 'GiftNo188-Roadshow-Deck-v2.pptx');
pres.writeFile({ fileName: out }).then(() => console.log('wrote', out));
