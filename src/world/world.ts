/**
 * 世界编排 —— 把渲染、地形、路面、水、植被、驿站、天穹、骑行装配起来，
 * 并驱动整条玩法流程。
 *
 * 这里是**唯一**知道"玩家在第几圈、附近有哪座驿站、该不该触发剧情"的地方。
 * UI 只读这里推出去的状态，不自己算——三块互相打架的指示牌就是这么来的。
 */
import { Scene, Color, Vector3, Object3D, PerspectiveCamera, type Mesh, type Material, type BufferGeometry } from 'three';
import { Renderer } from '../core/renderer';
import { PRESETS, type QualityPreset } from '../core/settings';
import type { Tier } from '../core/capability';
import { Terrain } from './terrain';
import { Road, ROAD } from './road';
import { Water } from './water';
import { Vegetation } from './vegetation';
import { Scenery, type SceneryKind } from './scenery';
import { Stations } from './stations';
import { Sky } from './sky';
import { Ride, type RideInput } from './ride';
import { loadModel, modelUrl } from './assets';
import { collectClips } from './vehicle';
import { CENTERLINE, TOTAL_ARCLENGTH, STATIONS, pointAtArcLength, nearestArcParam } from '../data/route';
import { WORLD, ECON, MINIGAMES } from '../data/raw';
import { game } from '../game/state';
import { t, isEnglish } from '../i18n';
import { checkConsistency } from './basins';
import { clamp } from '../core/math';

export type WorldEvent =
  | { type: 'stationPassed'; index: number }
  | { type: 'dialogue'; speaker: string; lines: string[] }
  | { type: 'villain'; sceneIndex: number }
  /** 顺路读到的一句话（驿站/石碑）。**不锁操作、不吃点击** */
  | { type: 'storyLine'; stationIndex: number; title: string; text: string }
  /** 反派引子：压暗 1 秒，不锁操作、不结束任何东西 */
  | { type: 'villainCue'; sceneIndex: number; text: string }
  | { type: 'duskBegan' }
  | { type: 'loaded'; what: string };

export type CheckInStage = 'none' | 'prompt' | 'moving' | 'holding' | 'outro' | 'busy';

export interface NearbyInfo {
  index: number;
  distance: number;
  /** 这座驿站还欠到访吗（顶栏/小地图/脚下圈三处都问这一个） */
  needsVisit: boolean;
  hasFragment: boolean;
  visitsLeft: number;
  shopName: string;
  /**
   * 玩家正站在**十八驿**门口，而且这一章正在等他回来。
   *
   * 0 号驿站没有碎片，所以 `needsVisit` 永远是 false，`fragmentStationNeedsVisit()`
   * 不会为它开口。要让"回家"能被触发，得有一个单独的判据——
   * 但**只有这一个**。顶栏的箭头、打卡按钮的高亮、脚下提示圈全看它，
   * 三处不许各判一次。
   */
  isHome: boolean;
}

export class World {
  readonly renderer: Renderer;
  readonly scene: Scene;
  readonly terrain: Terrain;
  readonly road: Road;
  readonly water: Water;
  readonly veg: Vegetation;
  readonly scenery: Scenery;
  readonly stations: Stations;
  readonly sky: Sky;
  readonly ride: Ride;
  readonly camera: PerspectiveCamera;

  private listeners = new Set<(e: WorldEvent) => void>();
  private preset: QualityPreset;

  /** 里程表（内部经济单位，不出现在任何玩家可见的界面上） */
  private odometer = 0;
  private lap = 1;
  private lastArc = 0;
  private lastPos = new Vector3();
  private time = 0;

  private interactCooldown = 0;
  private lastCheckInPos = new Vector3(1e9, 1e9, 1e9);
  private recheckArmed = true;
  private passInside = new Set<number>();
  private steleInside = new Set<number>();
  private stationModelTimer = 0;
  private duskAnnounced = false;

  /** 打卡流程 */
  checkInStage: CheckInStage = 'none';
  checkInTarget = -1;
  private stageT = 0;
  private onCheckInComplete: ((stationIdx: number) => void) | null = null;
  /** 这一次过场念的是"回家"那三句，而不是这座驿站自己的对白 */
  private homeBeat = false;

  /** 剧情播放中（对话/反派戏）时锁操作 */
  narrativeBusy = false;

  readonly nearby: NearbyInfo = {
    index: -1,
    distance: 999,
    needsVisit: false,
    hasFragment: false,
    visitsLeft: 0,
    shopName: '',
    isHome: false,
  };

  /** 路边彩蛋（碑）的触发 */
  onRoadsideLine: ((text: string) => void) | null = null;
  /** 分站音乐变奏：-1 = 回到原样，0..4 = 云茶琴竹禽 */
  onBgmMood: ((slot: number) => void) | null = null;
  private bgmMoodSlot = -1;

  constructor(canvas: HTMLCanvasElement, tier: Tier, preset: QualityPreset) {
    
    this.preset = preset;

    // 相机在这里建，渲染器与骑行模块共用同一个实例
    const camera = new PerspectiveCamera(62, 1, 0.25, 900);
    this.camera = camera;

    this.renderer = new Renderer(canvas, tier, preset, camera);
    this.scene = this.renderer.scene;

    // 构造耗时逐段记账。启动慢在这台机器上占了 8 秒以上，
    // 而"哪一段慢"和"整体慢"是完全不同的两种问题——不记就永远只能猜。
    const t0 = performance.now();
    let last = t0;
    const step = (label: string) => {
      const now = performance.now();
      console.log(`[gift188] 建世界 · ${label} ${(now - last).toFixed(0)}ms`);
      last = now;
    };

    // 顺序有讲究：Terrain 构造里会 planBasins()，水面与地形都依赖那三只碗
    this.terrain = new Terrain(preset);
    step('地形');
    this.road = new Road(this.terrain);
    step('路面');
    this.road.addTo(this.scene);
    this.water = new Water(preset.waterDetail);
    step('水面');
    this.veg = new Vegetation(preset, this.terrain);
    step('植被布置');
    this.scenery = new Scenery(this.terrain);
    step('区域散布');
    this.stations = new Stations(preset, this.terrain);
    step('驿站');
    this.sky = new Sky(this.scene, preset.shadowMapSize, preset.shadowDistance || 120);
    step('天穹');

    this.scene.add(this.terrain.mesh, this.water.group, this.veg.group, this.scenery.group, this.stations.group);

    this.ride = new Ride(this.terrain, this.road, this.stations, camera);
    this.scene.add(this.ride.root);
    console.log(`[gift188] 建世界合计 ${(performance.now() - t0).toFixed(0)}ms`);

    // 出发点：0 号驿站旁的路面
    const st0 = STATIONS[0];
    const near = nearestOnCenterline(st0.x, st0.z);
    this.ride.spawn(near.x, near.z, 0);
    this.lastPos.copy(this.ride.pos);
    this.lastArc = nearestArcParam(near.x, near.z);
  }

  on(fn: (e: WorldEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(e: WorldEvent) {
    this.listeners.forEach((fn) => fn(e));
  }

  get fogColor(): Color {
    return (this.scene.fog as { color: Color }).color;
  }
  get progressRatio(): number {
    return this.odometer / TOTAL_ARCLENGTH;
  }
  get currentLap(): number {
    return this.lap;
  }

  // ---------------------------------------------------------------- 定步长
  fixedUpdate(dt: number, input: RideInput, canRide: boolean) {
    this.time += dt;
    this.interactCooldown = Math.max(0, this.interactCooldown - dt);

    // **只认 canRide 一个来源。** 曾经这里自己也判一遍
    // `narrativeBusy || checkInStage !== 'none'`，而 canRide 那边又判一遍——
    // 两处判同一件事，迟早有一处先改、另一处没改，于是"某个组合下
    // 车的输入被两套规则用不同的口径否决"。判据集中在 game/phase.ts，
    // 这里只负责转发。
    this.ride.setCanMove(canRide);
    this.ride.fixedUpdate(dt, input);

    this.advanceCheckIn(dt);
  }

  // ---------------------------------------------------------------- 每帧
  render(dt: number) {
    this.ride.render(dt);
    this.sky.attachTo(this.ride.camera);
    this.sky.updateShadowFocus(this.ride.pos.x, this.ride.pos.y, this.ride.pos.z);

    const vis = game.getVisibilityFactor();
    this.veg.update(this.ride.pos.x, this.ride.pos.z, vis);
    this.scenery.update(this.ride.pos.x, this.ride.pos.z, vis);

    // 地标渐进加载：每 0.4s 放一座。一次性涌进来会在弱机上造成明显长卡顿。
    this.stationModelTimer += dt;
    if (this.stationModelTimer > 0.4) {
      this.stationModelTimer = 0;
      this.stations.update(this.ride.pos.x, this.ride.pos.z);
    }

    this.water.update(this.time, this.sky.state.sunDir, {
      color: this.fogColor,
      near: this.preset.fogNear,
      far: this.preset.fogFar,
    }, this.sky.state.dusk);

    this.renderer.render();
  }

  // ---------------------------------------------------------------- 里程与圈数
  private updateOdometer() {
    const moved = Math.hypot(this.ride.pos.x - this.lastPos.x, this.ride.pos.z - this.lastPos.z);
    this.odometer += moved;
    this.lastPos.copy(this.ride.pos);

    // 里程**只作经济口径**，不给玩家看（km 一换算就是 2km/s，
    // 玩家三十秒就能算出 7200km/h，然后整个数字失去可信度）
    game.progressKm = this.odometer / 1000;
    game.earnKm(game.progressKm);

    // 圈数：看中心线参数有没有绕回去
    const arc = nearestArcParam(this.ride.pos.x, this.ride.pos.z);
    if (this.lastArc > 0.85 && arc < 0.15) this.lap++;
    else if (this.lastArc < 0.15 && arc > 0.85) this.lap = Math.max(1, this.lap - 1);
    this.lastArc = arc;

    // 昼夜：第二圈起才推进
    const lapProgress = (this.odometer % TOTAL_ARCLENGTH) / TOTAL_ARCLENGTH;
    this.sky.setByProgress(this.lap, lapProgress);
    if (this.lap >= 2 && this.sky.state.dusk > 0.35 && !this.duskAnnounced) {
      this.duskAnnounced = true;
      this.emit({ type: 'duskBegan' });
    }
  }

  /** 每帧调用一次（在 fixedUpdate 之后） */
  postFixedUpdate() {
    this.updateOdometer();
    this.updateProximity();
    this.updateVillain();
  }

  // ---------------------------------------------------------------- 驿站
  private updateProximity() {
    const p = this.ride.pos;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.stations.list.length; i++) {
      const st = this.stations.list[i];
      const d = Math.hypot(st.worldPos.x - p.x, st.worldPos.z - p.z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    this.nearby.index = best;
    this.nearby.distance = bestD;
    if (best < 0) return;
    const st = this.stations.list[best];
    this.nearby.hasFragment = st.placement.hasFragment;
    this.nearby.needsVisit = game.fragmentStationNeedsVisit(best);
    this.nearby.visitsLeft = st.placement.slot >= 0 ? game.fragmentSlotVisitsLeft(st.placement.slot) : 0;
    this.nearby.shopName = game.shopAtStation(best);
    // 十八驿判据。半径比碎片驿站**宽一档**：0 号驿站门口有台阶，
    // 用 `STATION_PASS_RADIUS` 的话玩家骑到路对面就触发，看不清自己到了哪儿。
    this.nearby.isHome = game.atHome(best, bestD, WORLD.STATION_PASS_RADIUS + ROAD.TOTAL_HALF_WIDTH);

    // 首次 +3 旅币，并把这座驿站自己的一句话念出来
    const inside = bestD < WORLD.STATION_PASS_RADIUS;
    if (inside && !this.passInside.has(best)) {
      this.passInside.add(best);
      game.onStationPass(best);
      this.emit({ type: 'stationPassed', index: best });
      if (!game.isCollected(best) && st.placement.def.text) {
        // **不是 dialogue**。`dialogue` 会锁操作（`narrativeBusy`）且要按一下才走，
        // 而"骑过一座驿站，它跟你讲一句话"是**顺路读到**的东西——
        // 做成必须停下、必须按键的过场，就把一句该顺路读到的话
        // 变成了玩家必须停下来的理由，而过弯时被打断是最招骂的那种。
        //
        // 所以走 `storyLine`：黑底文字卡，不吃点击、不锁、自动推进。
        // 郑铎那几场仍然是 `dialogue`——那是"有人拦住你说话"，
        // 性质不同，值得打断。
        this.emit({
          type: 'storyLine',
          stationIndex: best,
          title: st.placement.def.name,
          text: isEnglish() ? st.placement.def.text_en : st.placement.def.text,
        });
      }
    } else if (!inside && bestD > WORLD.STATION_PASS_RADIUS + 6) {
      this.passInside.delete(best);
    }

    // 分站音乐变奏：进到碎片驿站 30m 内就染上它那一件乐事的音色，
    // 走出去再褪回原样。离得远时不做这件事——每帧改滤波器是白花的开销。
    const slot = st.placement.slot;
    if (slot >= 0 && bestD < 30) this.onBgmMood?.(slot);
    else if (this.bgmMoodSlot >= 0 && bestD > 45) {
      this.bgmMoodSlot = -1;
      this.onBgmMood?.(-1);
    }
    if (slot >= 0 && bestD < 30) this.bgmMoodSlot = slot;

    // 路边彩蛋（碑）：11m 内触发一次
    const steleInside = bestD < WORLD.STELE_PASS_RADIUS;
    if (steleInside && !this.steleInside.has(best)) {
      this.steleInside.add(best);
      const key = `stele_${(best % 4) + 1}_line`;
      const line = t(key);
      if (line && !line.startsWith('⟨')) this.onRoadsideLine?.(line);
    } else if (!steleInside && bestD > WORLD.STELE_PASS_RADIUS + 6) {
      this.steleInside.delete(best);
    }
  }

  /** 玩家在打卡范围内吗？（够得着 + 不是冷却中 + 骑开了足够远） */
  canCheckIn(): { ok: boolean; reason: '' | 'cooldown' | 'recheck' | 'busy' } {
    if (this.checkInStage !== 'none') return { ok: false, reason: 'busy' };
    // 回家是独立的一条路：0 号驿站没有碎片，`needsVisit` 恒假，
    // 所以必须在"还欠到访吗"这一关**之前**放行，否则回家永远触发不了。
    if (this.nearby.isHome) {
      if (this.interactCooldown > 0) return { ok: false, reason: 'cooldown' };
      if (!this.recheckArmed) {
        const d = Math.hypot(
          this.ride.pos.x - this.lastCheckInPos.x,
          this.ride.pos.z - this.lastCheckInPos.z,
        );
        if (d < WORLD.RECHECK_IN_MIN_DIST) return { ok: false, reason: 'recheck' };
      }
      return { ok: true, reason: '' };
    }
    if (!this.nearby.needsVisit) return { ok: false, reason: 'busy' };
    if (this.interactCooldown > 0) return { ok: false, reason: 'cooldown' };
    // 打卡完必须骑开 8m 才能再来一次，否则站在圈里连按就能连刷
    if (!this.recheckArmed) {
      const d = Math.hypot(
        this.ride.pos.x - this.lastCheckInPos.x,
        this.ride.pos.z - this.lastCheckInPos.z,
      );
      if (d < WORLD.RECHECK_IN_MIN_DIST) return { ok: false, reason: 'recheck' };
    }
    if (this.nearby.distance > WORLD.STATION_PASS_RADIUS + ROAD.TOTAL_HALF_WIDTH) {
      return { ok: false, reason: 'busy' };
    }
    return { ok: true, reason: '' };
  }

  /**
   * 开始打卡过场：1.0s 镜头移动 + 1.5s 停留 + 0.4s 收尾 ≈ 2.9s，然后进小游戏。
   * 这个节奏是原作量出来的：短于 2s 玩家来不及看清这座驿站，
   * 长于 3.5s 十五次打卡会变成十五次站着发呆。
   *
   * `home = true` 走同一条镜头路径，但停留时念的是**回家**那三句，
   * 而不是这座驿站自己的对白。0 号驿站有它自己的台词（起程驿楼），
   * 那一段在"路过"时已经念过了；回来时再念一遍等于把同一个信息说两次，
   * 而这一章真正要说的不是"这是起程驿楼"，是"你回来了"。
   */
  startCheckIn(stationIdx: number, onComplete: (idx: number) => void, home = false) {
    if (this.checkInStage !== 'none') return;
    this.checkInTarget = stationIdx;
    this.onCheckInComplete = onComplete;
    this.checkInStage = 'moving';
    this.stageT = 0;
    this.homeBeat = home;
    this.interactCooldown = WORLD.INTERACT_COOLDOWN_SEC;
    this.narrativeBusy = true;
    this.ride.setCameraLocked(true);

    // 镜头移到驿站的侧前方，能同时看到车和建筑
    const st = this.stations.list[stationIdx];
    if (st) {
      const toStation = Math.atan2(st.worldPos.x - this.ride.pos.x, st.worldPos.z - this.ride.pos.z);
      const camDist = 13;
      const camX = this.ride.pos.x - Math.sin(toStation) * camDist + 6;
      const camZ = this.ride.pos.z - Math.cos(toStation) * camDist;
      this.camMoveFrom = { x: this.ride.camera.position.x, y: this.ride.camera.position.y, z: this.ride.camera.position.z };
      this.camMoveTo = { x: camX, y: st.worldPos.y + 5.5, z: camZ };
      this.lookTarget = { x: st.worldPos.x, y: st.worldPos.y + 4, z: st.worldPos.z };
    }
  }

  private camMoveFrom = { x: 0, y: 0, z: 0 };
  private camMoveTo = { x: 0, y: 0, z: 0 };
  private lookTarget = { x: 0, y: 0, z: 0 };

  private advanceCheckIn(dt: number) {
    if (this.checkInStage === 'none') return;
    this.stageT += dt;
    if (this.checkInStage === 'moving') {
      const t01 = clamp(this.stageT / 1.0, 0, 1);
      const e = t01 * t01 * (3 - 2 * t01);
      this.ride.placeCamera(
        this.camMoveFrom.x + (this.camMoveTo.x - this.camMoveFrom.x) * e,
        this.camMoveFrom.y + (this.camMoveTo.y - this.camMoveFrom.y) * e,
        this.camMoveFrom.z + (this.camMoveTo.z - this.camMoveFrom.z) * e,
        this.lookTarget.x, this.lookTarget.y, this.lookTarget.z,
      );
      if (t01 >= 1) {
        this.checkInStage = 'holding';
        this.stageT = 0;
        if (this.homeBeat) {
          this.emit({
            type: 'dialogue',
            speaker: t('home_speaker'),
            lines: ['home_arrive_1', 'home_arrive_2', 'home_arrive_3']
              .map((k) => t(k))
              .filter((v) => v && !v.startsWith('⟨')),
          });
        } else {
          // 首访对白在这一刻播（**只在第一次**——重播会磨平三次到访的累积感）
          const st = this.stations.list[this.checkInTarget];
          const lines = isEnglish() ? st?.placement.def.dialogue_en : st?.placement.def.dialogue;
          if (lines && lines.length && game.getStationCount(this.checkInTarget) === 0) {
            this.emit({ type: 'dialogue', speaker: st!.placement.def.name, lines: [...lines] });
          }
        }
      }
    } else if (this.checkInStage === 'holding') {
      this.ride.placeCamera(this.camMoveTo.x, this.camMoveTo.y, this.camMoveTo.z, this.lookTarget.x, this.lookTarget.y, this.lookTarget.z);
      if (this.stageT >= 1.5) {
        this.checkInStage = 'outro';
        this.stageT = 0;
      }
    } else if (this.checkInStage === 'outro') {
      this.ride.placeCamera(this.camMoveTo.x, this.camMoveTo.y, this.camMoveTo.z, this.lookTarget.x, this.lookTarget.y, this.lookTarget.z);
      if (this.stageT >= 0.4) {
        const idx = this.checkInTarget;
        const cb = this.onCheckInComplete;
        this.checkInStage = 'none';
        this.stageT = 0;
        this.checkInTarget = -1;
        this.onCheckInComplete = null;
        this.ride.setCameraLocked(false);
        this.narrativeBusy = false;
        this.ride.snapCamera();
        this.lastCheckInPos.copy(this.ride.pos);
        this.recheckArmed = false;
        this.homeBeat = false;
        cb?.(idx);
      }
    }
  }

  // ---------------------------------------------------------------- 剧情
  /**
   * 郑铎三场。门槛是"路过多少座驿"（4 / 8 / 12），不是里程。
   * 原来写的是 km = 50/100/150，按 1228.8m 一圈摊到 188km 那是开局第
   * 25/50/75 秒——整条反派线会在玩家还没到过第一座碎片驿站时全部灌完，
   * 而且顶栏那个数被划掉之后玩家连"还剩几场"都看不见。
   */
  private updateVillain() {
    if (this.narrativeBusy) return;
    const seen = game.getSeenStationCount();
    const next = game.seenVillain + 1;
    if (next > ECON.VILLAIN_SCENE_COUNT) return;
    const scene = WORLD.VILLAIN_SCENES[next - 1];
    if (!scene) return;
    if (seen < scene.seen) return;
    if (!game.claimVillainScene(next)) return;

    // **引子先走，而且不锁操作。**
    //
    // `villain_cue_*` 是"手机响了。"这种一句——它的全部作用是
    // 让玩家在郑铎开口**之前**先觉得有什么不对。
    // 把它做成对白框的开场白有两个问题：
    //   · 对白框会锁操作（`narrativeBusy`），于是"手机响了"这句话
    //     本身把人按在路上；
    //   · 它会在小游戏进行中把乐事**顶掉** ——一局打了一半的茶没了。
    //
    // 所以引子走**压暗 1 秒的黑底卡**：不吃点击、不锁、不结束任何东西。
    // 而正戏（郑铎那几句）是真正的打断，仍然走对白框。
    this.emit({ type: 'villainCue', sceneIndex: next, text: t(`villain_cue_${next}`) });
    this.pendingVillain = next;
    this.deliverVillain();
  }

  /** 压暗不显示对白——宿主要告诉界面"现在在小游戏里，先别插队"。 */
  setBusyForMinigame(busy: boolean): void {
    this.inMinigame = busy;
    if (!busy) this.deliverVillain();
  }

  /**
   * 交付被压着的正戏。
   *
   * 只有**既没有对白、也不在小游戏里**才放行——
   * 前者防的是两场反派戏叠在一起，后者防的是"手机响了"把一局茶顶掉。
   */
  private deliverVillain() {
    if (!this.pendingVillain || this.narrativeBusy || this.inMinigame) return;
    const next = this.pendingVillain;
    this.pendingVillain = 0;
    const scene = WORLD.VILLAIN_SCENES[next - 1];
    if (!scene) return;
    const lines: string[] = [];
    for (const part of scene.parts) {
      for (const key of part.lines) {
        const v = t(key);
        if (v && !v.startsWith('⟨')) lines.push(v);
      }
    }
    this.emit({ type: 'villain', sceneIndex: next });
    this.emit({ type: 'dialogue', speaker: t('villain_speaker'), lines });
  }

  private pendingVillain = 0;
  private inMinigame = false;

  /** 强制推进一次剧情检查（对话结束后调，否则对话期间 seen 涨了不会触发） */
  retryVillain() {
    this.narrativeBusy = false;
    this.updateVillain();
  }

  // ---------------------------------------------------------------- 换档
  applyPreset(preset: QualityPreset, tier: Tier) {
    this.preset = preset;
    
    this.renderer.setTier(tier);
    this.renderer.applyPreset(preset);
    this.sky.setShadowsEnabled(preset.shadowMapSize > 0);
    this.veg.setPreset(preset);
    this.terrain.setPreset(preset);
    this.veg.invalidate();
    this.scenery.invalidate();
    this.stations.setPreset(preset);
    this.water.setDetail(preset.waterDetail);
  }

  /** 把玩家放到某座驿站旁（调试/演示用） */
  teleportToStation(index: number) {
    const st = STATIONS[index];
    if (!st) return;
    const near = nearestOnCenterline(st.mapX, st.mapZ);
    this.ride.spawn(near.x, near.z, 0);
    this.lastPos.copy(this.ride.pos);
    this.ride.snapCamera();
  }

  /**
   * 把玩家放到中心线的某个参数位置（0..1），并指定朝向（度）。
   *
   * 存在的理由是"同一个画面看两次"这件事做不到：
   * 演示模式在跑、每帧 15m，而截图与读数之间隔着半秒，
   * 于是"画面左边那个方块"和自检里那一行对象**永远对不上号**。
   * 8 字交叉口、某一类地标、某段路面——都需要能一次又一次地摆到同一个
   * 位置看同一个角度，否则这类问题只能靠"多转几圈碰碰运气"。
   */
  teleportToArc(t01: number, yawDeg?: number) {
    const t = clamp(t01, 0, 1);
    const p = pointAtArcLength(t * TOTAL_ARCLENGTH).pos;
    // 朝向取中心线在该点的切线方向；给了 yaw 就用给的
    let heading = 0;
    if (yawDeg === undefined) {
      const a = pointAtArcLength(Math.max(0, t * TOTAL_ARCLENGTH - 2)).pos;
      const b = pointAtArcLength(Math.min(TOTAL_ARCLENGTH, t * TOTAL_ARCLENGTH + 2)).pos;
      heading = Math.atan2(b.x - a.x, b.z - a.z);
    } else {
      heading = (yawDeg * Math.PI) / 180;
    }
    this.ride.spawn(p.x, p.z, heading);
    this.lastPos.copy(this.ride.pos);
    this.lastArc = t;
    this.ride.snapCamera();
  }

  setOdometer(v: number) {
    this.odometer = v;
  }

  // ---------------------------------------------------------------- 异步资产
  async loadBikeModel(): Promise<boolean> {
    const model = await loadModel(modelUrl('res://assets/bike.glb'));
    if (!model) return false;
    const holder: Object3D = model.root;
    holder.scale.setScalar(WORLD.BIKE_SCALE);
    // 自行车只是**载具的一种**，模型交给 Vehicle 管，
    // 这样加第二种载具时不必再动 Ride 的模型分支。
    this.ride.vehicle.attach({ bike: holder });
    this.emit({ type: 'loaded', what: 'bike' });
    return true;
  }

  /**
   * 滑板 + 角色。**可选**：拉不到就只是不能换滑板，
   * 游戏本身照常能骑车——所以逐个 `catch`，不连坐。
   */
  async loadVehicleExtras(): Promise<void> {
    const [skate, survivor] = await Promise.all([
      loadModel(modelUrl('res://assets/models/skateboard.glb')).catch(() => null),
      loadModel(modelUrl('res://assets/models/survivor.glb')).catch(() => null),
    ]);
    if (!skate) {
      this.assetFail('滑板', 'skateboard.glb');
      return;
    }
    if (!survivor) {
      this.assetFail('角色', 'survivor.glb');
    }
    this.ride.vehicle.attach({
      skate: skate.root,
      char: survivor?.root ?? null,
      clips: survivor ? collectClips(survivor.animations) : {},
    });
    this.emit({ type: 'loaded', what: 'vehicle' });
  }

  /**
   * 资产加载失败的原因。**空数组 = 什么都没失败。**
   *
   * 为什么要有它：`loadModel()` 失败时是 `resolve(null)`，**不抛异常**，
   * 于是 `if (tree && bush)` 会一声不吭地跳过 —— 世界照常建起来、
   * 游戏照常能玩，只是路边没有树。
   *
   * 这个 bug 已经咬过一次：`pine_split.glb` 拉不到时，
   * 树和灌木**一起**消失（`Promise.all` 里任一失败，另一个的结果也白拿），
   * 而界面上没有任何线索。探针会打印这份记录。
   */
  readonly assetErrors: string[] = [];

  private assetFail(what: string, url: string): void {
    const msg = `${what} 拉不到：${url}`;
    this.assetErrors.push(msg);
    console.warn('[gift188]', msg);
  }

  async loadVegetationModels(): Promise<void> {
    // `pine_split.glb` 不是源项目那株树：那株是 **32,929 面/棵**且简化压不动；
    // 而松树是 6 棵一共 31,219 面（5,203 面/棵），便宜 6.3 倍。
    //
    // **`_split` 是关键**：源文件是 6 棵排成一行的一棵网格，
    // 整丛共用一个 Y 会导致「有的悬空有的半埋」。
    // `tools/split-glb.mjs` 把它拆成 6 个独立 mesh（各自压实过顶点），
    // 运行时逐株取地形高度。详见 src/world/vegetation.ts。
    //
    // 注意 `tree.glb` 仍然要留着——它是「榕树下」这个地标本身（配置表第 5 项）。
    const [tree, bush] = await Promise.all([
      loadModel(modelUrl('res://assets/models/pine_split.glb')),
      loadModel(modelUrl('res://assets/models/bush.glb')),
    ]);
    // **逐个判空**：原先写成 `if (tree && bush)`，一个失败就把另一个也一起丢掉，
    // 于是"松树拉不到"表现成"树和灌木都没了"，排查时完全指错了方向。
    if (tree) {
      const geos = allGeometries(tree);
      if (geos.length < 6) this.assetFail(`松树只取到 ${geos.length}/6 个网格`, 'pine_split.glb');
      this.veg.attachTrees(geos, firstMaterial(tree));
    } else {
      this.assetFail('松树', 'pine_split.glb');
    }
    if (bush) {
      this.veg.attachBushes(firstGeometry(bush), firstMaterial(bush));
    } else {
      this.assetFail('灌木', 'bush.glb');
    }
    this.emit({ type: 'loaded', what: 'vegetation' });
  }

  /**
   * 区域散布的模型（竹 / 现代塔楼 / 现代圆屋）。
   *
   * **独立于植被那一条链**：这三样不在路边，是按区域摆的；
   * 而且它们是**可选**的——拉不到只是"西北没有竹、东南没有开发区"，
   * 不该让整局像植被那样连锁失败。逐个 `catch`，缺哪个记哪个。
   */
  async loadSceneryModels(): Promise<void> {
    const want: [SceneryKind, string][] = [
      ['bamboo', 'res://assets/models/bamboo_trim.glb'],
      ['mod_tower', 'res://assets/models/mod_tower.glb'],
      ['mod_house', 'res://assets/models/mod_house.glb'],
    ];
    const got: Partial<Record<SceneryKind, { geo: BufferGeometry; mat: Material | null }>> = {};
    await Promise.all(
      want.map(async ([kind, path]) => {
        try {
          const m = await loadModel(modelUrl(path));
          if (m) got[kind] = { geo: firstGeometry(m), mat: firstMaterial(m) };
          else console.warn(`[gift188] ${kind} 模型拉不到，${kind} 这一片不会出现`);
        } catch (e) {
          console.warn(`[gift188] ${kind} 模型出错：`, e);
        }
      }),
    );
    if (Object.keys(got).length) {
      this.scenery.attachMeshes(got);
      this.emit({ type: 'loaded', what: 'scenery' });
    }
  }

  dispose() {
    this.water.dispose();
    this.veg.dispose();
    this.renderer.dispose();
  }
}

function firstGeometry(m: { root: Object3D }): BufferGeometry {
  let geo: import('three').BufferGeometry | null = null;
  m.root.traverse((o) => {
    if (!geo && (o as { isMesh?: boolean }).isMesh) {
      geo = (o as unknown as Mesh).geometry;
    }
  });
  return geo as unknown as import('three').BufferGeometry;
}

function firstMaterial(m: { root: Object3D }): Material | null {
  let mat: import('three').Material | null = null;
  m.root.traverse((o) => {
    if (!mat && (o as { isMesh?: boolean }).isMesh) {
      const mm = (o as unknown as Mesh).material;
      mat = Array.isArray(mm) ? mm[0] : mm;
    }
  });
  return mat;
}

/**
 * 取出**全部** mesh 的几何体（拆簇后的松树有 6 个）。
 *
 * `firstGeometry()` 只拿第一个——那对"一棵树一个模型"的资产是对的，
 * 对 `pine_split.glb` 就只拿到一棵，于是路边全是同一棵树复制出来的。
 * 顺序按节点名里的 `tree_k` 排，**保证第 k 棵树对应变体 k**，
 * 不依赖遍历顺序（顺序一变，画面上的树型分布就会跟着变）。
 */
function allGeometries(m: { root: Object3D }): BufferGeometry[] {
  const found: { name: string; geo: BufferGeometry }[] = [];
  m.root.traverse((o) => {
    if (!(o as { isMesh?: boolean }).isMesh) return;
    found.push({ name: (o as Object3D).name || '', geo: (o as unknown as Mesh).geometry });
  });
  found.sort((a, b) => {
    const ka = Number(/tree_(\d+)/.exec(a.name)?.[1] ?? Number.MAX_SAFE_INTEGER);
    const kb = Number(/tree_(\d+)/.exec(b.name)?.[1] ?? Number.MAX_SAFE_INTEGER);
    return ka - kb;
  });
  return found.map((f) => f.geo);
}

/** 找到离 (x,z) 最近的一点中心线（用于把车放在路上） */
function nearestOnCenterline(x: number, z: number) {
  const t01 = nearestArcParam(x, z);
  return pointAtArcLength(t01 * TOTAL_ARCLENGTH).pos;
}

/** 启动自检：碗与路的关系 */
export function verifyWorld() {
  const basins = checkConsistency();
  return {
    basins,
    centerlinePoints: CENTERLINE.length,
    totalArclength: TOTAL_ARCLENGTH,
    stations: STATIONS.length,
    minigameSchedule: MINIGAMES.schedule,
  };
}

export { PRESETS };
