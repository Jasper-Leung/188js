/**
 * 界面上那几块常驻件的新判据：主线追踪器、Tab 转盘、交互提示、图标集。
 *
 * ## 为什么单独一个文件
 *
 * `AGENTS.md` §3 写着「拆导出 `registerXxxChecks(check)`，在 entry.ts
 * **原位**调用」。这四族东西是同一轮改动带来的，放在一起比拆成四个文件好读：
 * 它们互相咬合（追踪器报进度、转盘报目标、提示报当前动作、图标给三者上色）。
 *
 * ## 这些判据量的是**结构**，不是像素
 *
 * 无头没有排版引擎，所以「那颗提示好不好看」「转盘的圈挤不挤」
 * 这类问题这里一律量不到——它们要真机与浏览器。
 * 这里量的是**结构上不可能再犯的那几类错**：
 *
 * · 主线达成之后**还能继续探索**（达成态不清掉主线）。
 * · 转盘的按键**不外泄**（被吃掉的方向键不能再去转向）。
 * · 交互提示**够不着就整个收掉**（不是"亮着但按了没反应"）。
 * · 圈与提示**说同一件事时只留一份字**（圈指位置，提示说动作）。
 * · 叙事段落在场时**提示让路**（前景在前，背景让路）。
 * · 每个图标**都被界面用上**（新增图标忘了接线会红）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { GameStateManager } from '../game/state';
import { t } from '../i18n';
import { QuestTracker } from '../ui/questTracker';
import { RadialMenu, type RadialItem } from '../ui/radialMenu';
import { InteractPrompt, type PromptState } from '../ui/interactPrompt';
import { ringLabelText } from '../ui/hud';
import { ICON_NAMES, icon, iconButton } from '../ui/icons';
import { ECON, ROAD } from '../data/raw';
import { expect, type CheckFn } from './harness';

// 回归由 `npm run verify` 跑，cwd 就是仓库根。**不要**用 `__dirname`
// （单文件 ESM 里没有它）或 `import.meta.url` 反推——后者在 esbuild 打包后
// 指向临时目录。理由与 `ui_regressions.ts` 顶上那段完全一样。
const ROOT = process.cwd();

/**
 * 递归收 `src/ui` 下的 `.ts`（图标接线判据要扫它们）。
 *
 * ★ **`icons.ts` 自己不算**：它把每个图标名都写在类型联合里，
 *   而「图标有没有被界面用上」判据扫的就是 `'名字'` 这个字面量。
 *   把 `icons.ts` 算进去的话，**每个图标都必然"被用到"**——
 *   判据就成了一条永远绿的摆设，正好抵掉了它存在的理由。
 */
function uiSources(): string[] {
  const dir = join(ROOT, 'src', 'ui');
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && e.name !== 'icons.ts') out.push(p);
    }
  };
  walk(dir);
  out.push(join(ROOT, 'src', 'main.ts'));
  return out;
}

export function registerWidgetChecks(check: CheckFn, parent: () => HTMLElement): void {
  // ---------------------------------------------------------------- 主线状态

  /**
   * 主线状态层。
   *
   * 证的是**四件事**：
   * 1. 接下主线是**一次性**的（`enterWorld()` 会被走两次）。
   * 2. 进度是**算出来的**（收了几枚），不是另一个闩锁。
   * 3. 达成之后**主线不清掉**——完成主线之后还能继续探索这个世界。
   * 4. `reset()`（重开一趟）把主线也复位。
   */
  check('verify_main_quest_state', () => {
    const probs: string[] = [];
    let asserts = 0;
    const g = new GameStateManager();
    const FRAG = ROAD.FRAGMENT_SLOT_STATION_IDX;

    asserts++;
    if (g.mainQuestAccepted) probs.push('新档的主线竟然是「已接下」——它应该还没接');
    asserts++;
    if (g.mainQuestDone) probs.push('没接主线却算作达成');
    asserts++;
    if (g.mainQuestTotal !== FRAG.length) {
      probs.push(`主线要收 ${FRAG.length} 枚碎片，而 mainQuestTotal 报的是 ${g.mainQuestTotal}`);
    }

    asserts++;
    if (!g.acceptMainQuest()) probs.push('第一次接主线没有返回 true');
    asserts++;
    if (g.acceptMainQuest()) probs.push('第二次接主线又返回了 true——那个闩锁没闩住');

    asserts++;
    if (!g.mainQuestAccepted) probs.push('接下之后 mainQuestAccepted 仍然是 false');
    asserts++;
    if (g.mainQuestProgress !== 0) probs.push('刚接下主线时进度不是 0');

    // 进度跟着收集走。
    for (let i = 0; i < FRAG.length - 1; i++) {
      g.checkIn(FRAG[i]);
      asserts++;
      if (g.mainQuestProgress !== i + 1) {
        probs.push(`收了 ${i + 1} 枚，进度却报 ${g.mainQuestProgress}`);
      }
      asserts++;
      if (g.mainQuestDone) probs.push(`只收了 ${i + 1} 枚就报达成`);
    }
    g.checkIn(FRAG[FRAG.length - 1]);
    asserts++;
    if (!g.mainQuestDone) probs.push('五枚都收齐了却没报达成');
    asserts++;
    if (g.mainQuestProgress !== FRAG.length) probs.push('集齐之后进度不是 5');

    // ★ **达成之后仍然可以继续探索**：主线不被清掉，
    // 而「还能继续玩」这件事由追踪器的达成态说出来。
    asserts++;
    if (!g.mainQuestAccepted) probs.push('达成之后主线被清掉了——那一趟就到此为止了');
    asserts++;
    if (!g.mainQuestDone) probs.push('达成之后 mainQuestDone 变成了 false');
    // 达成之后还能继续打卡（完满评级要的就是这个）。
    const before = g.getStationCount(FRAG[0]);
    g.checkIn(FRAG[0]);
    asserts++;
    if (g.getStationCount(FRAG[0]) !== Math.min(before + 1, ECON.MAX_VISITS_PER_STATION)) {
      probs.push('达成之后继续打卡不计数了——世界不该在主线结束时停止');
    }

    // 重开一趟要复位。
    g.reset();
    asserts++;
    if (g.mainQuestAccepted) probs.push('重开之后主线仍然是「已接下」');
    asserts++;
    if (g.mainQuestDone) probs.push('重开之后主线仍然是「达成」');

    return expect(probs.length === 0, probs.join('；') || '主线一次性接下、进度算出来、达成之后还能继续探索', asserts);
  });

  // ---------------------------------------------------------------- 追踪器

  /**
   * 主线追踪器。
   *
   * 证的是**玩家眼前的那一行**：没接主线时不占地方；接了以后报出
   * 「已收几枚 / 共几枚」；达成以后换一句「继续探索这个世界」。
   *
   * 顺带证一件结构上的事：**每次同步不许重建 DOM**——
   * 重建会把焦点与过渡弄丢，而它每帧都要同步一次。
   */
  check('verify_quest_tracker', () => {
    const probs: string[] = [];
    let asserts = 0;
    const host = parent();
    const g = new GameStateManager();
    const FRAG = ROAD.FRAGMENT_SLOT_STATION_IDX;
    const tracker = new QuestTracker(host, g);

    const shown = (el: HTMLElement | null) => !!el && !el.classList.contains('g-hidden');
    // ⚠ **不能读 `tracker.root.textContent`**：无头的 DOM 桩不聚合
    // 子节点的文字（真 DOM 才会）。所以这里读那**两格**自己——
    // 玩家看到的也正是那两格。
    const titleEl = () => host.querySelector('.g-quest-t');
    const countEl = () => host.querySelector('.g-quest-n');

    asserts++;
    if (shown(tracker.root)) probs.push('没接主线时追踪器就占着地方了');

    g.acceptMainQuest();
    tracker.sync();
    asserts++;
    if (!shown(tracker.root)) probs.push('接了主线，追踪器仍然不显示');
    asserts++;
    if (!countEl()?.textContent?.includes('0/5')) {
      probs.push(`追踪器上的进度不是 0/5，读到的是「${countEl()?.textContent}」`);
    }
    asserts++;
    if (!titleEl()?.textContent) probs.push('追踪器上没有主线名');

    // 进度跟着收集走。
    g.checkIn(FRAG[0]);
    g.checkIn(FRAG[1]);
    tracker.sync();
    asserts++;
    if (!countEl()?.textContent?.includes('2/5')) {
      probs.push(`收了 2 枚，追踪器上写的却是「${countEl()?.textContent}」`);
    }

    // DOM 不重建。
    const rootBefore = tracker.root;
    tracker.sync();
    asserts++;
    if (tracker.root !== rootBefore) probs.push('同步时把追踪器整个重建了——它每帧都跑一次');

    // 达成态。
    for (let i = 2; i < FRAG.length; i++) g.checkIn(FRAG[i]);
    tracker.sync();
    asserts++;
    if (!tracker.root.classList.contains('is-done')) probs.push('集齐之后追踪器没有换成达成态');
    asserts++;
    if (!countEl()?.textContent?.includes('5/5')) {
      probs.push(`达成之后追踪器上的进度不是 5/5，读到的是「${countEl()?.textContent}」`);
    }
    asserts++;
    if (!titleEl()?.textContent) probs.push('达成之后追踪器上没有那一句');

    return expect(probs.length === 0, probs.join('；') || '追踪器按主线状态显示进度，达成后换一句「继续探索」，且不重建 DOM', asserts);
  });

  // ---------------------------------------------------------------- 转盘

  /**
   * Tab 转盘。
   *
   * 证的是**按键归属**：转盘开着的时候，方向键 / Enter / Esc 归它，
   * 不归游戏；而它关着的时候那些键**不归它**（`handleKey` 返回 false，
   * 于是宿主照常处理方向键与 Esc）。
   *
   * 这条是"Tab 会不会把骑行弄坏"的分界线：
   * 方向键在骑行相位是转向，Esc 是暂停——
   * 转盘吃掉了却没告诉宿主，那两件事就一起失灵了。
   */
  check('verify_radial_menu', () => {
    const probs: string[] = [];
    let asserts = 0;
    const host = parent();
    const menu = new RadialMenu(host);
    const fired: string[] = [];
    const items: RadialItem[] = [
      { id: 'a', icon: 'bag', label: () => 'A', run: () => fired.push('a') },
      { id: 'b', icon: 'camera', label: () => 'B', disabled: true, run: () => fired.push('b') },
      { id: 'c', icon: 'pause', label: () => 'C', run: () => fired.push('c') },
    ];
    menu.setItems(items);

    asserts++;
    if (menu.isOpen) probs.push('刚建好的转盘是开着的');
    asserts++;
    if (menu.handleKey('ArrowRight')) probs.push('关着的转盘把方向键吃了——宿主就没法转向了');
    asserts++;
    if (menu.handleKey('Escape')) probs.push('关着的转盘把 Esc 吃了——宿主就没法暂停了');

    menu.open();
    asserts++;
    if (!menu.isOpen) probs.push('open() 之后仍然是关着的');

    // 方向键换选中项，而且**跳过禁用的那一项**。
    menu.handleKey('ArrowRight');
    asserts++;
    const sel = () => {
      const btns = host.querySelectorAll('.g-radial-item');
      for (const b of btns) if (b.classList.contains('is-sel')) return b;
      return null;
    };
    asserts++;
    if (!sel()) probs.push('按了方向键之后没有一颗被选中');
    asserts++;
    if (sel()?.getAttribute('aria-label')?.indexOf('C') !== 0) {
      probs.push(`方向键停在了「${sel()?.getAttribute('aria-label')}」上——它应该跳过禁用项落在 C`);
    }

    // Enter 激活选中的那一项，然后关掉。
    menu.handleKey('Enter');
    asserts++;
    if (fired.join(',') !== 'c') probs.push(`Enter 触发的是「${fired.join(',')}」，不是选中的那一项`);
    asserts++;
    if (menu.isOpen) probs.push('确认之后转盘还开着');

    // Esc 关掉。
    menu.open();
    menu.handleKey('Escape');
    asserts++;
    if (menu.isOpen) probs.push('Esc 没有关掉转盘');

    // Tab 在圈里换项（不外泄）。
    menu.open();
    const selBefore = sel()?.getAttribute('aria-label');
    const took = menu.handleKey('Tab');
    asserts++;
    if (!took) probs.push('转盘开着时 Tab 没有被吃掉——焦点会跑出转盘');
    asserts++;
    if (sel()?.getAttribute('aria-label') === selBefore) probs.push('Tab 没有在圈里换项');
    menu.close();

    // 换同一圈条目时**不许重建按钮**（重建会把焦点弄丢）。
    menu.setItems(items);
    const count = host.querySelectorAll('.g-radial-item').length;
    menu.setItems(items);
    asserts++;
    if (host.querySelectorAll('.g-radial-item').length !== count) {
      probs.push('换同一圈条目时按钮被重建了——焦点会跟着丢');
    }

    return expect(probs.length === 0, probs.join('；') || '转盘的按键归属清楚、跳过禁用项、确认即关闭、换条目不重建 DOM', asserts);
  });

  // ---------------------------------------------------------------- 交互提示

  /**
   * 交互提示。
   *
   * 证的是**「够得着才在」**：没有可交互的东西时它整个收掉，
   * 有的时候才亮——而不是"一直亮着但按了没反应"。
   *
   * 顺带证键帽显示的是**玩家此刻真正要按的那把键**
   * （`KeyF` → `F`），而不是写死的字。
   */
  check('verify_interact_prompt', () => {
    const probs: string[] = [];
    let asserts = 0;
    const host = parent();
    const prompt = new InteractPrompt(host);
    const shown = () => !prompt.root.classList.contains('g-hidden');

    asserts++;
    if (shown()) probs.push('刚建好的提示就显示着——它应该等有东西才亮');
    asserts++;
    if (prompt.shown) probs.push('prompt.shown 在什么都没有的时候就是 true');

    let picks = 0;
    prompt.set({ icon: 'hand', label: 'Reach out', key: 'KeyF', kind: 'relic', onPick: () => { picks++; } });
    asserts++;
    if (!shown()) probs.push('设了状态之后提示仍然不显示');
    asserts++;
    if (!prompt.shown) probs.push('prompt.shown 在有状态的时候是 false');
    // ★ 它必须报得出**哪一族动作**——脚下那一圈靠它判断「你们说的是不是同一件事」。
    asserts++;
    if (prompt.kind !== 'relic') {
      probs.push(`提示没有报出它属于哪一族（读到的是 ${prompt.kind}）—— 圈与提示的「字只留一份」无从判断`);
    }
    // 键帽与动作名是**两格**，各自读自己（DOM 桩不聚合子节点文字）。
    asserts++;
    if (!host.querySelector('.g-prompt-key')?.textContent?.includes('F')) {
      probs.push(`键帽上没有 F，读到的是「${host.querySelector('.g-prompt-key')?.textContent}」`);
    }
    asserts++;
    if (!host.querySelector('.g-prompt-t')?.textContent?.includes('Reach out')) {
      probs.push('提示上没有动作名');
    }

    // 点一下就跑一次。
    const btn = host.querySelector<HTMLButtonElement>('.g-prompt-btn');
    asserts++;
    if (!btn) probs.push('提示上那颗按钮不见了');
    else {
      btn.click();
      asserts++;
      if (picks !== 1) probs.push(`点了一下提示，动作却跑了 ${picks} 次`);
    }

    // 收掉。
    prompt.set(null);
    asserts++;
    if (shown()) probs.push('清空之后提示仍然显示着——它会一直亮着而按了没反应');
    asserts++;
    if (prompt.shown) probs.push('清空之后 prompt.shown 仍然是 true');
    asserts++;
    if (prompt.kind !== null) probs.push(`清空之后提示还报着 ${prompt.kind}——圈会以为它还在说话`);

    return expect(probs.length === 0, probs.join('；') || '提示够得着才亮、键帽是玩家真正要按的那把键、清空就整个收掉', asserts);
  });

  // ------------------------------------------------- 圈上的字与提示的字只留一份

  /**
   * 圈上的字与提示的字：**同一件事只留一份**。
   *
   * ## 它治的是哪一处
   *
   * 驿站那一族本来就有脚下提示圈（写着「空格 · 进入小铺」），
   * 而屏幕下方那颗交互提示说的是同一件事。两处同时出声，
   * 同一个动作在屏上被念两遍——那不叫"多一条信息"，那叫"界面吵"。
   *
   * ## 规则
   *
   * **圈负责指位置（空间），提示负责说动作（文字 + 键帽）。**
   * 两者指向**同一个动作**时，圈上那行**可见文字**让位；
   * 提示说的是别的东西时，圈上的字照旧。
   *
   * ## 为什么比的是 `kind` 而不是文案
   *
   * 文案是拼出来的（`空格 · 进入小铺` / `Space · Enter shop` / 触屏那套又是
   * 另一句），提示那侧的文案也随语言与触屏模式变。比字符串的话，
   * **两边文案一改就可能不再相等**，于是「字只留一份」这条会悄悄失效，
   * 而屏上还是两处都在说话。
   * `kind` 是**动作本身**，两边都从同一族判据出来（`interactAt()` 与
   * `world.roadsideCandidates()`），所以它不随语言变，也不会各自漂。
   */
  check('verify_ring_label_text', () => {
    const probs: string[] = [];
    let asserts = 0;
    const shop = '空格 · 进入小铺';

    // ---- 同一族 → 圈让位 ----
    asserts++;
    if (ringLabelText(shop, 'shop', 'shop') !== '') {
      probs.push('圈与提示说的是同一件事（shop）时，圈上的字没有让位——同一个动作在屏上被念两遍');
    }
    asserts++;
    if (ringLabelText(shop, 'home', 'home') !== '') {
      probs.push('圈与提示说的是同一件事（home）时，圈上的字没有让位');
    }
    asserts++;
    if (ringLabelText(shop, 'checkin', 'checkin') !== '') {
      probs.push('圈与提示说的是同一件事（checkin）时，圈上的字没有让位');
    }

    // ---- 提示没亮 → 圈上的字照旧（圈是唯一在指位置的那一个）----
    asserts++;
    if (ringLabelText(shop, 'shop', null) !== shop) {
      probs.push('提示没亮时圈上的字不见了——那一族就再也没人告诉玩家该按哪把键');
    }

    // ---- 提示说的是别的东西 → 圈上的字照旧 ----
    asserts++;
    if (ringLabelText(shop, 'shop', 'checkin') !== shop) {
      probs.push('提示说的是另一件事时，圈上的字也被收走了——两句都不在，玩家什么都不知道');
    }
    asserts++;
    if (ringLabelText(shop, 'checkin', 'shop') !== shop) {
      probs.push('提示说的是另一件事时，圈上的字也被收走了');
    }
    // 旧物那一族没有圈（圈只对驿站那一族存在），所以提示说旧物时不该误伤。
    asserts++;
    if (ringLabelText(shop, 'shop', 'relic') !== shop) {
      probs.push('提示说的是旧物那一族时，圈上的字也被收走了');
    }

    // ---- 接线：规则定义了得真接上去 ----
    const hudSrc = readFileSync(join(ROOT, 'src', 'ui', 'hud.ts'), 'utf8');
    asserts++;
    if (!/ringLabelText\(/.test(hudSrc)) {
      probs.push('hud.ts 没有调用 ringLabelText()——规则定义了却没接上去，圈上的字仍会与提示重复');
    }
    // ★ 无障碍名要**写全**：圈上的字让位之后，读屏器就再也听不到这件事了。
    asserts++;
    if (!/'aria-label',\s*label\)/.test(hudSrc)) {
      probs.push('圈的无障碍名没有写全（用了让位后的空串）——圈上的字一让位，读屏器也听不到了');
    }
    asserts++;
    if (!/setShown\(this\.ringLabel,\s*!!visible\)/.test(hudSrc)) {
      probs.push('圈上的字让位后没有被隐藏——空字符串还占着位置');
    }

    return expect(
      probs.length === 0,
      probs.join('；') || '圈与提示说同一件事时只留一份字，说别的事时圈上的字照旧，且无障碍名写全',
      asserts,
    );
  });

  // ------------------------------------------------- 叙事段落在场时提示让路

  /**
   * 叙事段落在场时，**提示让路**。
   *
   * ## 它治的是哪一处
   *
   * 叙事卡那一屏有自己的按钮（「继续 / 提前关闭」「跳到最后一句」），
   * 而提示的药丸摆在屏幕下方中线——手机横屏时两者**重叠**，
   * 并且提示的层级更高：那一块既被字压住，点下去还会打到提示上
   * （它会触发一次确认动作）。玩家想推进叙事，结果触发了打卡。
   *
   * ## 规则
   *
   * **前景在前，背景让路。** 叙事段落是前景，提示是背景。
   *
   * ## 闸门为什么做在组件自己身上
   *
   * 宿主那一层要同时拿到「有没有叙事段落」与「有没有可交互的东西」，
   * 漏判一次就是屏上两颗药丸叠在一起。而闸门做在提示组件自己身上，
   * **谁来 `set()` 都绕不过它**——所以这条判据守的是组件的行为，
   * 另有一条源码判据守「UI 层真的把闸门接上了 `storyBusy`」。
   */
  check('verify_prompt_yields_to_story', () => {
    const probs: string[] = [];
    let asserts = 0;
    const host = parent();
    let busy = false;
    const prompt = new InteractPrompt(host, { blocked: () => busy });
    const shown = () => !prompt.root.classList.contains('g-hidden');
    const state = (onPick: () => void): PromptState => ({
      icon: 'hand',
      label: 'Reach out',
      key: 'KeyF',
      kind: 'relic',
      onPick,
    });

    // ---- 没挡 → 亮 ----
    let picks = 0;
    prompt.set(state(() => { picks++; }));
    asserts++;
    if (!shown()) probs.push('没有东西挡时提示不亮——那不是让路，是坏了');
    asserts++;
    if (prompt.kind !== 'relic') probs.push('提示没有报出它属于哪一族');

    // ---- 叙事段落在场 → 整个收掉 ----
    busy = true;
    prompt.set(state(() => { picks++; }));
    asserts++;
    if (shown()) probs.push('叙事段落在场时提示仍然亮着——手机横屏时它会压住叙事卡那颗按钮');
    asserts++;
    if (prompt.shown) probs.push('被挡住时 prompt.shown 仍然是 true');
    asserts++;
    if (prompt.kind !== null) {
      probs.push('被挡住时提示还报着 kind——脚下那一圈会以为「已经有人在说这件事」而继续让位');
    }

    // ---- 被挡住时点它不得触发动作 ----
    const btn = host.querySelector<HTMLButtonElement>('.g-prompt-btn');
    asserts++;
    if (!btn) probs.push('提示上那颗按钮不见了');
    else {
      btn.click();
      asserts++;
      if (picks !== 0) probs.push('被挡住时点提示仍然触发了动作——那一块点下去会触发打卡');
    }

    // ---- 叙事段落退场 → 提示回来 ----
    busy = false;
    prompt.set(state(() => { picks++; }));
    asserts++;
    if (!shown()) probs.push('叙事段落退场后提示没有回来——它会一直缺席');
    asserts++;
    if (prompt.kind !== 'relic') probs.push('提示回来之后没有报出它属于哪一族');

    // ---- 接线：闸门真的接上 `storyBusy` 了吗 ----
    const uiSrc = readFileSync(join(ROOT, 'src', 'ui', 'index.ts'), 'utf8');
    asserts++;
    if (!/blocked:\s*\(\)\s*=>\s*this\.storyBusy/.test(uiSrc)) {
      probs.push('UI 层没有把闸门接到 storyBusy 上——叙事段落与提示又会叠在一起');
    }
    // 宿主那一层**不许**自己再判一次：两处各判一次，迟早有一处先改。
    const mainSrc = readFileSync(join(ROOT, 'src', 'main.ts'), 'utf8');
    asserts++;
    if (!/this\.ui\.setPrompt\(/.test(mainSrc)) {
      probs.push('宿主没有把提示状态交给 UI.setPrompt()——闸门就被绕过去了');
    }

    return expect(
      probs.length === 0,
      probs.join('；') || '叙事段落在场时提示整个收掉且不接点击，退场后回来，闸门接在 storyBusy 上',
      asserts,
    );
  });

  // ---------------------------------------------------------------- 图标集

  /**
   * 图标集。
   *
   * 三条：
   * 1. **每个图标都得被界面用上**。新增一个图标却忘了接线，
   *    症状是"图标集里多了一个谁也不显示的图形"——而那在画面上完全看不出来。
   * 2. 图标一律 `aria-hidden`（它不是给读屏器读的；无障碍名由按钮承担）。
   * 3. `iconButton()` **不许**产出没有无障碍名的按钮。
   */
  check('verify_icon_set', () => {
    const probs: string[] = [];
    let asserts = 0;

    // 1. 接线。
    const blob = uiSources().map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const name of ICON_NAMES) {
      asserts++;
      if (!blob.includes(`'${name}'`)) {
        probs.push(`图标「${name}」在整个界面里一次也没出现——它多半是新增后忘了接线`);
      }
    }

    // 2. aria-hidden。
    const host = parent();
    const svg = icon('quest');
    asserts++;
    if (svg.getAttribute('aria-hidden') !== 'true') {
      probs.push('图标没有 aria-hidden——读屏器会把每个图形都念一遍');
    }
    // 它必须真的能挂进 DOM（内联 SVG 不是文字节点，
    // 而这个桩的 `appendChild` 与真 DOM 一样只认节点）。
    // ⚠ 判据读的是 `querySelectorAll` 而不是 `host.children`：
    //   桩的 `parent()` 会把 `children` 换成**另一个空数组**，
    //   而 `appendChild` 写的是闭包里那一份 —— 于是 `children` 上永远看不见
    //   刚挂上去的东西。真 DOM 上 `children` 是活的，所以这两种写法在浏览器里
    //   都过；只有无头这里会误报「挂不进去」。
    host.appendChild(svg);
    asserts++;
    if (host.querySelectorAll('svg').length !== 1) {
      probs.push('图标挂不进 DOM——内联 SVG 这条路走不通');
    }

    // 3. 无障碍名必填。
    asserts++;
    let threw = false;
    try {
      iconButton('quest', '');
    } catch {
      threw = true;
    }
    if (!threw) probs.push('iconButton() 在没有 aria-label 时没有抛错——它会产出一颗读屏念不出名字的按钮');

    return expect(probs.length === 0, probs.join('；') || '每个图标都接上了线、图标对读屏器隐形、图标按钮必须有无障碍名', asserts);
  });

  // ---------------------------------------------------------------- 接线（源码级）

  /**
   * 接线：Tab / 主线 / 提示，三件事在**源码上**的落点。
   *
   * ## 为什么这一族只能读源码
   *
   * 「Tab 会不会把骑行弄坏」「进游戏有没有接主线」——这两件事都要
   * **整台机器**跑起来才问得到，而无头回归里没有那台机器（`World`
   * 建不出来）。
   *
   * 所以这里读源码，守的是**接线的形状**：
   * · Tab 的那一支必须带 `!e.shiftKey`（Shift+Tab 永远交给浏览器）。
   * · `enterWorld()` 里必须有 `acceptMainQuest()`。
   * · 提示与转盘必须在样式表里有位置（`display:none` 之外的规则）。
   *
   * 它证不了「按下去真的有反应」——那要真机。
   */
  check('verify_widget_wiring', () => {
    const probs: string[] = [];
    let asserts = 0;
    const mainSrc = readFileSync(join(ROOT, 'src', 'main.ts'), 'utf8');
    const css = readFileSync(join(ROOT, 'src', 'ui', 'styles.css'), 'utf8');

    // 1. Tab 的那一支。
    asserts++;
    if (!/e\.code === 'Tab'/.test(mainSrc)) probs.push('main.ts 里没有 Tab 的分支——转盘开不了');
    asserts++;
    if (!/!e\.shiftKey/.test(mainSrc)) {
      probs.push('Tab 的那一支没有排除 Shift+Tab——键盘玩家会失去「往回移动焦点」那条退路');
    }
    asserts++;
    if (!/handleRadialKey/.test(mainSrc)) {
      probs.push('main.ts 没有把按键交给转盘——方向键会在转盘开着的时候同时拿去转向');
    }

    // 2. 主线的触发点。
    asserts++;
    if (!/acceptMainQuest\(\)/.test(mainSrc)) {
      probs.push('main.ts 没有接下主线——玩家进游戏之后看不到主线');
    }
    const enterAt = mainSrc.indexOf('private enterWorld()');
    asserts++;
    if (enterAt < 0) probs.push('main.ts 里找不到 enterWorld()');
    else {
      const body = mainSrc.slice(enterAt, enterAt + 1400);
      asserts++;
      if (!body.includes('acceptMainQuest()')) {
        probs.push('acceptMainQuest() 不在 enterWorld() 里——主线的触发条件不是「刚进入游戏」');
      }
    }

    // 3. 三块新界面在样式表里各有位置。
    for (const sel of ['.g-quest', '.g-prompt', '.g-radial']) {
      asserts++;
      if (!css.includes(sel)) probs.push(`样式表里没有 ${sel} 的规则——那一块会没有样式`);
    }

    // 4. 转盘不许与面板抢层级：转盘 40、面板 50。
    asserts++;
    const radialZ = /\.g-radial \{[^}]*z-index:\s*40/.test(css);
    asserts++;
    if (!radialZ) probs.push('.g-radial 的 z-index 不是 40——它会被面板盖住，或者反过来盖住面板');
    asserts++;
    if (!/\.g-screen \{[^}]*z-index:\s*50/.test(css)) {
      probs.push('.g-screen 的 z-index 不是 50——转盘与面板的层级关系变了');
    }

    // 5. ★ 转盘必须**露出来**：引导页与速查表里都要有 Tab。
    //
    //    转盘是这一轮新增的入口，而它**没有键帽出现在任何界面上**——
    //    玩家不知道有 Tab，就永远开不出它，功能等于没有。
    //    而「说明里有 Tab」这件事会被顺手改掉（速查表是一整段文本），
    //    所以这里把它钉住。
    asserts++;
    const onboardSrc = readFileSync(join(ROOT, 'src', 'ui', 'onboarding.ts'), 'utf8');
    if (!/key_radial_desc/.test(onboardSrc) || !/'Tab'/.test(onboardSrc)) {
      probs.push('引导页的键位表里没有 Tab —— 快捷转盘没有入口，玩家不会知道它存在');
    }
    asserts++;
    if (!t('help_overlay').includes('Tab')) {
      probs.push('速查表（help_overlay）里没有 Tab —— 标题页与暂停面板的「操作说明」都读不到它');
    }

    return expect(probs.length === 0, probs.join('；') || 'Tab 那一支、主线触发点、三块新界面的位置与层级都在，转盘也在说明里露了面', asserts);
  });
}
