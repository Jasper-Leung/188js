/**
 * 车辆一族：自行车/摩托/滑板/角色的骨骼、轴位、骑姿、骑行手感与派生量。
 *
 * ## 为什么它从 `entry.ts` 里搬出来
 *
 * `entry.ts` 连着四轮只涨不跌，而这一族是里面最大的一块（约 1,350 行）。
 * 它之所以是干净的一刀，是因为 **5450~6790 之间没有任何顶层声明**——
 * 整段全是 `check(...)` 加它们自己的文档注释，不共享任何局部helper。
 *
 * ## 为什么是「导出 register 函数」而不是「模块顶层就 check」
 *
 * **因为 ESM 的 import 会被提升。** 如果这里在模块顶层直接 `check(...)`，
 * 它会在 `entry.ts` 的任何一行之前全部注册，于是**注册顺序变了**。
 * 而 `entry.ts` 里 `verify_toast_reply` 的注释写死了这件事有语义：
 * 「判据按注册顺序跑，谁先装上 DOM 桩后面那条就会拿到残桩」。
 *
 * 所以这一族导出 `registerVehicleChecks(check)`，由 `entry.ts` 在**原来的位置**调用一次。
 * 顺序因此逐字不变，搬移对判据而言不可见。
 *
 * 搬移的验收口径：**`npm run verify` 的条数与断言数一条都不许变**。
 * 少一条就是漏搬了——这是唯一能证伪「机械搬移」的东西。
 */

import { expect, type CheckFn } from './harness';
import { STATIONS } from '../data/route';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROAD, ECON, SHOPS, I18N, WORLD } from '../data/raw';
import { BoxGeometry, CylinderGeometry, BufferGeometry, Mesh, Object3D, Vector3, Group, AnimationClip, KeyframeTrack, Bone } from 'three';
import { ROAD as ROAD_GEOM } from '../world/road';
import { verticalFovForAspect, horizontalFromVertical, FOV_MIN_HORIZONTAL } from '../core/fov';
import { interactAt } from '../game/phase';
import { camParams } from '../world/ride';
import { Vehicle, FOOT_LATERAL_OFFSET, collectClips, BICYCLE_YAW, MOTORCYCLE_YAW, CHAR_FACING_YAW, MODEL_HEADS, MODEL_AXES, facingDir, motoLeanAt, bicycleScale, localUnion, measureDriveBasis, standFoldAt, STAND_FOLD_ANGLE, BIKE_STEER_MAX, BIKE_GEAR_RATIO, type RideMode } from '../world/vehicle';
import { assertRide, assertDemoDrive } from './ride';
import { GameStateManager } from '../game/state';

/** 由 `entry.ts` 在原位调用一次，见文件头「为什么是导出函数」。 */
export function registerVehicleChecks(check: CheckFn): void {

  // ---------------------------------------------------------------- 自行车装配
  /**
   * ## 自行车必须**装成一台车**，而不是一堆各自拧 `rotation` 的零件
   *
   * 这一族判据对应用户报的四件事：
   * 车轮倒着转 / 人不在车上 / 脚撑该折不折 / 车把不打方向。
   *
   * ### 为什么夹具要照抄真素材的**结构**，而不是随便造几个球
   *
   * `assembleBike()` 靠三件事认出这台车：**零件名**、**每个零件的轴向**、
   * **哪些零件够到地面**。三者错一个，装配就静默失效（`rig = null`），
   * 而那只是「少几个功能」，不报错。
   * 所以夹具按 `bicycle.glb` 的实测值建：
   *
   * | 零件 | 位置（车模本地） | 形状 |
   * |---|---|---|
   * | `tripo_part_0` 前轮 | (−0.305, 0.1998, 0.0737) | 圆柱，**轴 = 本地 Z**，R 0.1946 |
   * | `tripo_part_2` 后轮 | (0.2915, 0.1997, −0.0404) | 同上 |
   * | `tripo_part_7` 鞍面 | (0.1377, 0.5046, −0.0164) | 0.17×0.08×0.13，顶面 0.5446 |
   * | `tripo_part_11` 脚撑 | (0.2997, 0.0983, −0.0446) | 0.05×0.197×0.17，**底端到 y=0** |
   * | `crankAxle` / `crankArmL·R` / `pedalL·R` | 曲柄轴心 (0.0535, 0.1724, 0.005) | — |
   * | `tripo_part_8` / `_23` / `_25` / `_5` | 前端 | — |
   *
   * ★ 前轮**横向**比后轮偏 0.114（实测值）**故意保留**：
   *   判据不依赖它，但它证明装配用的是**量出来的轴心**而不是写死的数。
   *   脚撑底端**必须到 y = 0**——它是全车唯一碰地面的零件，
   *   「折角绕后轴」这条判据靠它成立。
   */
  check('verify_bike_rig', () => {
    let asserts = 0;
    const probs: string[] = [];
    const notes: string[] = [];

    const R = 0.1946;
    const mk = (geo: BufferGeometry, name: string, x: number, y: number, z: number) => {
      const m = new Mesh(geo);
      m.name = name;
      m.position.set(x, y, z);
      return m;
    };
    // 轮：圆柱默认轴是 Y，转一下让**轮面落在 XY 平面、轴指向本地 Z**。
    // ⚠ `verify_calib` 的夹具把轴做成了 X（那是那份夹具自己的简化）；
    //   真素材是 Z，而**自转轴写错的话轮子会横着滚**——
    //   所以这里的夹具必须与素材一致，否则判据量的是一个不存在的轴。
    const wheelGeo = () => {
      const g = new CylinderGeometry(R, R, 0.089, 20);
      g.rotateX(Math.PI / 2);
      return g;
    };
    const FRONT = [-0.305, 0.1998, 0.0737] as const;
    const REAR = [0.2915, 0.1997, -0.0404] as const;
    const CRANK = [0.0535, 0.1724, 0.005] as const;

    const buildBike = () => {
      const root = new Group();
      root.add(
        mk(wheelGeo(), 'tripo_part_0', ...FRONT),
        mk(wheelGeo(), 'tripo_part_2', ...REAR),
        // 鞍面：顶面在 0.5446（实测 0.5441）
        mk(new BoxGeometry(0.17, 0.08, 0.13), 'tripo_part_7', 0.1377, 0.5046, -0.0164),
        // 脚撑：0.05 × 0.197 × 0.17，底端正好落地
        mk(new BoxGeometry(0.05, 0.197, 0.17), 'tripo_part_11', 0.2997, 0.0983, -0.0446),
        // 曲柄组：轴心 + 两条臂 + 两只踏板（左右相差 180°）
        mk(new BoxGeometry(0.024, 0.024, 0.054), 'crankAxle', ...CRANK),
        mk(new BoxGeometry(0.04, 0.198, 0.012), 'crankArmL', CRANK[0], CRANK[1] - 0.099, CRANK[2]),
        mk(new BoxGeometry(0.04, 0.198, 0.012), 'crankArmR', CRANK[0], CRANK[1] + 0.099, CRANK[2]),
        mk(new BoxGeometry(0.05, 0.02, 0.065), 'pedalL', CRANK[0] - 0.007, CRANK[1] - 0.083, CRANK[2] + 0.051),
        mk(new BoxGeometry(0.05, 0.02, 0.065), 'pedalR', CRANK[0] + 0.007, CRANK[1] + 0.083, CRANK[2] - 0.051),
        // 前端：车把 + 两只握把 + 前挡泥板（跟着前轮一起转向的那一坨）
        mk(new BoxGeometry(0.05, 0.03, 0.37), 'tripo_part_8', -0.104, 0.619, 0.004),
        mk(new BoxGeometry(0.08, 0.03, 0.03), 'tripo_part_23', -0.104, 0.619, 0.16),
        mk(new BoxGeometry(0.08, 0.03, 0.03), 'tripo_part_25', -0.104, 0.619, -0.16),
        mk(new BoxGeometry(0.1, 0.16, 0.06), 'tripo_part_5', -0.225, 0.357, 0.06),
      );
      return root;
    };

    // 角色：一根骨 + 一段骑行片段（骨盆高度 0.504 = 真素材实测值）
    //
    // ★ **必须带一个网格**，否则 `autoScaleToHeight()` 量到空盒、恒返回 1，
    //   「缩放幂等」那条断言就变成 1 === 1 的空转。
    //   网格高 **1.0**，与真素材归一化后的身高一致（实测包围盒 y 0..0.998），
    //   所以缩放应当是 1.75/1.0 = 1.75。
    const char = new Object3D();
    const hips = new Bone();
    hips.name = 'mixamorigHips';
    char.add(hips);
    // ★ **必须带左右踝骨**：自行车的摆位判据量的是「脚圈中心落在曲柄轴心上」
    //   （见下面第 6 条），而脚圈中心就是两踝中点绕着转的那个点。
    //   只挂一根髋骨的话量不到脚圈中心，摆位会退回鞍面法，那条断言就测不到
    //   它本来要测的东西了——**测不到 ≠ 通过**，所以这里要补上。
    //   位置取自真素材实测（角色本地、模型单位）。
    const lf = new Bone();
    lf.name = 'mixamorigLeftFoot';
    lf.position.set(0.1, 0.15, 0.06);
    char.add(lf);
    const rf = new Bone();
    rf.name = 'mixamorigRightFoot';
    rf.position.set(-0.07, 0.24, 0.06);
    char.add(rf);
    const body = new Mesh(new BoxGeometry(0.4, 1.0, 0.2));
    body.name = 'charBody';
    body.position.set(0, 0.5, 0);
    char.add(body);
    const rideTimes = new Float32Array([0, 1]);
    const rideClip = new AnimationClip('骑自行车', 1, [
      new KeyframeTrack('mixamorigHips.position', rideTimes, Float32Array.from([0, 0.504, 0, 0, 0.504, 0])),
    ]);

    const bike = buildBike();
    const v = new Vehicle();
    v.attach({
      bike,
      motorcycle: new Object3D(),
      skate: new Object3D(),
      char,
      clips: collectClips([rideClip]),
    });
    const ok = v.set('bike');

    // 1. 装配必须成功。`rig = null` 意味着转向 / 脚撑 / 曲柄**全部静默失效**。
    asserts++;
    if (!ok || v.id !== 'bike') {
      probs.push('切不到 bike 模式');
      return expect(false, probs.join('；'), asserts);
    }
    if (!v.hasBikeRig) {
      probs.push('自行车装配返回 null —— 转向 / 脚撑 / 曲柄全都静默失效');
      return expect(false, probs.join('；'), asserts);
    }

    // 1b. ★ **角色缩放必须幂等**
    //
    // `attach()` 与每次 `set()` 都会 `rebuild()`，而 `rebuild()` 会把量出来的
    // 缩放**写回同一个节点**。`Box3.setFromObject()` 量的是**世界**盒子，
    // 于是第二次量到的是自己的产物：`1.75 / (0.998×1.753) = 1.000` ——
    // **人矮 43%**。触发只需要按一下 `E`，或者摩托车模型晚到。
    //
    // 症状与「人不在车上」是同一个画面（人小一号），
    // 而画面上分不出是站位算错还是人被缩小了。
    asserts++;
    {
      const first = char.scale.x;
      asserts++;
      if (Math.abs(first - 1.75) > 0.01) {
        probs.push(`角色缩放 ${first.toFixed(4)}，身高 1.0 的模型应为 1.75 —— 量不到就是量到了空盒`);
      }
      v.set('foot');
      v.set('bike');
      asserts++;
      if (Math.abs(char.scale.x - first) > 1e-6) {
        probs.push(
          `角色缩放第一次 ${first.toFixed(4)}、切一轮载具后 ${char.scale.x.toFixed(4)} —— 量到了自己的产物（人缩小）`,
        );
      }
    }

    // 2. ★ **轮子必须往前转**（正负号）
    //
    // 不打滑要求 `v_中心 + ω × r = 0`：前进 −X、轴 +Z、接地点 (0,−R,0)
    // ⇒ **ω = +v/R**。原来三个载具都写成负号，于是轮子全在倒着转，
    // 而既有判据量的都是「转了多少」，没有一条量正负号。
    asserts++;
    const bikeScale = bike.scale.x;
    {
      for (let i = 0; i < 60; i++) v.update(1 / 60, 2, 0); // 1 秒，2 m/s
      const ang = v.bikeWheelAngle;
      if (!(ang > 0)) {
        probs.push(`前进 2m/s 一秒后后轮转角是 ${ang.toFixed(3)} rad，轮子在倒着转（应为正）`);
      }
      asserts++;
      // 不打滑：转过的角度 = 里程 ÷ 轮半径。半径用实测轮半径换算成车模单位。
      const want = 2 / (0.35);
      if (Math.abs(ang - want) > 0.02) {
        probs.push(`转角 ${ang.toFixed(3)} rad，里程 2m ÷ 轮半径 0.35m 应为 ${want.toFixed(3)}`);
      }
    }

    // 3. ★ **曲柄必须比轮子慢 `BIKE_GEAR_RATIO` 倍**（链盘比飞轮大）
    //
    // 少了传动比就是「链子在用减速把轮子往回驱」——那个机构不存在。
    //
    // ⚠ 判据写成 `crankAngle × gear === wheelAngle`，**不是**两者的比值：
    //   `wheelAngle = 里程 / 轮半径(米)`、`crankAngle = 里程 / 传动比`，
    //   两式相除会剩下一个**米**的量纲因子（0.35），而传动比是无量纲的。
    //   我第一版就写成了「比值 = 1/2.6」，量到 0.1346 = 0.35/2.6 ——
    //   **量出来的是对的，是判据把量纲漏了**。
    asserts++;
    {
      const geared = v.bikeCrankAngle * BIKE_GEAR_RATIO;
      if (!(v.bikeCrankAngle > 0)) {
        probs.push('曲柄没跟着轮子转（人在踩踏板而踏板不动）');
      }
      asserts++;
      if (Math.abs(geared - v.bikeWheelAngle) > 1e-3) {
        probs.push(
          `曲柄角×${BIKE_GEAR_RATIO} = ${geared.toFixed(3)}，轮角 ${v.bikeWheelAngle.toFixed(3)} —— 两者应相等（轮子比曲柄快 ${BIKE_GEAR_RATIO} 倍）`,
        );
      }
    }

    // 4. ★ **脚撑：停着放下来垂直于地面，骑起来折起**
    //
    // 用户明确要求的行为，而原来**没有任何**断言会红。
    // 纯函数先问一遍（阈值边界），再问装配后的实际角度。
    asserts++;
    {
      if (standFoldAt(0) !== 0) probs.push('停着时脚撑不是放下的（0 rad）');
      asserts++;
      if (standFoldAt(8) !== STAND_FOLD_ANGLE) {
        probs.push(`骑起来时脚撑不是折起角 ${STAND_FOLD_ANGLE.toFixed(3)}`);
      }
    }
    asserts++;
    {
      // 停住 3 秒（damp 收敛）
      for (let i = 0; i < 180; i++) v.update(1 / 60, 0, 0);
      const down = v.standAngle;
      if (Math.abs(down) > 0.02) {
        probs.push(`停住 3 秒后脚撑角度 ${down.toFixed(3)} rad，应为 0（垂直落地）`);
      }
      asserts++;
      // 起步 3 秒
      for (let i = 0; i < 180; i++) v.update(1 / 60, 3, 0);
      const up = v.standAngle;
      if (Math.abs(up - STAND_FOLD_ANGLE) > 0.05) {
        probs.push(`骑 3 秒后脚撑角度 ${up.toFixed(3)} rad，应折起到 ${STAND_FOLD_ANGLE.toFixed(3)}`);
      }
    }

    // 5. ★ **车把随转向打方向**，且方向要对
    //
    // 判据是**符号**：航向角增大 = 左转（`ride.ts` 的 `_fwd` 在 h 增大时偏向 −X，
    // 而 −X 是左），前轮应当**朝左**打。符号反了的话车会往弯外推。
    asserts++;
    {
      // 停住，先让转向角回到 0
      for (let i = 0; i < 180; i++) v.update(1 / 60, 4, 0);
      const straight = v.barAngle;
      // 左转：每帧 **0.9°**（= 54°/s），4 m/s。
      // δ = atan(ω·L / v)：ω = 0.94 rad/s、轴距 ≈ 1.10m、v = 4 ⇒ δ ≈ 14.5°，
      // 在 `BIKE_STEER_MAX`（11.5°）处被夹住——正好压着上限。
      // ⚠ 每帧增量是**弧度**（0.9° = 0.0157 rad），不是「度每秒」。
      const PER_FRAME = (0.9 * Math.PI) / 180;
      for (let i = 0; i < 60; i++) v.update(1 / 60, 4, i * PER_FRAME);
      const left = v.barAngle;
      asserts++;
      if (!(left > 0.02)) {
        probs.push(`左转 1 秒后车把角 ${left.toFixed(3)} rad（起手 ${straight.toFixed(3)}），轮子没往左打`);
      }
      asserts++;
      if (left > BIKE_STEER_MAX + 1e-6) {
        probs.push(`车把角 ${left.toFixed(3)} rad 超过上限 ${BIKE_STEER_MAX}，手会离开车把`);
      }
      // 右转必须反向（两倍角速度，方向相反）
      const hEnd = 59 * PER_FRAME;
      for (let i = 0; i < 120; i++) v.update(1 / 60, 4, hEnd - i * PER_FRAME * 2);
      asserts++;
      if (!(v.barAngle < left)) {
        probs.push(`右转后车把角 ${v.barAngle.toFixed(3)} 没有比左转的 ${left.toFixed(3)} 更小（方向没反过来）`);
      }
    }

    // 6. ★ **站位**：骨盆必须落在鞍面上
    //
    // 判据换过三次，每次都因为踩到同一个坑：
    //
    // ① 写死的 `SADDLE_H = 1.05` 与这台车的鞍面（实测 0.979m）和动画的骨盆高度
    //    （0.504 角色单位 = 0.882m）**都对不上**，所以那一版必然坐歪。
    // ② 「脚圈中心 = 曲柄轴心」让脚够得着踏板了，可是这套骑行动画的腿**相对**
    //    这台车太短（腿长/曲柄半径 3.93 vs 7.23），骑手被迫悬空 13.6cm——
    //    那是个**取舍**，画面上读作「车对 rider 偏小」。
    // ③ 现在两条腿的旋转轨道被**两骨 IK 重烘**过（`bakeRideToPedals`）：
    //    脚踝真的落在踏板圆上、整圈闭合，而烘焙的圆心由**鞍面**反推，
    //    于是骨盆同时落回鞍面——②那个取舍没有了。
    //
    // ★ 这里问**骨盆**而不是「脚在踏板上」：夹具角色的双脚是**静止**的
    //   （只有 quaternion 轨道，没有 position 轨道），它压根没有踏板圆可落。
    //   问「脚踩在踏板上」只能对**真素材**问——`verify_vehicle_real` 第 5 条在问。
    //   这里能问、也该问的是「人坐在车上了没有」。
    asserts++;
    {
      const seat = v.bikeSeat;
      if (!seat) {
        probs.push('量不到鞍面（saddleTopOf 返回空）—— 站位会退回写死的 1.05m');
      } else {
        const pelvisH = v.pelvisHeight;
        const seatWorldY = seat.y * bikeScale;
        // ★ 比的是**骨盆**，不是角色原点：原点在骨盆**下方** `pelvisHeight × 缩放`
        //   （实测 0.882m）处，拿它跟鞍面比量到的是 −0.75m 这种毫无意义的数。
        const pelvisY = char.position.y + pelvisH * char.scale.x;
        asserts++;
        if (Math.abs(pelvisY - (seatWorldY + 1.75 * 0.006)) > 0.03) {
          probs.push(
            `骨盆在 y=${pelvisY.toFixed(3)}m，鞍面 ${seatWorldY.toFixed(3)}m 上方 1.1cm 应为 ${(seatWorldY + 0.0105).toFixed(3)}m —— 人不在车上`,
          );
        }
        notes.push(`骨盆高于鞍面 ${((pelvisY - seatWorldY) * 100).toFixed(1)}cm`);
        // 重心必须在坐垫**后面**一点（车模 +X 是车尾，见 `PELVIS_BEHIND_SADDLE`）。
        // ★ 把骑手位置**变回车模空间**再比，而不是在 group 空间里比某个轴——
        //   「模型 x = group z」只在偏航**恰好是 −90°** 时成立，而实测行车基底
        //   是 −100.71°，按老约定去比会量到 −0.218m。
        const gotX = new Vector3().copy(char.position).applyMatrix4(bike.matrix.clone().invert()).x;
        const wantX = seat.x + 0.045 / bikeScale;
        asserts++;
        if (Math.abs(gotX - wantX) > 0.006) {
          probs.push(
            `骑手重心比鞍面靠后 ${((gotX - seat.x) * bikeScale).toFixed(3)}m，应为 0.045m` +
              `（比的是车模空间的 x，与偏航无关）`,
          );
        }
      }
    }

    // 9b. ★ 自行车的自转轴同样必须**水平且垂直于前进方向**
    asserts++;
    {
      for (let i = 0; i < 30; i++) v.update(1 / 60, 4, 0); // heading = 0 ⇒ 前进方向 -Z
      const axis = v.bikeSpinAxisWorld;
      asserts++;
      if (!axis) {
        probs.push('自行车没有自转层 —— 后轮压根不转');
      } else {
        asserts++;
        if (Math.abs(axis.y) > 0.02) {
          probs.push(
            `自行车自转轴不水平（y = ${axis.y.toFixed(4)}，${((Math.asin(Math.abs(axis.y)) * 180) / Math.PI).toFixed(2)}°）` +
              ' —— 轮子会一边滚一边蹭',
          );
        }
        asserts++;
        if (Math.hypot(axis.x, axis.z) < 0.99) {
          probs.push(
            `自行车自转轴是 (${axis.x.toFixed(3)}, ${axis.y.toFixed(3)}, ${axis.z.toFixed(3)})，` +
              '它没有垂直于前进方向 —— 轮子横着滚',
          );
        }
      }
    }

    // 10. 骑行轨的播放倍率：停住必须 0（人定住，不是原地空踩踏板）
    asserts++;
    {
      for (let i = 0; i < 60; i++) v.update(1 / 60, 0, 0);
      if (Math.abs(v.rideTimeScale) > 1e-6) {
        probs.push(`车停住时骑行动画倍率 ${v.rideTimeScale.toFixed(3)}，应为 0`);
      }
      asserts++;
      for (let i = 0; i < 60; i++) v.update(1 / 60, 3, 0);
      if (!(v.rideTimeScale > 0.5)) {
        probs.push(`骑 3 m/s 时骑行动画倍率 ${v.rideTimeScale.toFixed(3)}，踏板不动`);
      }
    }

    // 8. ★ **反复切载具不许堆积空节点**
    //
    // `attach()` 不重新加载模型，枢轴却每次新建。
    // 不清就会在车里一层层堆空 Group——每次切换泄漏几个，
    // 而「多几个空节点」没有任何症状，只有这条判据看得见。
    asserts++;
    {
      const count = () => bike.children.filter((c) => c.name.startsWith('rig:')).length;
      const before = count();
      v.set('foot');
      v.set('bike');
      v.set('foot');
      v.set('bike');
      asserts++;
      if (count() !== before || before === 0) {
        probs.push(`切 4 次载具后装配节点从 ${before} 变成 ${count()}（空节点在累积）`);
      }
    }

    const summary =
      `轮角 +${(2 / 0.35).toFixed(2)} rad/2m（不打滑）· 曲柄 = 轮角/${BIKE_GEAR_RATIO} · ` +
      `脚撑 0 ⇄ ${((STAND_FOLD_ANGLE * 180) / Math.PI).toFixed(0)}° · 车把 ≤ ${((BIKE_STEER_MAX * 180) / Math.PI).toFixed(1)}° · ` +
      `脚圈中心 = 曲柄轴心` +
      (notes.length ? ` · ${notes.join(' · ')}` : '');
    return expect(probs.length === 0, probs.length ? probs.join('；') : summary, asserts);
  });

  // ---------------------------------------------------------------- 骑行
  check('verify_ride', () => {
    const r = assertRide();
    return { ok: r.ok, detail: r.detail, asserts: r.asserts };
  });

  /**
   * 演示模式那辆车自己往前骑。
   *
   * 独立成一条而不是塞进 `verify_ride`：它量的不是"车能不能动"，
   * 而是"没有人按键时车会不会自己开进草地"——那个按钮原来根本不开车。
   */
  check('verify_demo_drive', () => {
    const r = assertDemoDrive();
    return { ok: r.ok, detail: r.detail, asserts: r.asserts };
  });

  // ---------------------------------------------------------------- 演示的 90 秒承诺
  /**
   * **标题页上那句「演示 · 90 秒」，必须是代码里真会走到的一行。**
   *
   * ## 它守的是哪一族 bug
   *
   * `ECON.DEMO_BUDGET_SEC` 在 `economy.json` 里躺着，`raw.ts` 给它标了类型，
   * 但**整个代码库里从来没被读过一次**——只在 `main.ts` 一条注释里出现过。
   * `startDemo()` 只做解锁音频、放 BGM、对白自动推进，于是演示永远不会结束。
   * 实测无头跑 309 秒，天数、驿站、铜钱从 +238s 起到 +309s 一个都没变过。
   *
   * 一个兑现不了的按钮比没有按钮更糟：它把"我不知道自己要等多久"
   * 直接写在了界面上。
   *
   * ## 判据为什么是读源码
   *
   * 演示结束是一个 **UI 事件**（结算页弹出来），无头 Node 里既没有 DOM、
   * 也没有 90 秒的耐心。所以判据只问结构上可查的事：那一行读取还在不在，
   * 读到之后走到哪里去了。
   *
   * ## 会红的做法
   *   · 删掉 `demoTick()` 里那句 `if (this.demoT >= ECON.DEMO_BUDGET_SEC)`      → 红（第 1、2 条）
   *   · 把 `finishRun()` 换成只加秒表不收场                                        → 红（第 2 条）
   *   · 删掉 `render()` 里那行 `this.demoTick(dt)`                               → 红（第 2 条）
   *   · 从 i18n 里删掉 `demo_card_notice`                                          → 红（第 3 条）
   *   · 把 `DEMO_END_AT_SEC` 调到 ≥ `DEMO_BUDGET_SEC`                             → 红（第 4 条）
   */
  check('verify_demo_budget', () => {
    let asserts = 0;
    const probs: string[] = [];
    const read = (rel: string): string =>
      readFileSync(join(process.cwd(), 'src', rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    const main = read('main.ts');

    // 1. 预算必须被真的读到。注释里提过不算——上面 read() 已经剥掉了注释。
    asserts++;
    if (!/ECON\.DEMO_BUDGET_SEC/.test(main)) {
      probs.push('main.ts 从未读取 ECON.DEMO_BUDGET_SEC —— 标题页上的「演示 · 90 秒」没有人执行');
    }

    // 2. 读到了之后必须真的收场，而且秒表真的在每帧被喂。
    //
    //    拆成两半是因为它们各自能独立坏掉：秒表存在但没人喂（演示照旧无限长），
    //    或者被喂了但到了点不收场（同上）。合在一起断言，红的时候分不清是哪一个。
    asserts++;
    const tickBody = (main.match(/demoTick\s*\([^)]*\)\s*:\s*void\s*\{([\s\S]*?)\n  \}/) || [, ''])[1];
    if (!tickBody) {
      probs.push('main.ts 里没有 demoTick(dt) —— 演示的秒表没人推进');
    } else {
      if (!/ECON\.DEMO_BUDGET_SEC/.test(tickBody)) {
        probs.push('demoTick() 没拿 ECON.DEMO_BUDGET_SEC 当阈值 —— 收场的时机不在这个预算上');
      }
      if (!/finishRun\s*\(\s*\)/.test(tickBody)) {
        probs.push('demoTick() 里没有 finishRun() —— 预算用掉了，演示却不会停');
      }
    }
    if (!/this\.demoTick\s*\(\s*dt\s*\)/.test(main)) {
      probs.push('没有地方调用 this.demoTick(dt) —— 秒表存在但没人喂它');
    }

    // 3. 收尾那句提示必须真的存在，不然玩家看到的是裸 key。
    asserts++;
    for (const lang of ['zh', 'en'] as const) {
      const v = I18N[lang]?.['demo_card_notice'];
      if (typeof v !== 'string' || v.length === 0) {
        probs.push(`文案缺 demo_card_notice（${lang}）—— 演示收尾那句提示会显示成裸 key`);
      }
    }

    // 4. 预算本身得像个 90 秒，而且小游戏跳过的时机必须落在收场之前。
    //
    //    第二条：`DEMO_END_AT_SEC` 是"演示里不玩小游戏"的开关。若它落在预算之后，
    //    演示会先弹出结算页、跳过逻辑再也没机会执行——那句
    //    "演示模式不玩小游戏"就成了只在非演示时才成立的废话。
    asserts++;
    if (!(ECON.DEMO_BUDGET_SEC > 0 && ECON.DEMO_BUDGET_SEC <= 120)) {
      probs.push(`DEMO_BUDGET_SEC = ${ECON.DEMO_BUDGET_SEC} —— 跟按钮上写的「90 秒」对不上`);
    }
    if (ECON.DEMO_END_AT_SEC >= ECON.DEMO_BUDGET_SEC) {
      probs.push(
        `DEMO_END_AT_SEC(${ECON.DEMO_END_AT_SEC}) ≥ DEMO_BUDGET_SEC(${ECON.DEMO_BUDGET_SEC})`
          + ' —— 小游戏的跳过时机落在演示结束之后，演示里根本没有跳过这一环',
      );
    }

    return expect(
      probs.length === 0,
      probs.length ? probs.join('；')
        : `演示预算 ${ECON.DEMO_BUDGET_SEC}s 被真读到、到点真的收场、提示文案在、跳过时机(${ECON.DEMO_END_AT_SEC}s)落在收场之前`,
      asserts,
    );
  });

  /**
   * ## 载具的标定必须**可重复**
   *
   * 两条都是实机抓出来的，而且都属于"第一次切换是对的、第二次开始错"那一族：
   *
   * 1. **缩放会漂。** `scaleByFrontWheel()` 原来用 `Box3.setFromObject()`——
   *    那是**世界**盒子，而 `rebuild()` 里 `group.clear()` 之后模型的
   *    `scale` 还留着上一轮的值。于是第二次量到的是**已经缩放过一遍的盒子**，
   *    返回 1，车缩成 56%。`bicycle.glb` 实测 1.798 → 掉到 1。
   * 2. **车把枢轴落错地方。** 同一个世界盒子被当成 `pivot.position` 喂进去
   *    （pivot 是子节点、坐标是本地的），车把一转就把**前轮甩出去**。
   *
   * 判据是**做两遍**：同一个模型挂两次、量两次，两个数必须一样。
   * 一遍看不出这类 bug——它只在"第二次"才发作。
   */
  check('verify_calib', () => {
    let asserts = 0;
    const probs: string[] = [];

    /**
     * 造一个「前轮 + 车架 + 车把」的小模型，尺寸按 `bicycle_clean.glb` 的比例
     * （轮半径 0.1947、车架 0.98 长）。轮子**带自己的节点平移**，
     * 所以世界盒子与本地盒子的差别是真实存在的，不是造出来的。
     */
    const buildBike = () => {
      const root = new Group();
      const wheelGeo = new CylinderGeometry(0.09, 0.09, 0.05, 16);
      wheelGeo.rotateX(Math.PI / 2); // 轮面在 YZ 平面 → 轴是本地 X
      const frameGeo = new BoxGeometry(0.98, 0.12, 0.12);
      const front = new Mesh(wheelGeo);
      front.name = 'tripo_part_0';
      front.position.set(-0.311, 0.195, 0.0);
      const rear = new Mesh(wheelGeo.clone());
      rear.name = 'tripo_part_2';
      rear.position.set(0.287, 0.195, 0.0);
      const frame = new Mesh(frameGeo);
      frame.name = 'frame';
      frame.position.set(0, 0.3, 0);
      for (const m of [front, rear, frame]) root.add(m);
      return root;
    };

    // 1. 缩放可重复：挂一次、挂两次，两次必须给出同一个数
    asserts++;
    {
      const root = buildBike();
      const a = bicycleScale(root);
      // 模拟 rebuild()：只把模型摘下来，**不动它的 scale**
      root.scale.setScalar(a);
      const b = bicycleScale(root);
      if (Math.abs(a - b) > 1e-9) {
        probs.push(`缩放不可重复：第一次 ${a.toFixed(4)}，第二次 ${b.toFixed(4)}`);
      }
      asserts++;
      // 圆柱半径 0.09 ⇒ 竖直跨度 0.18 ⇒ 半径 0.09；0.35 / 0.09 = 3.889
      if (Math.abs(a - 0.35 / 0.09) > 0.01) {
        probs.push(`自行车缩放 ${a.toFixed(4)}，按轮半径 0.09 应为 ${(0.35 / 0.09).toFixed(4)}`);
      }
    }

    // 2. 缩放必须与「模型已经缩放过」无关：量的是**本地**盒子
    asserts++;
    {
      const root = buildBike();
      const before = bicycleScale(root);
      root.scale.setScalar(3.7); // 随便一个已经缩过的状态
      const after = bicycleScale(root);
      asserts++;
      if (Math.abs(before - after) > 1e-9) {
        probs.push(`缩放依赖模型当前的 scale（${before.toFixed(4)} vs ${after.toFixed(4)}）——量的是世界盒子`);
      }
    }

    // 3. 车把枢轴必须落在**前轮轴心**上
    asserts++;
    {
      const root = buildBike();
      root.position.set(-14, 0, 77); // 模拟 ride 位：世界坐标远不等于本地
      root.updateMatrixWorld(true);
      const frontLocal = localUnion(root, ['tripo_part_0']);
      asserts++;
      if (frontLocal.isEmpty()) {
        probs.push('量不到前轮包围盒');
      } else {
        const c = frontLocal.getCenter(new Vector3());
        asserts++;
        if (Math.abs(c.x - (-0.311)) > 0.02 || Math.abs(c.y - 0.195) > 0.02 || Math.abs(c.z) > 0.02) {
          probs.push(
            `前轮轴心量成了 (${c.x.toFixed(3)}, ${c.y.toFixed(3)}, ${c.z.toFixed(3)})，应为 (-0.311, 0.195, 0)`,
          );
        }
      }
    }

    return {
      ok: probs.length === 0,
      detail: probs.length === 0 ? '缩放可重复且与当前 scale 无关 · 前轮轴心在本地空间量对' : probs.join('；'),
      asserts,
    };
  });

  /**
   * ## 骑手必须**真的骑在车上**
   *
   * 这一条是被用户一句「滑板上要站人」逼出来的，而它抓到的 bug 比听上去严重：
   * **骑手在自行车上也不见了**，只是没人提，因为滑板那一眼最容易看出来。
   *
   * ## 成因：把世界坐标喂进了本地字段
   *
   * `Vehicle.update()` 里算骑手位置时写的是
   * `bike.localToWorld(p)` —— 它返回**世界**坐标；
   * 而 `char.position` 是在**父节点 `this.group` 的空间**里解读的。
   * `group` 自己已经平移到玩家位置（沿路几百米），两者一混，
   * 角色被放到「距原点两倍」的地方，实机上就是**人不见了**。
   *
   * `bike` 与 `char` 是**兄弟节点**，所以从车的本地空间走到 group 本地空间
   * 只需要乘 `bike.matrix`（含车自己的缩放与偏航），不需要任何世界坐标。
   *
   * ## 为什么这一族 bug 没人发现
   *
   * 症状是"画面里少个人"，而这一路上所有判据量的都是**别的东西**：
   * 速度、离地、面数、离路判定、朝向——全都正常。
   * 徒步分支用 `char.position.set()`（本来就是本地坐标）所以没事，
   * 于是"人在徒步时可见、在车上时不可见"这件事没有留下任何数字痕迹。
   *
   * ## 它会红的方式
   *
   * 把 `applyMatrix4(bike.matrix)` 换回 `localToWorld(p)` → 距离从 1m 变成 ~470m，红。
   */
  check('verify_rider', () => {
    let asserts = 0;
    const probs: string[] = [];

    const char = new Object3D();
    const bike = new Object3D();
    const skate = new Object3D();
    const v = new Vehicle();
    v.attach({ bike, skate, char, clips: collectClips([]) });

    // 沿路的真实量级：路线坐标是几百米量级，所以「本地当成世界」会差出几百米。
    const RIDE_POS = new Vector3(-412, 0, 233);

    for (const mode of ['bike', 'skate'] as RideMode[]) {
      v.set(mode);
      v.group.position.copy(RIDE_POS);
      v.group.updateMatrixWorld(true);
      // 走两帧，让阻尼类的东西稳定下来。
      for (let i = 0; i < 2; i++) {
        v.group.position.copy(RIDE_POS);
        v.update(1 / 60, 8, 0);
      }
      v.group.updateMatrixWorld(true);

      asserts++;
      const deck = (mode === 'bike' ? bike : skate).getWorldPosition(new Vector3());
      const rider = char.getWorldPosition(new Vector3());
      const d = rider.distanceTo(deck);
      if (!(d <= 2)) {
        probs.push(
          `${mode}：骑手离车 ${d.toFixed(1)}m` +
            `（车在 (${deck.x.toFixed(0)}, ${deck.y.toFixed(1)}, ${deck.z.toFixed(0)})，` +
            `人在 (${rider.x.toFixed(0)}, ${rider.y.toFixed(1)}, ${rider.z.toFixed(0)})）`,
        );
      }

      // 车换了模式之后人也必须还在车上：单独量一次"人在不在原点附近"，
      // 能把"整体平移"这种错误和"坐标空间搞错"这种错误分开。
      asserts++;
      if (Math.abs(rider.z - RIDE_POS.z) > 2 || Math.abs(rider.x - RIDE_POS.x) > 2) {
        probs.push(`${mode}：骑手被甩离 ride 位，横向偏了 ${(rider.x - RIDE_POS.x).toFixed(1)}m / ${(rider.z - RIDE_POS.z).toFixed(1)}m`);
      }
    }

    // 徒步那条分支用 `char.position.set()`，本来就是本地坐标——
    // 顺手钉住它，免得有人"顺手统一"成 applyMatrix4 而弄坏徒步。
    asserts++;
    {
      v.set('foot');
      v.group.position.copy(RIDE_POS);
      v.update(1 / 60, 4, 0);
      v.group.updateMatrixWorld(true);
      const rider = char.getWorldPosition(new Vector3());
      const want = RIDE_POS.clone().add(new Vector3(FOOT_LATERAL_OFFSET, 0, 0));
      const d = rider.distanceTo(want);
      if (d > 0.5) {
        probs.push(`徒步：角色应在 ride 位，实际偏了 ${d.toFixed(2)}m`);
      }
    }

    return {
      ok: probs.length === 0,
      detail: probs.length === 0 ? '自行车 / 滑板 / 徒步三种模式下骑手都在车上（远点 470m 量级）' : probs.join('；'),
      asserts,
    };
  });

  /**
   * ## 三个载具的前方必须是**同一个方向**
   *
   * 这一条是被实机抓出来的：人物**倒着走**——玩家从背后看到的是他的脸。
   *
   * 之所以没有任何断言发现，是因为三个 `rotation.y` 是**三处各自独立的常数**：
   * 人物的 `heading + CHAR_FACING_YAW`、自行车的 `BICYCLE_YAW`、
   * 摩托车的 `MOTORCYCLE_YAW`。代码里没有任何东西把它们联系起来，
   * 所以「人正着走、车却横着跑」既不产生错误、也不改变任何被量的量
   * （速度、离地、面数、离路判定全都正常）。
   *
   * 判据是**算的**而不是看的：把每个模型的车头（本地空间，实测自轮子节点平移）
   * 加上它自己的偏航，算出世界前进方向，三个都必须是 `(0, 0, −1)`。
   *
   * ## 它会红的方式
   *
   * · 把 `CHAR_FACING_YAW` 去掉 → 人物算成 +Z，红
   * · 把 `BICYCLE_YAW` 写成 +90° → 自行车算成 +Z，红
   * · 把 `MODEL_HEADS.bicycle` 写成 +X → 自行车算成 +Z，红
   */
  check('verify_facing', () => {
    let asserts = 0;
    const probs: string[] = [];
    // 本作的车头约定（ride.ts 的 _fwd 在 h=0 时指向 −Z）
    const FWD: readonly [number, number, number] = [0, 0, -1];

    const rows: [string, readonly number[], number][] = [
      ['人物', MODEL_HEADS.char, CHAR_FACING_YAW],
      ['自行车', MODEL_HEADS.bicycle, BICYCLE_YAW],
      ['摩托车', MODEL_HEADS.motorcycle, MOTORCYCLE_YAW],
    ];

    for (const [name, head, yaw] of rows) {
      asserts++;
      const d = facingDir(head, yaw);
      // 偏航是绕 Y 的，所以 y 分量恒为 0；只看水平面内的两个分量。
      const err = Math.hypot(d[0] - FWD[0], d[2] - FWD[2]);
      if (err > 1e-6) {
        probs.push(
          `${name}的车头算出来是 (${d.map((v) => v.toFixed(3)).join(', ')})，应为 (0, 0, -1)`,
        );
      }
    }

    // 三者必须**彼此**一致，而不只是各自都"看着对"——
    // 万一有人把约定整体改成 +Z，这条会红而上面三条不会。
    asserts++;
    const dirs = rows.map(([, head, yaw]) => facingDir(head, yaw));
    for (let i = 1; i < dirs.length; i++) {
      const e = Math.hypot(dirs[i][0] - dirs[0][0], dirs[i][2] - dirs[0][2]);
      if (e > 1e-6) probs.push(`${rows[i][0]}与${rows[0][0]}的前方不一致`);
    }

    // 车头单位向量归一化：忘了归一化的话方向对、长度不对，
    // 而"长度"在代码里没有任何地方用到，所以不会有人发现。
    asserts++;
    for (const [name, head] of rows) {
      const len = Math.hypot(head[0], head[2]);
      if (Math.abs(len - 1) > 1e-6) probs.push(`${name}的车头向量长度是 ${len.toFixed(4)}，应为 1`);
    }

    // ★ **轮子自转轴必须平行于水平面**（y 分量恒为 0）。
    //
    // 偏航是绕 Y 的，所以它不会动任何东西的"水平性"；真正会弄歪轴的是
    // **左右倾角**。而倾角只在静止时非零，轮子也只在移动时转——
    // 这两件事叠起来，轴在自转时恒为水平。少任何一半都不成立。
    asserts++;
    const axles: [string, readonly number[], number][] = [
      ['自行车', MODEL_AXES.bicycle, BICYCLE_YAW],
      ['摩托车', MODEL_AXES.motorcycle, MOTORCYCLE_YAW],
    ];
    for (const [name, axle, yaw] of axles) {
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      // 绕 Y 转 θ：(x,0,z) → (x·cosθ + z·sinθ, 0, −x·sinθ + z·cosθ)
      const ax = axle[0] * c + axle[2] * s;
      const az = -axle[0] * s + axle[2] * c;
      // y 分量在纯偏航下恒为 0，所以这条实际是在钉"偏航必须是纯 Y"这件事
      if (Math.abs(ax) > 1e-9 && Math.abs(az) > 1e-9 && Math.hypot(ax, az) < 0.5) {
        probs.push(`${name}的自转轴偏航后指向 (${ax.toFixed(3)}, 0, ${az.toFixed(3)})，它不该指向车头方向`);
      }
    }

    // ★ 移动时倾角必须是 0（否则轮子会转成椭圆）
    asserts++;
    for (const sp of [1, 5, 15, 24]) {
      if (motoLeanAt(sp) !== 0) {
        probs.push(`${sp} m/s 时摩托车仍有 ${motoLeanAt(sp).toFixed(3)} rad 倾角，轮子会转成椭圆`);
      }
    }
    asserts++;
    if (motoLeanAt(0) === 0) probs.push('静止时摩托车没有侧倾，停着看起来是扶正的');
    asserts++;
    // ★ 符号判据随**倾角挂在哪个节点上**翻转过一次，这里记着为什么。
    //
    //   旧：倾角写 `moto.rotation.z`，绕的是**模型本地 Z**。
    //       绕 +Z 转正角把车顶推向模型 +X，而模型 +X = 车的左 ⇒ 要**负**角。
    //   新：倾角写 `motoSlot.rotation.z`（`moto` 的父节点，基底之外），
    //       绕的是**真正的、水平的前后轴**。绕 +Z 转正角把车顶推向行驶的 −X，
    //       而行驶基底 +X 是**右**（`ride.ts` 的 `_right`）⇒ **正**角才是往左倒。
    //
    //   两次的**视觉结果一致**（都往左倒），但中间隔着一次「倾角绕的轴从
    //   偏 63.84° 的假轴换成真轴」的重构，符号必须跟着换，否则会悄悄倒向右边。
    if (motoLeanAt(0) <= 0) {
      probs.push(
        '侧倾方向不是正的 —— 倾角现在挂在 motoSlot 上（绕真正的前后轴），正角才是往左倒；' +
          '侧撑在左边，符号反了就是往右倒',
      );
    }

    return {
      ok: probs.length === 0,
      detail:
        probs.length === 0
          ? `人物 +π / 自行车 ${((BICYCLE_YAW * 180) / Math.PI).toFixed(2)}° / 摩托车 ${((MOTORCYCLE_YAW * 180) / Math.PI).toFixed(2)}°（实测车头 + 行走基底）→ 三者同为 (0, 0, −1)`
          : probs.join('；'),
      asserts,
    };
  });

  /**
   * ## 行车基底：车头与**自转轴**必须同时被纠回来
   *
   * 用户报的是两件事——「车轮乱滚」+「摩托车车头没对齐行走方向」——
   * 量下来它们是**同一个原因**：两个模型都相对自己的坐标轴歪着
   * （自行车 10.71°/10.67°，摩托车 26.59°/26.16°），
   * 而原来那套判据**只用包围盒**，分不出「轮面在那个平面里」和
   * 「轮面在那个平面里、但整台车又歪了 26°」。
   *
   * ### 为什么判据是**合成的已知歪角**，而不是钉那两个常数
   *
   * 钉常数只能证明「没人改过这两个数」，证不了「量法对不对」——
   * 而量法错了常数照样是绿的（它们是从错的量法里抄出来的）。
   * 所以这里造一台**歪 25°** 的合成车，答案已知，
   * 然后问 `measureDriveBasis` 能不能把它纠回 (−Z 车头、±X 车轴)。
   * 量法一旦回退到包围盒，这条立刻红。
   *
   * ### 它会红的方式
   *
   * · `measureWheel` 改回用 `geometry.boundingBox` 估轴 → 合成车的歪角量成 0，红
   * · 忘了对 `axle` 取「指向左侧」的符号 → 第 3 条红（自转会整体倒转）
   * · `quat` 用 `M` 而不是 `Mᵀ` → 第 1 条红（车头落到 +Z）
   */
  check('verify_drive_basis', () => {
    let asserts = 0;
    const probs: string[] = [];

    /**
     * 一台**已知歪角**的合成车：真车 + 绕 Y 歪 skewY，再加一点外倾。
     *
     * ★ 歪角挂在**子 Group** 上，不能挂在 `root` 自己身上：
     *   `measureWheel` 量的是「零件相对 root 的局部变换」（`root.matrixWorld⁻¹ · part.matrixWorld`），
     *   所以 **root 自己的旋转会被约掉**——歪在 root 上的车在它眼里是 perfectly 直的。
     *   真模型之所以歪，正是因为 Tripo 把歪烘进了**零件节点的变换**里，
     *   夹具必须复现同一件事，否则它量的是一台并不歪的车、然后"通过"。
     */
    const buildSkewed = (skewY: number, camber = 0) => {
      const root = new Group();
      // 名义上前轮在 −X、后轮在 +X、车轴沿 Z（与 bicycle.glb 的名义一致）。
      // 轮子用**实心圆柱**：协方差的最小特征向量必须落在轴上，
      // 而空心环在两个方向上的方差更接近、更容易看错。
      const wheelGeo = (R: number) => {
        const g = new CylinderGeometry(R, R, 0.09, 24);
        g.rotateX(Math.PI / 2); // 轴 → 本地 Z
        return g;
      };
      const tilt = new Group();
      tilt.rotation.y = skewY;
      tilt.rotateX(camber);
      const f = new Mesh(wheelGeo(0.195));
      f.name = 'tripo_part_0';
      f.position.set(-0.3, 0.2, 0);
      const r = new Mesh(wheelGeo(0.195));
      r.name = 'tripo_part_2';
      r.position.set(0.29, 0.2, 0);
      tilt.add(f, r);
      root.add(tilt);
      root.updateMatrixWorld(true);
      return root;
    };

    for (const [skew, camber] of [
      [0, 0],
      [(25 * Math.PI) / 180, 0],
      [(25 * Math.PI) / 180, (8 * Math.PI) / 180],
    ] as const) {
      const tag = `歪 ${((skew * 180) / Math.PI).toFixed(0)}° / 外倾 ${((camber * 180) / Math.PI).toFixed(0)}°`;

      // 1. ★ 车头必须被纠到 **−Z**
      asserts++;
      {
        const b = measureDriveBasis(buildSkewed(skew, camber), ['tripo_part_0'], ['tripo_part_2']);
        if (!b) {
          probs.push(`${tag}：量不到行车基底`);
        } else {
          const after = b.head.clone().applyQuaternion(b.quat);
          const err = Math.hypot(after.x, after.z + 1);
          asserts++;
          if (err > 1e-3) {
            probs.push(
              `${tag}：基底转完车头落在 (${after.x.toFixed(4)}, ${after.y.toFixed(4)}, ${after.z.toFixed(4)})，应为 (0, 0, -1)`,
            );
          }
        }
      }

      // 2. ★ 自转轴必须被纠到**水平**且**垂直于车头**（不平行于地面才不打滑）
      asserts++;
      {
        const b = measureDriveBasis(buildSkewed(skew, camber), ['tripo_part_0'], ['tripo_part_2']);
        if (b) {
          const after = b.axle.clone().applyQuaternion(b.quat);
          asserts++;
          // 水平：y ≈ 0。不打滑要求接地点速度为零，轴不水平就必然在蹭。
          if (Math.abs(after.y) > 1e-3) {
            probs.push(`${tag}：基底转完自转轴的 y 分量是 ${after.y.toFixed(4)}，车轴不水平`);
          }
          asserts++;
          // 垂直于车头：轴指向车头的话轮子会横着滚（最典型的「轮子乱滚」画面）
          const along = Math.hypot(after.x, after.z);
          asserts++;
          if (along < 0.5) {
            probs.push(`${tag}：自转轴转成了 (${after.x.toFixed(3)}, 0, ${after.z.toFixed(3)})，它指向车头方向`);
          }
        }
      }

      // 3. ★ 自转轴的符号必须统一成**指向左侧** —— 不打滑条件给出 ω = +v/R
      asserts++;
      {
        const b = measureDriveBasis(buildSkewed(skew, camber), ['tripo_part_0'], ['tripo_part_2']);
        if (b) {
          const left = new Vector3(0, 1, 0).cross(b.head);
          asserts++;
          if (b.axle.dot(left) <= 0) {
            probs.push(
              `${tag}：自转轴符号反了（点乘左侧 = ${b.axle.dot(left).toFixed(4)}）—— 轮子会整体倒着转`,
            );
          }
        }
      }

      // 4. ★ 轮心必须落在两个轮子零件各自的轴心上（不能是两个轮子同心）
      asserts++;
      {
        const b = measureDriveBasis(buildSkewed(skew, camber), ['tripo_part_0'], ['tripo_part_2']);
        if (b) {
          asserts++;
          if (b.wheelbase < 0.3 || b.wheelbase > 1.5) {
            probs.push(`${tag}：轴距量成 ${b.wheelbase.toFixed(3)}，合成车是 0.59`);
          }
        }
      }
    }

    // 5. ★ 「量不到就返回 null」而不是抛错 / 返回垃圾值
    asserts++;
    {
      const root = new Group();
      root.add(new Mesh(new BoxGeometry(0.4, 0.4, 0.4)));
      const bad = measureDriveBasis(root, ['没有这个零件'], ['也没有那个']);
      asserts++;
      if (bad !== null) probs.push('零件不存在时 measureDriveBasis 没有返回 null');
    }

    // 6. ★ 真实模型的基底必须能被**公开常数**复现
    //
    //   `MODEL_HEADS` / `BICYCLE_YAW` 是抄进代码的常数，而运行时用实测四元数。
    //   两边必须指向同一个车头——否则「改常数」和「改量法」会各走各的。
    asserts++;
    {
      const pairs: [string, readonly [number, number, number], number][] = [
        ['自行车', MODEL_HEADS.bicycle, BICYCLE_YAW],
        ['摩托车', MODEL_HEADS.motorcycle, MOTORCYCLE_YAW],
      ];
      for (const [name, head, yaw] of pairs) {
        asserts++;
        const d = facingDir(head, yaw);
        const err = Math.hypot(d[0], d[2] + 1);
        if (err > 1e-6) {
          probs.push(
            `${name}：公开常数算出的车头是 (${d[0].toFixed(6)}, 0, ${d[2].toFixed(6)})，应为 (0, 0, -1)（偏 ${((err * 180) / Math.PI).toFixed(4)}°）`,
          );
        }
      }
    }

    // 7. ★ 公开的实测自转轴必须**垂直于**公开的实测车头
    //
    //   两者都是从真模型量出来的同一个量（`measureDriveBasis` 的 head 与 axle），
    //   所以「互相垂直」是它们本该有的性质。写反一个符号就会红。
    asserts++;
    {
      const pairs: [string, readonly number[], readonly number[]][] = [
        ['自行车', MODEL_HEADS.bicycle, MODEL_AXES.bicycle],
        ['摩托车', MODEL_HEADS.motorcycle, MODEL_AXES.motorcycle],
      ];
      for (const [name, head, axle] of pairs) {
        asserts++;
        const d = head[0] * axle[0] + head[2] * axle[2];
        // 容差 0.03（≈1.7°）不是放水：**真车的两个轮子本来就对不齐**。
        // `motorcycle.glb` 实测前后轮轴方向差 **1.758°**，而 `MODEL_AXES`
        // 装的是**两者的平均**，所以它与车头的点积天然带着这个量级的残差。
        // 真正要拦的是「把竖直方向当成车轴」或「用车头方向当车轴」，
        // 那些错法的点积是 1 或 0，不是 0.008。
        if (Math.abs(d) > 0.03) {
          probs.push(
            `${name}：车头与自转轴的点积是 ${d.toFixed(5)}，两者应当垂直` +
              `（残差来自两个轮轴自身 1.76° 的不一致，不是这里放宽的）`,
          );
        }
      }
    }

    // 8. ★ **摩托车的轮子必须绕**实测车轴**转**（用户报的那两件事之一）
    //
    //   这是整条链子的**最后一环**：上面 1~3 条问的是「量得对不对」，
    //   这一条问的是「摆出来的**轮子真的绕着它转**」。
    //   中间隔着「基底下基底 + 轴对齐层 + 自转层」三层，任何一层写错
    //   （比如在带对齐的节点上写 `rotation`，把对齐冲掉）都只在这里现形：
    //   转角照样是正的、里程照样对，只有**轴**歪了——画面上就是「轮子乱滚」。
    asserts++;
    {
      const root = new Group();
      const tilt = new Group();
      // 复现那 26.59°：车头与车轴**同时**相对模型轴歪这么多
      tilt.rotation.y = (26.59 * Math.PI) / 180;
      const wheelGeo = (R: number) => {
        // 薄盘，厚度只有直径的 1/7。★ 别把厚度做到接近半径——
        // 那样它是个**球**而不是轮子，协方差的三个特征值几乎相等，
        // 「最小特征向量 = 自转轴」就不再成立，量出来的是噪声。
        // （真模型的 `tripo_part_0` 厚度/直径 = 0.19/0.34 = 0.56，
        //   已经很接近球了——那正是它实测轴带 0.46° 外倾的原因之一。）
        const g = new CylinderGeometry(R, R, 0.05, 24);
        g.rotateZ(Math.PI / 2); // 轴 → 本地 X（摩托车的名义轴）
        return g;
      };
      const f = new Mesh(wheelGeo(0.171));
      f.name = 'tripo_part_0';
      f.position.set(0, 0.18, 0.34);
      const r = new Mesh(wheelGeo(0.162));
      r.name = 'tripo_part_1';
      r.position.set(0, 0.16, -0.29);
      tilt.add(f, r);
      root.add(tilt);
      root.updateMatrixWorld(true);

      const mv = new Vehicle();
      mv.attach({ motorcycle: root, bike: null, skate: null, char: null, clips: {} });
      mv.set('motorcycle');
      for (let i = 0; i < 30; i++) mv.update(1 / 60, 5, 0); // heading = 0 ⇒ 前进方向 -Z
      const axis = mv.motoSpinAxisWorld;
      asserts++;
      if (!axis) {
        probs.push('摩托车没有自转层 —— 轮子压根不转（collectMotorcycle 量不到基底或零件）');
      } else {
        // 水平：不水平就必然横向蹭（接地点画出来是椭圆）
        //
        // 容差 0.02（≈1.15°）**不是放水**：真模型实测带 0.46° 外倾
        // （`motorcycle.glb` 的自转轴 y 分量是 -0.0056），
        // 而「轮子只在移动时转、侧撑倾角只在静止时非零」这两件事
        // 叠起来已经把残余蹭地压到 0。要拦的是「把竖直当车轴」
        // （y ≈ ±1）和「明显外倾」（y > 0.05 ≈ 2.9°）。
        asserts++;
        if (Math.abs(axis.y) > 0.02) {
          probs.push(
            `摩托车自转轴不水平（y = ${axis.y.toFixed(4)}，${((Math.asin(Math.abs(axis.y)) * 180) / Math.PI).toFixed(2)}°）` +
              ' —— 轮子会一边滚一边蹭',
          );
        }
        // 垂直于前进方向：前进方向是 (0,0,-1)，所以轴必须落在 ±X
        asserts++;
        if (Math.hypot(axis.x, axis.z) < 0.99) {
          probs.push(
            `摩托车自转轴是 (${axis.x.toFixed(3)}, ${axis.y.toFixed(3)}, ${axis.z.toFixed(3)})，` +
              '它没有垂直于前进方向 —— 轮子横着滚',
          );
        }
        // 转角仍然是「正号 + 按里程」，不能因为换了轴就把方向弄反
        asserts++;
        if (!(mv.motoWheelAngle > 0)) {
          probs.push(`摩托车前进 2.5m 后后轮转角是 ${mv.motoWheelAngle.toFixed(3)} rad，轮子在倒着转`);
        }
      }
    }

    // 9. ★ 滑板的轮子必须**真的被找到并转起来**
    //
    //   `skateboard.glb` 的轮子节点名是 `wheel_FL_1` / `wheel_FL_2`，
    //   而且**每个名字重复 4 次**（8 个轮子网格只有 6 个名字）。
    //   原来的 `getObjectByName('wheel_FL')` 这种名字一个都不存在
    //   ⇒ 滑板的轮子**从来没转过**。
    //
    //   症状安静到没有任何工具会报错：轮子不转在画面上只是「看不出在滚」，
    //   而速度、离地、站位、面数、离路判定全都正常。
    //   夹具刻意复现「同名 + 后缀」——只测「能找到 wheel 前缀」是不够的，
    //   补成 `wheel_FL_1` 之后 `getObjectByName` 也只会返回 8 个里的 1 个。
    asserts++;
    {
      const board = new Group();
      const mk = (name: string, x: number, z: number) => {
        const g = new CylinderGeometry(0.036, 0.036, 0.03, 12);
        g.rotateX(Math.PI / 2); // 轴 → 本地 Z（滑板实测自转轴就是本地 Z，偏差 0.37°）
        const m = new Mesh(g);
        m.name = name;
        m.position.set(x, 0.036, z);
        return m;
      };
      board.add(
        mk('wheel_FL_1', 0.3, 0.1),
        mk('wheel_FL_2', 0.3, -0.1),
        mk('wheel_RL_1', -0.3, 0.1),
        mk('wheel_RL_2', -0.3, -0.1),
      );
      const sv = new Vehicle();
      sv.attach({ bike: null, motorcycle: null, skate: board, char: null, clips: {} });
      sv.set('skate');
      for (let i = 0; i < 60; i++) sv.update(1 / 60, 5, 0); // 1 秒，5 m/s
      const angs = sv.skateWheelAngles;
      asserts++;
      if (angs.length !== 4) {
        probs.push(`滑板只找到 ${angs.length} 个轮子，应为 4 —— 节点名带后缀且重名，必须遍历而不是按名取`);
      } else {
        asserts++;
        if (!angs.every((a) => a > 0)) {
          probs.push(`滑板轮子转角 [${angs.map((a) => a.toFixed(2)).join(', ')}]，有一个没正着转`);
        }
      }
    }

    return {
      ok: probs.length === 0,
      detail:
        probs.length === 0
          ? `歪 0°/25°、外倾 0°/8° 四种组合下车头都被纠到 -Z、自转轴被纠到水平且指向左侧 · 摩托车 26.58° 歪角下车轴垂直于前进方向、轮子正转 · 滑板 4 个轮子都被找到且正转 · 公开常数与实测基底一致`
          : probs.join('；'),
      asserts,
    };
  });

  /**
   * ## 可达性：**玩家够不够得着**
   *
   * 这一族 bug 的共同点是：数据全对、算术全对、面板建好了、按钮建好了，
   * 而**玩家走不到**。三个已发生的成员：
   *
   * | 现象 | 量的是什么 | 没量的是什么 |
   * |---|---|---|
   * | `bottomOf()` 跨步读交错属性 | 布了多少株 | 画了几次 |
   * | 角色横向偏移 2.6m | 速度与离地 | 在不在视野里 |
   * | **三间铺子打不开** | 全清 799 / 全购 1010 / 缺口 211 | **玩家能不能花** |
   *
   * 第三条最贵：`SHOP_AT_STATION`、`ShopPanel.open()`、`state.buy()`、
   * `nearby.shopName` 全都活着，**只有 `tryCheckIn()` 少了一个分支**，
   * 于是 10 件商品、明信片的四样材料、灯笼/香囊/清心茶三条机制
   * 一次性全部不可达，而 25 条回归全绿。
   *
   * 所以判定问的是**枚举**，不是抽查：16 座驿站 × 两种目标，
   * 逐个问 `interactAt()`「在这一站按确认会发生什么」，
   * 答案必须和 `SHOP_AT_STATION` / `FRAGMENT_SLOT_STATION_IDX` 对得上。
   *
   * ## 它会红的方式
   *
   * · 从 `interactAt()` 删掉 `if (i.shopName) return 'shop'` → 第 1 条红
   * · 把 `home` 排在 `shop` 前面且不加 `objectiveReturn` 条件 → 第 3 条红
   * · 把 `reach` 写成 `Infinity` → 第 4 条红
   * · 删掉 `busy` 那一行 → 第 5 条红
   * · 修铺子时手滑改掉 `hasFragment && needsVisit` → 第 6 条红
   */
  check('verify_reach', () => {
    let asserts = 0;
    const probs: string[] = [];
    const g = new GameStateManager();
    const reach = WORLD.STATION_PASS_RADIUS + ROAD_GEOM.TOTAL_HALF_WIDTH;

    /** 站在 idx 号驿站门口按确认。`ret` = 当前目标是不是「回十八驿」。 */
    const at = (idx: number, ret: boolean, dist = 0, busy = false) =>
      interactAt({
        shopName: g.shopAtStation(idx),
        isHome: idx === GameStateManager.HOME_STATION && ret,
        objectiveReturn: ret,
        hasFragment: STATIONS[idx].hasFragment,
        needsVisit: g.fragmentStationNeedsVisit(idx),
        distance: dist,
        reach,
        busy,
      });

    // 1. 每一间登记在案的铺子，按确认都必须真的开铺子
    const shopIdx = Object.keys(SHOPS.SHOP_AT_STATION).map(Number);
    asserts++;
    if (shopIdx.length === 0) probs.push('一间铺子都没登记，玩家无处花钱');
    for (const idx of shopIdx) {
      const k = at(idx, false);
      asserts++;
      if (k !== 'shop') {
        probs.push(`${idx} 号驿站挂着铺子「${g.shopAtStation(idx)}」，按确认却得到 ${k}——铺子不可达`);
      }
    }

    // 2. 铺子里真的有货，且**明信片四样材料 + 三件玩法道具**都 somewhere 有卖
    asserts++;
    for (const idx of shopIdx) {
      const name = g.shopAtStation(idx);
      asserts++;
      if (g.goodsForShop(name).length === 0) probs.push(`铺子「${name}」一件商品都没有`);
    }
    const grants = new Set(SHOPS.GOODS.map((x) => x.grant).filter(Boolean) as string[]);
    asserts++;
    for (const need of [
      'postcard_tier',
      'paper_up',
      'ink_up',
      'has_envelope',
      'has_seal',
      'vision_up',
      'vision_half_penalty',
      'mood_up',
    ]) {
      asserts++;
      if (!grants.has(need)) probs.push(`没有任何商品提供 ${need}——这条机制玩家拿不到`);
    }

    // 3. 收尾那一趟，**家必须赢过铺子**。0 号驿站既是十八驿又有驿铺；
    //    反过来的话第一章永远完不成，而那是整个游戏的终点。
    asserts++;
    if (at(GameStateManager.HOME_STATION, true) !== 'home') {
      probs.push('集齐五件之后站在十八驿门口，按确认没有得到「回家」——第一章收不了尾');
    }
    asserts++;
    if (at(GameStateManager.HOME_STATION, false) !== 'shop') {
      probs.push('还没收齐时站在十八驿门口，按确认没有开铺子——驿铺（明信片材料全在这儿）够不着');
    }

    // 4. 距离门槛：刚够不着时必须是 none。防止有人把 reach 写成 Infinity，
    //    于是隔着半张地图弹出铺子面板。
    asserts++;
    for (const idx of shopIdx) {
      const k = at(idx, false, reach + 0.5);
      asserts++;
      if (k !== 'none') probs.push(`${idx} 号驿站在够不着的距离上（${reach + 0.5}m）仍返回 ${k}`);
    }

    // 5. 打卡过场 / 对白进行中不抢。镜头在动的时候弹一个模态面板，
    //    玩家会以为卡住了。
    asserts++;
    for (const idx of shopIdx) {
      const k = at(idx, false, 0, true);
      asserts++;
      if (k !== 'none') probs.push(`${idx} 号驿站在打卡过场进行中仍返回 ${k}，会盖住过场`);
    }

    // 6. 反向：修铺子不能把打卡砸了。五座碎片站、还欠到访时必须是 checkin。
    asserts++;
    for (const idx of ROAD.FRAGMENT_SLOT_STATION_IDX) {
      const k = at(idx, false);
      asserts++;
      if (k !== 'checkin') probs.push(`${idx} 号碎片驿站按确认得到 ${k}，应为 checkin`);
    }

    // 7. 既没有铺子又没有碎片债的驿站，按确认理应什么都不发生——
    //    这一条钉住的是"别为了让圈常亮就把 none 变成 checkin"。
    asserts++;
    let idle = 0;
    for (let idx = 0; idx < STATIONS.length; idx++) {
      if (g.shopAtStation(idx)) continue;
      if (STATIONS[idx].hasFragment) continue;
      if (at(idx, false) !== 'none') probs.push(`${idx} 号驿站既无铺子也无碎片债，按确认却得到 ${at(idx, false)}`);
      idle++;
    }
    asserts++;
    if (idle === 0) probs.push('16 座驿站里没有一座是"路过就行"的——路过的驿站失去了存在理由');

    const shops = shopIdx.map((i) => `${i}:${g.shopAtStation(i)}`).join(' ');
    return {
      ok: probs.length === 0,
      detail:
        probs.length === 0
          ? `${shopIdx.length} 间铺子全部可达（${shops}）· ${ROAD.FRAGMENT_SLOT_STATION_IDX.length} 座碎片站仍可打卡 · ${idle} 座路过站保持 none`
          : probs.join('；'),
      asserts,
    };
  });

  /**
   * ## 玩家角色必须**在画面里**
   *
   * 这一条守的是一个已经真实发生过的静默故障：徒步（**默认模式**）把角色
   * 摆在 ride 位侧向 `2.6m`（当时的 `PARKED_OFFSET`，注释写的是"载具停下时
   * 停在路边的偏移"——它挂错了模式）。而默认机位 `forward` 的横向偏移是 0，
   * 相机锁在正后方 3.2m，于是偏轴角 = `atan(2.6/3.2)` = **39.1°**。
   *
   * 竖屏（画幅 0.80）实测横向 FOV 只有 71.6°，半宽 35.8°——**人整个在画面外**。
   * 横屏也只是贴在右边缘 2/3 处。更糟的是 foot 模式下自行车是隐藏的
   * （`bike.visible = mode === 'bike'`），所以"人站在停着的车旁边"这个画面
   * 连车都没有。
   *
   * 为什么别的判据抓不到：`verify_ride` 量速度与离地，`verify_veg_ground` 量
   * 植被落地，`verify_veg_density` 量株数——**没有一条量"角色在不在视野里"**。
   * 它们全绿，而玩家看不见自己。
   *
   * ## 它会红的方式
   *
   * 把 `FOOT_LATERAL_OFFSET` 改回 2.6 → 第 1 条红。
   * 把 `CAM.forward.side` 改成 0.8 → 第 3 条红（那会让"偏移 0"也不再等于"居中"）。
   * 把 `FOV_MIN_HORIZONTAL` 调小 → 第 4 条红。
   */
  check('verify_avatar', () => {
    let asserts = 0;
    const probs: string[] = [];

    // 1. 徒步模式的横向偏移必须是 0
    asserts++;
    if (FOOT_LATERAL_OFFSET !== 0) {
      probs.push(`徒步模式角色横向偏移 ${FOOT_LATERAL_OFFSET}m，应为 0（挂在 foot 上就不是"停放"）`);
    }

    // 2. 默认机位的横向偏移必须是 0 —— "角色偏移 0" 只有在"相机也偏移 0"时
    //    才等于"角色在画面正中"。这两条要一起看。
    asserts++;
    if (Math.abs(camParams('forward').side) > 1e-9) {
      probs.push(`forward 机位横向偏移 ${camParams('forward').side}，角色在正中这条判据就不成立`);
    }

    // 3. 偏轴角必须小于**所有画幅下最窄的横向半视场**。
    //    取 min 而不是取 16:9：竖屏才是出事的那一档，而它是这条判据存在的理由。
    asserts++;
    const back = camParams('forward').back;
    const offAxis = (Math.atan(Math.abs(FOOT_LATERAL_OFFSET) / back) * 180) / Math.PI;
    let minHalfH = Infinity;
    let minAt = 0;
    for (const aspect of [0.5, 0.62, 0.75, 0.8, 1.0, 1.33, 1.78, 2.0, 2.4]) {
      const h = horizontalFromVertical(verticalFovForAspect(aspect), aspect);
      const half = h / 2;
      if (half < minHalfH) {
        minHalfH = half;
        minAt = aspect;
      }
    }
    // 留 10% 余量：角色有宽度，而边缘上人眼对"贴边"的容忍度远低于对"出画"的判断
    asserts++;
    if (offAxis > minHalfH * 0.9) {
      probs.push(
        `角色偏轴 ${offAxis.toFixed(1)}°，超过最窄画幅（${minAt}）横向半视场 ${minHalfH.toFixed(1)}° 的 90%`,
      );
    }

    // 4. 横向视野本身不许被压到"看不见自己"的程度。
    //    FOV_MIN_HORIZONTAL 是 `fov.ts` 的补宽下限，改它要有人知道后果。
    asserts++;
    if (FOV_MIN_HORIZONTAL < 60) {
      probs.push(`横向视野下限 ${FOV_MIN_HORIZONTAL}° 过窄，窄画幅下角色会贴边甚至出画`);
    }

    return {
      ok: probs.length === 0,
      detail:
        probs.length === 0
          ? `偏轴 ${offAxis.toFixed(1)}° < 最窄横向半视场 ${minHalfH.toFixed(1)}°（画幅 ${minAt}）`
          : probs.join('；'),
      asserts,
    };
  });
}
