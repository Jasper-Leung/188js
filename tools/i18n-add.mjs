/**
 * 往 Web 专属文案表里追加一批 key。zh / en 同时写。
 *
 * 存在的理由：PowerShell 内联 node 反复栽在引号转义上
 *（中英文混排 + 双引号 + 撇号 + JSON 括号），
 * 而这类"追加一批文案"的动作每轮都要做几次。写成文件跑一次就对了。
 *
 * 用法：node tools/i18n-add.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const P = 'tools/i18n-supplement.json';

const ADD = {
  zh: {
    chapter_label_1: '第一章',
    chapter_label_2: '第二章',
    chapter_label_n: '第%s章',
    objective_return: '五件乐事都齐了。回十八驿去。',
    hud_home_target: '回十八驿 %s · %dm',
    home_speaker: '十八驿',
    home_arrive_1: '门开着。',
    home_arrive_2: '你回来了。',
    home_arrive_3: '五件乐事都在这儿了。这一章到这儿。',
    chapter1_done_title: '第一章 · 完',
    chapter1_done_line: '188 号环线，一趟。下一章的门开了。',
    chapter2_unlocked: '第二章 · 已解锁',
    touch_home_button: '回到十八驿',
    synthesis_home_hint: '第一章完成了。收下这份礼物，或者再骑一圈。',
    fatal_title: '启动失败',
    fatal_note:
      '这一屏是故意留下的——把上面那行字连同浏览器控制台一起反馈，就能定位到具体哪一步。',
  },
  en: {
    chapter_label_1: 'Chapter One',
    chapter_label_2: 'Chapter Two',
    chapter_label_n: 'Chapter %s',
    objective_return: 'All five joys are gathered. Head back to the Eighteenth Post.',
    hud_home_target: 'Eighteenth Post %s · %dm',
    home_speaker: 'The Eighteenth Post',
    home_arrive_1: 'The door is open.',
    home_arrive_2: 'You are back.',
    home_arrive_3: 'The five joys are all here. This chapter ends here.',
    chapter1_done_title: 'Chapter One - Complete',
    chapter1_done_line: 'The 188 loop, once through. The next chapter is open.',
    chapter2_unlocked: 'Chapter Two - Unlocked',
    touch_home_button: 'Return to the Post',
    synthesis_home_hint: 'Chapter one is done. Take the gift, or ride one more lap.',
    fatal_title: 'Failed to start',
    fatal_note:
      'This screen is here on purpose — send the line above along with your browser console and we can pin down which step failed.',
  },
};

const j = JSON.parse(readFileSync(P, 'utf8'));
let n = 0;
for (const lang of ['zh', 'en']) {
  for (const [k, v] of Object.entries(ADD[lang])) {
    if (k in j[lang]) {
      console.log('已存在，跳过:', k);
      continue;
    }
    j[lang][k] = v;
    n++;
  }
}
writeFileSync(P, JSON.stringify(j, null, 2) + '\n', 'utf8');
console.log('新增', n, '条 key');
