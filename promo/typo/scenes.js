// 排版段落的场景表。所有时间以毫秒计。
//
// 段 1 Smile        0    - 5500
//    ↓ 5.5s 切到古代文人聚会（AI 实拍，8s，占 5500-13500）
// 段 2 Smile->miles 13500 - 21500   S 滑到末尾
// 段 3 辞职         21500 - 29000
// 段 4 Lu           29000 - 34000
// 段 5 Lu->路       34000 - 39000
// 段 6 Road         39000 - 43000

const S = (a, b, type, payload, label) => [a, b, type, payload, label];

// 200px Georgia 的字距约 0.60em = 120px；S 从首位挪到末尾要跨 5 个字位。
const ADV = 120;
const TRAVEL = ADV * 5;

export default [
  // ---- 段 1：Smile ----
  S(0, 5500, 'word', {
    chars: [{ c: 'S' }, { c: 'm' }, { c: 'i' }, { c: 'l' }, { c: 'e' }],
    grow: [250, 900],
  }, 'a name that means nothing yet'),

  // ---- 段 2：Smile -> Miles（把 S 挪到末尾并变小写，同时 m 变大写）----
  S(13500, 21500, 'word', {
    chars: [{ c: 'S' }, { c: 'm' }, { c: 'i' }, { c: 'l' }, { c: 'e' }],
    grow: [13800, 14200],
    // 下标是**重排前**的下标：0 = S，1 = m
    flip: { from: 0, to: 4, at: 15200, dur: 2000, cases: { 0: 's', 1: 'M' } },
  }, 'the same letters, read differently'),

  // ---- 段 3：辞职 ----
  S(21500, 29000, 'caption', {
    lines: [
      'He had already quit the job he was supposed to stay in.',
      'The family business was his to take or not take.',
      'He had not said yes yet.',
    ],
    fade: [22100, 24100],
  }),

  // ---- 段 4：Lu ----
  S(29000, 34000, 'word', {
    chars: [{ c: 'L' }, { c: 'u' }],
    grow: [29400, 30100],
  }, 'what he was called'),

  // ---- 段 5：Lu -> 路 ----
  S(34000, 39000, 'word', {
    chars: [{ c: 'L' }, { c: 'u' }],
    grow: [34400, 34800],
    swap: [35000, 37200, [[0, '路', true], [1, '', false]]],
  }, 'what his family called him'),

  // ---- 段 6：路 -> Road ----
  S(39000, 43000, 'word', {
    chars: [{ c: 'R', cjk: true }, { c: 'o' }, { c: 'a' }, { c: 'd' }],
    grow: [39400, 39900],
  }, 'what the mountain called it'),
];
