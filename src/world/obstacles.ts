/**
 * 路面上的石头 —— 躲避挑战的那一堆障碍物。
 *
 * ## 为什么它们平时**不在**场景里
 *
 * 这一圈路是玩家全部的自由活动空间。石头常驻在路面上意味着
 * 「随时可能撞上」，而这个游戏**没有死亡画面**——
 * 于是一个随时可能撞上的东西在这个游戏里就是一个随时可能结束的念头。
 *
 * 所以：石头**只在挑战进行时**被摆上路面，挑战结束（撞到 / 绕完 / 走开）
 * 立刻撤走。木牌是常驻的，石头是木牌说的那句话的**兑现**。
 *
 * ## 为什么是零贴图的程序化几何
 *
 * 和五件旧物同一套理由（`relics.ts` 的文件头）：它们离镜头最近时也只有
 * 几十个像素，面数花在看不见的地方没有意义，而这是低配优先的项目。
 * 二十二块石头一共不到 400 个三角面。
 */
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  DodecahedronGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  TorusGeometry,
} from 'three';
import { signSite, type Obstacle as ObstacleSpec } from '../game/challenge';
import type { Terrain } from './terrain';

export class Obstacles {
  /**
   * 路边这一族的容器：木牌（常驻）+ 石头（只在挑战进行时）。
   *
   * **木牌挂在 `group` 上而不是 `stones` 上**，这不是随手放的——
   * `clear()` 只把 `stones.visible` 按成假，木牌因此不受影响。
   * 两者当初挂同一个 Group 时，`clear()` 顺手 `group.visible = false`，
   * 于是**挑战一结束木牌就跟着消失了**，而玩家刚刚还在那儿按过 F。
   * 那个症状是"路肩上什么都没有了"，没有任何东西会报。
   */
  readonly group = new Group();
  /** 只装石头。`clear()` 只动它。 */
  private readonly stones = new Group();
  /** 当前摆出来的那些。空数组 = 没在挑战。 */
  private meshes: Object3D[] = [];

  constructor() {
    this.group.name = 'roadside';
    this.group.add(this.stones);
    this.stones.visible = false;
  }

  /** 把一堆石头摆上路面。**同一时刻只有一堆**——上一次的一定先撤了。 */
  place(specs: readonly ObstacleSpec[], terrain: Terrain): void {
    this.clear();
    for (const s of specs) {
      const m = buildObstacle(s.index);
      // 石头坐在路面上。障碍物全部压在路面之内，
      // 所以 `terrain.getHeightAt` 就是对的落点。
      const y = terrain.getHeightAt(s.x, s.z);
      m.position.set(s.x, y, s.z);
      // 朝向不是纯随机：石头该有"被人随手扔在路肩旁"的样子，
      // 转成完全随机反而读成一片被人精心摆过的阵列。
      m.rotation.y = ((s.index * 2654435761) % 628) / 100;
      m.rotation.z = (((s.index * 40503) % 40) - 20) / 100;
      this.stones.add(m);
      this.meshes.push(m);
    }
    this.stones.visible = this.meshes.length > 0;
  }

  clear(): void {
    for (const m of this.meshes) {
      m.traverse((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        const g = mesh.geometry as BufferGeometry;
        g.dispose();
      });
      this.stones.remove(m);
    }
    this.meshes = [];
    this.stones.visible = false;
  }

  /**
   * 三角面预算。给回归量，也给"这一堆石头到底有多贵"一个答案。
   *
   * 和 `Relics.triangleCount()` 同一个理由：低配优先的项目里，
   * 「一件新东西花了多少面」必须是**能问的**，而不是靠感觉。
   * `verify_dodge_layout` 拿它守一条上限。
   */
  triangleCount(): number {
    let n = 0;
    this.group.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      const g = m.geometry as BufferGeometry;
      const idx = g.getIndex();
      n += idx ? idx.count / 3 : g.getAttribute('position').count / 3;
    });
    return n;
  }
}

/** 木牌：一块钉在路肩上的半截木板 + 几道炭写的字痕。 */
export function buildSign(): Group {
  const g = new Group();
  const postMat = new MeshStandardMaterial({ color: new Color(0.30, 0.22, 0.15), roughness: 0.95 });
  const boardMat = new MeshStandardMaterial({ color: new Color(0.46, 0.35, 0.22), roughness: 0.92 });
  const charMat = new MeshStandardMaterial({ color: new Color(0.08, 0.07, 0.06), roughness: 1 });

  const post = new Mesh(new BoxGeometry(0.1, 1.5, 0.1), postMat);
  post.position.y = 0.75;
  g.add(post);

  const board = new Mesh(new BoxGeometry(1.1, 0.62, 0.06), boardMat);
  board.position.y = 1.52;
  g.add(board);

  // 四道横的炭痕：读出来是"有人在上面写过字"，而不是一块空板子。
  for (let i = 0; i < 4; i++) {
    const w = 0.62 + ((i * 37) % 30) / 100;
    const ch = new Mesh(new BoxGeometry(w, 0.045, 0.02), charMat);
    ch.position.set(-0.14 + w * 0.5, 1.72 - i * 0.13, 0.04);
    g.add(ch);
  }
  // 一枚钉在板上的旧钉子
  const nail = new Mesh(new BoxGeometry(0.05, 0.05, 0.03), charMat);
  nail.position.set(-0.44, 1.78, 0.04);
  g.add(nail);
  return g;
}

/**
 * 一块石头。五种样子轮着来，按 index 取——
 * 所以一圈二十二块石头**不重样**，而整圈路看上去是"有人一把一把撒下去的"。
 */
function buildObstacle(index: number): Group {
  const g = new Group();
  const grey = 0.30 + ((index * 61) % 17) / 100;
  const mat = new MeshStandardMaterial({
    color: new Color(grey, grey * 0.97, grey * 0.9),
    roughness: 0.92,
    metalness: 0.04,
    flatShading: true,
  });
  const kind = index % 5;
  if (kind === 0) {
    const m = new Mesh(new DodecahedronGeometry(0.55, 0), mat);
    m.scale.set(1, 0.82, 1.08);
    m.position.y = 0.42;
    g.add(m);
  } else if (kind === 1) {
    // 两块叠着的
    const a = new Mesh(new DodecahedronGeometry(0.4, 0), mat);
    a.position.set(-0.18, 0.3, 0.1);
    g.add(a);
    const b = new Mesh(new DodecahedronGeometry(0.33, 0), mat);
    b.position.set(0.24, 0.26, -0.14);
    g.add(b);
  } else if (kind === 2) {
    // 一段倒下来的枯枝
    const m = new Mesh(new BoxGeometry(1.5, 0.2, 0.22), mat);
    m.position.y = 0.22;
    m.rotation.z = 0.1;
    g.add(m);
    const twig = new Mesh(new BoxGeometry(0.7, 0.14, 0.14), mat);
    twig.position.set(0.45, 0.5, 0.05);
    twig.rotation.z = 0.6;
    g.add(twig);
  } else if (kind === 3) {
    // 翻倒的筐。**环的分段数是这一族最贵的一件**：
    // 5×12 的 Torus 是 120 个三角面，而它在屏幕上只有二十几个像素——
    // 一圈 22 块石头里有 4~5 个是它，这一项就占了将近五百面。
    // 降到 4×9（72 面）之后，筐仍然读得出是"一个翻过来的圈"。
    const m = new Mesh(new TorusGeometry(0.42, 0.16, 4, 9), mat);
    m.position.y = 0.2;
    m.rotation.x = Math.PI / 2;
    m.rotation.z = 0.3;
    g.add(m);
  } else {
    // 一块板子
    const m = new Mesh(new BoxGeometry(1.1, 0.14, 0.5), mat);
    m.position.y = 0.18;
    m.rotation.y = 0.24;
    g.add(m);
  }
  g.name = `obstacle-${index}`;
  return g;
}

/**
 * 木牌的世界坐标（弧长参数 + 侧 → x/z）。
 *
 * **薄薄一层包装**：真正的落位算法在 `game/challenge.ts` 的 `signSite()`，
 * 那是纯函数、无头回归直接问它。3D 这一侧要的是一个 `Object3D` 的落点，
 * 而把它在这里转一次，比让世界层再抄一遍法向计算要好——
 * 抄的那份迟早和它漂，而漂了的症状是"木牌漂到路中间去了"，
 * 那在图上一眼能看见，在判据里却哪儿都量不到。
 */
export function signWorldPos(arcT: number, side: 1 | -1): { x: number; z: number } {
  return signSite(arcT, side);
}