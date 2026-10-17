/**
 * 滑板尾迹的回归 —— 这条特效"该不该动"的全部判据。
 *
 * ## 为什么能在无头环境里量
 *
 * 尾迹的特效部分（ShaderMaterial / Points）要 GPU，但**逻辑部分全是
 * CPU 上的数：发射率、寿命、池子边界、出生点位置**。而会出bug的
 * 恰恰是逻辑部分——着色器写错了是"不好看"，逻辑写错了是
 * "骑自行车也冒火星"或者"停下来火还烧着"，那种事看画面才能发现
 * 就已经晚了。所以这里用假骑手（`TrailSubject` 是个结构类型，
 * 三个 getter 就满足）把逻辑整条跑在 Node 里。
 *
 * 接线（world.ts 有没有真的调用它）单独用源码判据钉，见本族最后一条。
 */
import { PerspectiveCamera, Vector3 } from 'three';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, stripComments, type CheckFn } from './harness';
import {
  SkateTrail,
  TRAIL_EMIT_MIN_SPEED,
  TRAIL_LIFE_MAX,
  TRAIL_MAX_PARTICLES,
  type TrailSubject,
} from '../world/skateTrail';
import { camParams } from '../world/ride';
import { verticalFovForAspect } from '../core/fov';
import { RIDE } from '../data/raw';
import { PRESETS } from '../core/settings';

// 回归由 `npm run verify` 跑，cwd 就是仓库根。理由同 `verify/ai.ts`：
// esbuild 打包后 `import.meta.url` 指向临时目录，不能用来反推路径。
const ROOT = process.cwd();

/**
 * 假骑手。朝向取 `heading = 0`：`Ride._fwd` 在 heading 0 时是 (0,0,−1)，
 * 于是"板后"就是 +z，"右侧"就是 +x——两个方向各一句断言就够，不用转矩阵。
 */
function fakeSubject(x = 0, y = 0, z = 0, speed = 0): TrailSubject {
  return { pos: new Vector3(x, y, z), forward: new Vector3(0, 0, -1), speedValue: speed };
}

/** 按固定步长跑 n 秒。 */
function run(t: SkateTrail, seconds: number, dt: number, kind: 'skate' | 'bike' | 'foot', speed: number) {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) t.update(dt, kind, fakeSubject(0, 0, 0, speed));
}

export function registerSkateTrailChecks(check: CheckFn): void {
  check('verify_skate_trail', () => {
    let asserts = 0;
    const probs: string[] = [];
    const mid = PRESETS[1];

    // ---------------------------------------------------------- 档位开关
    // "只有滑板冒火星"是这条特效的第一语义。载具枚举以后再加人，
    // 这条判据的形状不变：除 skate 外一律不许发射。
    {
      const t = new SkateTrail();
      t.setPreset(mid);
      run(t, 1, 0.25, 'bike', 17);
      asserts++;
      if (t.emitted !== 0) probs.push(`骑自行车也在冒火星（${t.emitted} 发）`);
      run(t, 1, 0.25, 'skate', 17);
      asserts++;
      if (t.emitted <= 0) probs.push('滑板满速跑一秒不发粒子');
      t.dispose();
    }

    // ---------------------------------------------------------- 速度阈值
    // 阈值上下各 5cm/s：这一对是"起步那一下不该冒火"的判据。
    // 只测一侧的话，把阈值悄悄改成 0 或改成 10 都不会红。
    {
      const t = new SkateTrail();
      t.setPreset(mid);
      run(t, 1, 0.25, 'skate', TRAIL_EMIT_MIN_SPEED - 0.05);
      asserts++;
      if (t.emitted !== 0) probs.push(`阈值以下也在发射（${TRAIL_EMIT_MIN_SPEED}m/s 减去 5cm）`);
      run(t, 1, 0.25, 'skate', TRAIL_EMIT_MIN_SPEED + 0.05);
      asserts++;
      if (t.emitted <= 0) probs.push('阈值以上反而不发射');
      t.dispose();
    }

    // ---------------------------------------------------------- 发射率
    // 中档满速 2 秒应发出 rate×2 发。步长取 0.25s 是为了让累加器
    // 每帧正好凑满整数发（0.25 × 96 = 24），于是这里可以要**精确值**——
    // 精确才对得上"预算表里的那个数真的在起作用"。
    {
      const t = new SkateTrail();
      t.setPreset(mid);
      run(t, 2, 0.25, 'skate', 17);
      asserts++;
      const want = mid.trailEmitRate * 2;
      if (t.emitted !== want) probs.push(`满速 2 秒发出 ${t.emitted} 发，应为 ${want}`);
      t.dispose();
    }

    // ---------------------------------------------------------- 池子边界
    // 用一个**故意超出任何一档四倍以上**的发射率把池子压满：
    // 真实三档的预算都宽裕到永远碰不到上限（rate × 寿命上限只有预算的
    // 三分之一），不压满就量不到"池满即丢"那条分支。压满之后活粒子
    // 必须恰好停在预算上——多一个都是数组越界的前兆。
    {
      const stress = { ...PRESETS[2], trailEmitRate: 2000 };
      const t = new SkateTrail();
      t.setPreset(stress);
      run(t, 3, 0.1, 'skate', 17);
      asserts++;
      if (t.aliveCount !== t.capacity) {
        probs.push(`压满时活粒子 ${t.aliveCount}，应恰好等于预算 ${t.capacity}`);
      }
      asserts++;
      if (t.capacity !== TRAIL_MAX_PARTICLES) probs.push(`高档预算 ${t.capacity} 不等于数组硬上限`);
      t.dispose();
    }

    // ---------------------------------------------------------- 死干净
    // 停下来（速度归零）最长一条命之后必须一个不剩。
    // 这条钉的是"停车不灭火"——画面上的症状是原地定住还有一撮火星，
    // 而那种事在截图里永远解释得通（"可能刚好在烧吧"）。
    {
      const t = new SkateTrail();
      t.setPreset(mid);
      run(t, 3, 0.1, 'skate', 17);
      run(t, 0.5, 0.1, 'skate', 0);
      asserts++;
      if (t.aliveCount === 0) probs.push('刚停车就全灭了，尾迹是瞬移不是烧完');
      run(t, TRAIL_LIFE_MAX + 0.2, 0.1, 'skate', 0);
      asserts++;
      if (t.aliveCount !== 0) probs.push(`停车 ${TRAIL_LIFE_MAX + 0.2}s 后还剩 ${t.aliveCount} 个火星`);
      // 换载具同理：剩下的也该烧完，而不是跟着自行车跑
      const t2 = new SkateTrail();
      t2.setPreset(mid);
      run(t2, 3, 0.1, 'skate', 17);
      run(t2, TRAIL_LIFE_MAX + 0.2, 0.1, 'foot', 0);
      asserts++;
      if (t2.aliveCount !== 0) probs.push('换成徒步后火星没烧完');
      t.dispose();
      t2.dispose();
    }

    // ---------------------------------------------------------- 出生点
    // 一帧之内出生的粒子必须全部落在"板后、贴地、横向不散出板宽"。
    // 位置写错的症状（火从头前方冒、悬空一米、横着飞出十米）在这里
    // 各对应一个数，不用看画面。
    {
      const t = new SkateTrail();
      t.setPreset(PRESETS[2]);
      t.update(1 / 60, 'skate', fakeSubject(10, 0, 5, 8));
      asserts++;
      if (t.aliveCount <= 0) {
        probs.push('满速第一帧没发出任何粒子');
      } else {
        let bad = '';
        for (let i = 0; i < t.aliveCount; i++) {
          const p = t.particlePos(i)!;
          const dx = p.x - 10;
          const dz = p.z - 5;
          // forward = (0,0,−1)：板后 = +z，投影到 forward 上应是负的
          if (-dz > 0.05) bad = `有粒子在骑手前面 ${(-dz).toFixed(2)}m`;
          if (p.y - 0 > 0.4 || p.y < -0.05) bad = `出生高度 ${p.y.toFixed(2)}m 不在贴地区间`;
          if (Math.abs(dx) > 0.45) bad = `横向撒出 ${Math.abs(dx).toFixed(2)}m`;
        }
        if (bad) probs.push(bad);
      }
      t.dispose();
    }

    // ---------------------------------------------------------- 关档与降档
    // 预算 0 = 整个特效消失（visible=false，一个点都不传 GPU）；
    // 降档时多出来的活粒子当场消失，不留一条"按高档寿命烧完"的尾巴。
    // 用上面那个压满的池子来做降档：满池 480 → 低档 90，截断量是确定的。
    {
      const stress = { ...PRESETS[2], trailEmitRate: 2000 };
      const t = new SkateTrail();
      t.setPreset(stress);
      run(t, 3, 0.1, 'skate', 17);
      asserts++;
      if (t.aliveCount !== TRAIL_MAX_PARTICLES) probs.push('这条判据的前提不成立：池子没被压满');
      t.setPreset(PRESETS[0]);
      asserts++;
      if (t.aliveCount > PRESETS[0].trailParticles) {
        probs.push(`降到低档后还剩 ${t.aliveCount} 个，预算只有 ${PRESETS[0].trailParticles}`);
      }
      asserts++;
      if (t.capacity !== PRESETS[0].trailParticles) probs.push('降档后预算没换成低档的值');
      const off = { ...PRESETS[0], trailParticles: 0, trailEmitRate: 0 };
      t.setPreset(off);
      asserts++;
      if (t.points.visible) probs.push('预算为 0 时尾迹还可见');
      const emitted = t.emitted;
      run(t, 1, 0.25, 'skate', 17);
      asserts++;
      if (t.emitted !== emitted) probs.push('预算为 0 时还在发射');
      t.dispose();
    }

    // ---------------------------------------------------------- 视口基准
    // 点尺寸按像素算，缓冲区高度必须真的传进去。不传的后果是
    // 窗口放大后尾迹相对变小——而那个症状太微妙，没人会归因到这里。
    {
      const t = new SkateTrail();
      t.setPreset(mid);
      t.setViewport(1000);
      asserts++;
      if (Math.abs(t.pointScale - 500) > 1e-6) probs.push(`点尺寸基准 ${t.pointScale}，应为缓冲区高度的一半`);
      t.dispose();
    }

    // ---------------------------------------------------------- 接线
    // 上面量的都是"类本身对"。类对了而没接上，症状同样是零——
    // 所以 world.ts 里那三处调用（每帧更新、换档转发、销毁）各钉一条。
    // 剥注释是必须的：把调用行注释掉，字符串还留在文件里。
    {
      const src = stripComments(readFileSync(join(ROOT, 'src/world/world.ts'), 'utf8'));
      asserts++;
      if (!src.includes('this.skateTrail.update(dt, this.ride.vehicleKind, this.ride)')) {
        probs.push('world.ts 没有每帧驱动尾迹');
      }
      asserts++;
      if (!src.includes('this.skateTrail.setPreset(preset)')) probs.push('world.ts 换画质档时没转发给尾迹');
      asserts++;
      if (!/dispose\(\)\s*\{[^}]*this\.skateTrail\.dispose\(\)/.test(src)) {
        probs.push('world.ts 销毁时没释放尾迹');
      }
      asserts++;
      if (!src.includes('this.scene.add(this.skateTrail.points)')) probs.push('尾迹没有挂进场景');
    }

    // ---------------------------------------------------------- 默认机位看得见
    // 这条守的是一个**几何**事实，不是审美：默认机位 `forward` 是
    // 退 3.2m、抬 2.05m、看向骑手前方 2.2m 的俯视机位，板后的火星只有
    // 落进那个锥里才画得出来。相机参数（`camParams` / `RIDE.CAM_*`）或
    // 出生几何（TAIL_BACK、后抛速度）任何一边动一下，这条就可能红——
    // 而它的症状是"特效好好地活着，只是没人看得见"，那种 bug
    // 连截图都解释得通（"可能刚好那一下没冒火吧"）。
    {
      const m = camParams('forward');
      const { CAM_LOOK_AHEAD, CAM_LOOK_UP } = RIDE;
      // 横竖两种画幅都量：竖屏的水平视野只有 ~52°，而尾迹在画面正中，
      // 真正吃紧的是竖直方向（竖屏的竖直 FOV 反而更宽，见 fov.ts）。
      for (const aspect of [16 / 9, 9 / 16]) {
        const cam = new PerspectiveCamera(verticalFovForAspect(aspect), aspect, 0.25, 900);
        // 骑手在原点、heading 0：forward = (0,0,−1)、right = (1,0,0)，
        // 于是相机落点 = (side, up, back)，看向 (0, LOOK_UP, −LOOK_AHEAD)。
        // 与 `Ride.render()` 里那四行同一套算式，照抄不改。
        cam.position.set(m.side, m.up, m.back);
        cam.lookAt(0, CAM_LOOK_UP, -CAM_LOOK_AHEAD);
        cam.updateMatrixWorld(true);

        const t = new SkateTrail();
        t.setPreset(mid);
        let inFrame = 0;
        let total = 0;
        // 骑手**不动**：可见性只取决于粒子相对骑手的位置，挪动骑手
        // 只是把同一个相对关系重复六十遍，还得多算一个跟随机位。
        for (let f = 0; f < 60; f++) {
          t.update(1 / 60, 'skate', fakeSubject(0, 0, 0, 17));
          for (let i = 0; i < t.aliveCount; i++) {
            const ndc = t.particlePos(i)!.project(cam);
            total++;
            if (Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1 && ndc.z > -1 && ndc.z < 1) inFrame++;
          }
        }
        asserts++;
        if (total === 0) {
          probs.push('一秒满速一个粒子都没发出来');
        } else if (inFrame / total < 0.3) {
          probs.push(`画幅 ${aspect.toFixed(2)} 下只有 ${inFrame}/${total} 个粒子在默认机位画面内`);
        }
        t.dispose();
      }
    }

    return expect(probs.length === 0, probs.length ? probs.join('；') : `三档预算 ${PRESETS[0].trailParticles}/${PRESETS[1].trailParticles}/${PRESETS[2].trailParticles}`, asserts);
  });
}
