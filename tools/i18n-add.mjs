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
/** `extract-data.mjs` 的产物。那一步要 Godot 源项目才能跑，所以这里直接补写。 */
const P_GEN = 'src/data/generated/i18n.json';

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

    // ---- 视角（V 切换）----
    key_camera: 'V',
    cam_forward: '向前',
    cam_chase: '追车',
    cam_first: '骑手',
    cam_switched: '视角 · %s',

    // ---- 道具栏（1~4）----
    item_bar_title: '道具',
    key_item_bar_desc: '数字键选道具',
    item_none: '还没买到任何道具',
    item_paper: '信纸',
    item_ink: '墨',
    item_seal: '印',
    item_env: '封口',
    item_selected: '已选 · %s',

    // ---- 载具（E 切换）----
    key_vehicle: 'E',
    stele_title: '188 号碑',
    villain_cue_title: '对讲机',
    veh_foot: '徒步',
    veh_bike: '自行车',
    veh_skate: '滑板',
    veh_switched: '载具 · %s',
    veh_locked: '还没有滑板',

    // ---- 可摸索的旧物（F）----
    //
    // 全作最原创的设定是"这双手摸一下，东西自己会讲它是谁"。
    // 序章用三张卡把它讲清楚了，然后游戏再也没碰过它——
    // 而这五件是它第一次变成**一个动词**。
    key_relic: 'F',
    key_relic_desc: '摸一摸路边的旧物',
    relic_hint: '%s · 按 F 摸一摸',
    relic_near: '路边有东西被留在这儿。',
    relic_bowl_title: '青瓷碗',
    relic_bowl_text:
      '指腹压过碗底那道磨痕。\n六百年前有人在这儿摔过它，又一片片捡起来粘好。\n……补得比我笨。',
    relic_ring_title: '门环',
    relic_ring_text:
      '铜的，磨得只剩一层皮。\n六百年里被推过多少次，我数不清。\n最后推它的那个，是我妈。',
    relic_ledger_title: '账本',
    relic_ledger_text:
      '最后一页是今年的。\n客人的名字都还挂着，房钱那一栏空着。\n……她走的那天，账就停在这一页。',
    relic_shoe_title: '一只鞋',
    relic_shoe_text:
      '鞋底磨穿了，鞋帮上绣着半个「路」。\n另一只大概在回去的路上。\n它讲不了什么，只是走累了。',
    relic_key_title: '温泉的钥匙',
    relic_key_text:
      '铜的，还带着锈。\n它说：我最后一次开门，是替你妈把门关上的。\n……摸到它的时候，我的手在抖。',

    // ---- 三十日期限 ----
    //
    // 律师函与反派第三场都写了"三十日"和"五天"，而在这之前它**从来不会走**。
    // 日期由已发生的事算出（打卡 +1 天 / 骑完一圈 +3 天），
    // 所以玩家没法顺便推进它，而**迷路真的要花掉日子**。
    hud_days_left: '余 %s 天',
    hud_days_over: '已过期 %s 天',
    objective_collect: '五件乐事散在这条路上。',
    objective_overdue: '期限过了。回十八驿把话说完。',
    day_passed: '第 %s 天',

    // ---- 骑行节拍（竹）----
    // **故意短**。窗口 1.15s，四个字要能在余光里扫到。
    beat_hit: '竹 %s/%s',
    beat_miss: '早了或晚了',
    beat_done: '竹：一段路，五个节拍，一口气骑完。',
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

    // ---- Camera (V) ----
    key_camera: 'V',
    cam_forward: 'Forward',
    cam_chase: 'Chase',
    cam_first: 'Rider',
    cam_switched: 'Camera · %s',

    // ---- Item bar (1~4) ----
    item_bar_title: 'Items',
    key_item_bar_desc: 'Number keys pick an item',
    item_none: 'No items yet',
    item_paper: 'Paper',
    item_ink: 'Ink',
    item_seal: 'Seal',
    item_env: 'Envelope',
    item_selected: 'Selected · %s',

    // ---- Vehicle (E) ----
    key_vehicle: 'E',
    stele_title: 'Stele No.188',
    villain_cue_title: 'Radio',
    veh_foot: 'On foot',
    veh_bike: 'Bicycle',
    veh_skate: 'Skateboard',
    veh_switched: 'Vehicle · %s',
    veh_locked: 'No skateboard yet',

    // ---- Relics you can touch (F) ----
    key_relic: 'F',
    key_relic_desc: 'Feel an old thing left by the road',
    relic_hint: '%s · press F to touch it',
    relic_near: 'Someone left something by the road.',
    relic_bowl_title: 'Celadon Bowl',
    relic_bowl_text:
      'My thumb finds the worn mark on its base.\nSix hundred years ago someone dropped it here, and picked it up piece by piece.\n...They glued it back worse than I would have.',
    relic_ring_title: 'Door Ring',
    relic_ring_text:
      'Bronze, worn down to a skin.\nI cannot count how many times it was pushed in six hundred years.\nThe last one to push it was my mother.',
    relic_ledger_title: 'The Ledger',
    relic_ledger_text:
      'The last page is from this year.\nThe guests are all still listed. The rent column is blank.\n...The account stopped on the day she left.',
    relic_shoe_title: 'One Shoe',
    relic_shoe_text:
      'The sole is worn through. Half a character for "road" is embroidered on the side.\nThe other one is probably on the way back.\nIt has nothing to tell me. It is just tired.',
    relic_key_title: 'The Key to the Spring',
    relic_key_text:
      'Bronze, still rusted.\nIt says: the last time I was turned, I was your mother shutting the door behind her.\n...My hand was shaking when I felt it.',

    // ---- The thirty-day deadline ----
    hud_days_left: '%s days left',
    hud_days_over: '%s days overdue',
    objective_collect: 'The five joys are scattered along this road.',
    objective_overdue: 'The deadline has passed. Go back to the Eighteenth Post and finish the conversation.',
    day_passed: 'Day %s',

    // ---- Riding beats (bamboo) ----
    // Deliberately short. The window is 1.15s; four words have to be
    // scannable in peripheral vision.
    beat_hit: 'Bamboo %s/%s',
    beat_miss: 'Too early or too late',
    beat_done: 'Bamboo: one stretch of road, five beats, ridden without stopping.',
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
console.log('supplement 新增', n, '条 key');

// ---- 同步写进 generated 侧（AGENTS.md 要求两份一起改）----
const g = JSON.parse(readFileSync(P_GEN, 'utf8'));
let m = 0;
const drift = [];
for (const lang of ['zh', 'en']) {
  for (const [k, v] of Object.entries(ADD[lang])) {
    if (k in g[lang]) {
      // 比的是 **supplement 的现值**，不是 `ADD` 里的值。
      // 两者可能已经不同了：某个 key 加进来之后又被单独改过
      // （`veh_locked` 就是——脚本里写的是"还没有滑板"，
      // 后来因为徒步模式先落地而改成了"只能徒步"）。
      // 拿 `ADD` 的旧值去比，会报出一个**并不存在**的不一致：
      // 实测两侧字节完全相同，而这条检查报了两条 drift。
      // 症状是"告警越多越没人看"，所以比对了正确的对象。
      if (g[lang][k] !== j[lang][k]) drift.push(`${lang}.${k}`);
      continue;
    }
    g[lang][k] = j[lang][k];
    m++;
  }
}
writeFileSync(P_GEN, JSON.stringify(g, null, 2) + '\n', 'utf8');
console.log('generated 新增', m, '条 key');
if (drift.length) {
  console.log('两侧已存在但内容不同（未覆盖，请人工确认）:', drift.join(', '));
}
