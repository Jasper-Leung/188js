/**
 * 音频系统的回归 —— 目前只覆盖**摩托车引擎**这一块。
 *
 * ## 为什么需要一个假 AudioContext
 *
 * 引擎这条特性的一切判据（频率映射、节点接线、熄火排程）都在
 * `AudioSystem` 的私有字段里，而 Node 没有 WebAudio。桩的思路与
 * `ensureStubDom()` 同源：**只实现被调到的那几个方法，把每一次调用记下来**，
 * 然后对记录断言。这样"转速映射写错成线性"这种 bug 在 Node 里就是红的。
 *
 * ## 为什么 `unlock()` 不用 await
 *
 * 判据函数是同步的（`CheckFn` 的形状决定的）。而 `unlock()` 整个函数体
 * 只在 `ctx.state === 'suspended'` 时 await 一次——桩报 `'running'`，
 * 于是函数体在 `unlock()` 返回前就**同步跑完**，副作用全部到位。
 * 这不是巧合，是刻意维持的形状：判据因此能同步断言，而生产代码不用改。
 *
 * ## 为什么断言读参数对象，不解析日志文本
 *
 * 第一版这里是从日志里用正则捞 `osc.frequency.setTargetAtTime(...)` 的。
 * 它错了，而且错得很安静：**两个振荡器共用一个 tag，两个增益也共用一个**，
 * 而 `setEngine` 里后写的永远是方波与噪声增益——于是"基频映射"量到的
 * 是方波的半频，"引擎音量"量到的是不随油门变的路噪增益。两条断言
 * 都在跟错的节点对话，还都看着像那么回事。
 *
 * 所以参数自己记 `targets`（每一次 setTargetAtTime 的值），判据按
 * `engine.osc1.frequency.last` 这样**直接引用节点**。日志仍然留着——
 * 熄火排程那一族要靠它数 `stop()` 的次数与时刻，那是文本最好用的地方。
 */
import { expect, type CheckFn } from './harness';
import {
  AudioSystem,
  ENGINE_HZ_MAX,
  ENGINE_HZ_MIN,
  ENGINE_IDLE_RPM,
  ENGINE_TEARDOWN_S,
} from '../core/audio';

/** 假 AudioParam：`targets` 是每一次 `setTargetAtTime` 的值，按时序躺着。 */
function fakeParam(log: string[], tag: string) {
  const targets: number[] = [];
  return {
    targets,
    value: 0,
    setTargetAtTime(v: number, t: number, tau: number) {
      targets.push(v);
      this.value = v;
      log.push(`${tag}.setTargetAtTime(${v.toFixed(3)} @ ${t.toFixed(3)}, tau=${tau.toFixed(3)})`);
    },
    setValueAtTime(v: number, t: number) {
      this.value = v;
      log.push(`${tag}.setValueAtTime(${v.toFixed(3)} @ ${t.toFixed(3)})`);
    },
    cancelScheduledValues() {},
    linearRampToValueAtTime(v: number, t: number) {
      this.value = v;
      log.push(`${tag}.linearRamp(${v.toFixed(3)} @ ${t.toFixed(3)})`);
    },
  };
}

/** 某个参数最后一次 `setTargetAtTime` 的目标值。没写过就是 NaN。 */
function lastOf(p: { targets: number[] }): number {
  return p.targets.length ? p.targets[p.targets.length - 1] : NaN;
}

/** 假 AudioContext。`currentTime` 固定，熄火排程才能断言到毫秒。 */
class FakeAudioContext {
  state = 'running';
  currentTime = 1.5;
  sampleRate = 48000;
  destination = { __kind: 'destination' };
  /** 建过的节点按顺序躺着，`__kind` 是它的类型。 */
  created: { __kind: string; [k: string]: unknown }[] = [];
  /** 每一次方法调用（connect / start / stop）的文字记录。 */
  log: string[] = [];

  private track<T extends { __kind: string }>(n: T): T {
    this.created.push(n as unknown as { __kind: string });
    return n;
  }

  async resume() {}

  createGain() {
    const ctx = this;
    const node = {
      __kind: 'gain',
      gain: fakeParam(ctx.log, 'gain'),
      connect(target: unknown) {
        ctx.log.push(`gain.connect(${(target as { __kind?: string }).__kind ?? '?'})`);
      },
      disconnect() {},
    };
    return this.track(node);
  }

  createBiquadFilter() {
    const ctx = this;
    const node = {
      __kind: 'biquad',
      type: '',
      Q: fakeParam(ctx.log, 'Q'),
      frequency: fakeParam(ctx.log, 'filter.frequency'),
      connect(target: unknown) {
        ctx.log.push(`biquad.connect(${(target as { __kind?: string }).__kind ?? '?'})`);
      },
      disconnect() {},
    };
    return this.track(node);
  }

  createOscillator() {
    const ctx = this;
    const node = {
      __kind: 'osc',
      type: '',
      frequency: fakeParam(ctx.log, 'osc.frequency'),
      detune: fakeParam(ctx.log, 'osc.detune'),
      connect(target: unknown) {
        ctx.log.push(`osc.connect(${(target as { __kind?: string }).__kind ?? '?'})`);
      },
      disconnect() {},
      start() {
        ctx.log.push(`osc.start(${node.type || '?'})`);
      },
      stop(at?: number) {
        ctx.log.push(`osc.stop(${node.type || '?'} @ ${at?.toFixed(3) ?? 'now'})`);
      },
    };
    return this.track(node);
  }

  createBufferSource() {
    const ctx = this;
    const node = {
      __kind: 'src',
      buffer: null as unknown,
      loop: false,
      playbackRate: fakeParam(ctx.log, 'src.playbackRate'),
      connect(target: unknown) {
        ctx.log.push(`src.connect(${(target as { __kind?: string }).__kind ?? '?'})`);
      },
      disconnect() {},
      start() {
        ctx.log.push('src.start()');
      },
      stop(at?: number) {
        ctx.log.push(`src.stop(@ ${at?.toFixed(3) ?? 'now'})`);
      },
      onended: null as (() => void) | null,
    };
    return this.track(node);
  }

  createBuffer(channels: number, length: number, rate: number) {
    return {
      numberOfChannels: channels,
      length,
      sampleRate: rate,
      duration: length / rate,
      getChannelData: () => new Float32Array(length),
    };
  }
}

/** 引擎链上被回归摸到的那几个面。
 *
 *  `AudioSystem.engine` 是私有的，类型写的是真 WebAudio 的节点——无头环境里
 *  躺着的是上面的假货。所以按**结构**取，不按类型取：这里列名的就是判据
 *  真正依赖的面，哪天 `EngineNodes` 改一个字段名，这一处会先红。 */
interface FakeEngine {
  osc1: { frequency: { targets: number[] } };
  osc2: { frequency: { targets: number[] } };
  lp: { frequency: { targets: number[] } };
  band: { frequency: { targets: number[] } };
  gain: { gain: { targets: number[] } };
  noiseGain: { gain: { targets: number[] } };
}

/** 从系统里把引擎链掏出来（私有字段，按结构读）。 */
function engineOf(sys: AudioSystem): FakeEngine | null {
  return (sys as unknown as { engine: FakeEngine | null }).engine;
}

export function registerAudioChecks(
  check: CheckFn,
  getWindow: () => { AudioContext?: unknown } | null,
): void {
  check('verify_engine_audio', () => {
    let asserts = 0;
    const probs: string[] = [];
    const win = getWindow();
    if (!win) {
      return expect(false, '拿不到 window 桩：entry.ts 的注册处没把窗口递进来', 1);
    }

    // ---------------------------------------------------------- 没解锁时是空操作
    // 浏览器不允许手势前出声，所以 unlock() 之前的一切调用必须安静地什么都不做。
    // 这条红了的症状是标题屏上一堆节点在建——而玩家还没点「开始」。
    {
      const sys = new AudioSystem();
      asserts++;
      try {
        sys.setEngine(true, 0.8, 1);
        sys.setEngine(false, 0, 0);
        sys.stopAll();
      } catch (e) {
        probs.push(`未解锁时调引擎接口抛了异常：${String(e)}`);
      }
      asserts++;
      if (sys.engineOn) probs.push('未解锁就把引擎建起来了');
      asserts++;
      if (sys.ready) probs.push('未解锁却报 ready');
    }

    // ---------------------------------------------------------- 装桩 + 解锁
    const prev = win.AudioContext;
    win.AudioContext = FakeAudioContext as unknown as typeof AudioContext;
    const sys = new AudioSystem();
    let ctx: FakeAudioContext | null = null;
    try {
      // 不 await：桩报 running，函数体同步跑完（见文件头）。
      void sys.unlock();
      asserts++;
      if (!sys.ready) {
        probs.push('unlock() 之后没有 ready');
      }
      // `ctx` 是私有的，回归从日志侧验证它真的被建起来了：
      // 三条总线的 setTargetAtTime 就是证据（applyBuses 在 unlock 里跑）。
      const g = sys as unknown as { ctx: FakeAudioContext | null };
      ctx = g.ctx;
      asserts++;
      if (!ctx) probs.push('unlock() 没有建出 AudioContext');
      if (ctx) {
        asserts++;
        const gains = ctx.created.filter((n) => n.__kind === 'gain').length;
        if (gains < 4) probs.push(`总线增益只有 ${gains} 个，应为 4（master + 三条总线）`);
      }

      // ---------------------------------------------------------- 频率映射
      // 指数映射的三个锚点。写成线性是这条音效最容易被"顺手简化"的一处，
      // 而线性映射在低转区间完全糊掉——40→80Hz 听不出任何差别。
      // 每个振荡器各读各的参数：共用一个日志 tag 的时代（见文件头）过去了。
      {
        sys.setEngine(true, 0, 0);
        const e = engineOf(sys);
        asserts++;
        if (!e) probs.push('点火没能建出引擎链');
        if (e) {
          asserts++;
          const idle = lastOf(e.osc1.frequency);
          if (Math.abs(idle - ENGINE_HZ_MIN) > 0.01) {
            probs.push(`怠速基频 ${idle}，应为 ${ENGINE_HZ_MIN}`);
          }
          sys.setEngine(true, 0.5, 0);
          asserts++;
          const mid = ENGINE_HZ_MIN * Math.pow(ENGINE_HZ_MAX / ENGINE_HZ_MIN, 0.5);
          const half = lastOf(e.osc1.frequency);
          if (Math.abs(half - mid) > 0.01) {
            probs.push(`半转基频 ${half}，应为 ${mid.toFixed(2)}`);
          }
          sys.setEngine(true, 1, 0);
          asserts++;
          const top = lastOf(e.osc1.frequency);
          if (Math.abs(top - ENGINE_HZ_MAX) > 0.01) {
            probs.push(`断油基频 ${top}，应为 ${ENGINE_HZ_MAX}`);
          }
          // 方波是低八度：它服务低频的"肉感"，同频就只是把锯齿改厚。
          // 它自己有一个频率参数，所以直接读它——不用从一堆共享记录里筛。
          asserts++;
          const sq = lastOf(e.osc2.frequency);
          if (Math.abs(sq - ENGINE_HZ_MAX / 2) > 0.01) {
            probs.push(`方波没有走低八度（${sq}，应为 ${ENGINE_HZ_MAX / 2}）`);
          }
        }
      }

      // ---------------------------------------------------------- 油门 → 亮度与音量
      // 拧油门必须让低通张开、引擎增益变大、路噪的带通往上走。三条一起断的
      // 症状是"引擎声是个静止的嗡"，而那种东西玩家只会当成背景空调。
      // 注意路噪的**增益**只跟转速走（设计如此：怠速时那声"沙"是脏的），
      // 所以油门这一族断的是带通频率，不是噪声增益。
      {
        const e = engineOf(sys);
        asserts++;
        if (!e) probs.push('引擎链不见了');
        if (e) {
          sys.setEngine(true, 0.5, 0);
          const idleLp = lastOf(e.lp.frequency);
          const idleVol = lastOf(e.gain.gain);
          const idleBand = lastOf(e.band.frequency);
          sys.setEngine(true, 0.5, 1);
          const loadLp = lastOf(e.lp.frequency);
          const loadVol = lastOf(e.gain.gain);
          const loadBand = lastOf(e.band.frequency);
          asserts++;
          if (!(loadLp > idleLp + 100)) {
            probs.push(`满油门没有把低通掀开（${idleLp} → ${loadLp}）`);
          }
          asserts++;
          if (!(loadVol > idleVol)) {
            probs.push(`满油门没有加大引擎音量（${idleVol} → ${loadVol}）`);
          }
          asserts++;
          if (!(loadBand > idleBand + 100)) {
            probs.push(`满油门没有抬路噪频带（${idleBand} → ${loadBand}）`);
          }
          // 噪声增益反过来只认转速：同转速下两次油门它必须一动不动。
          // 这条锁的是"怠速时不混那声沙"的设计，不是巧合。
          sys.setEngine(true, 0.5, 0);
          const noiseA = lastOf(e.noiseGain.gain);
          sys.setEngine(true, 0.5, 1);
          const noiseB = lastOf(e.noiseGain.gain);
          asserts++;
          if (noiseA !== noiseB) {
            probs.push(`路噪增益跟着油门跑了（${noiseA} → ${noiseB}），它只该跟转速走`);
          }
          // 而转速推上去时它必须真的起来。
          sys.setEngine(true, 0, 0);
          const noiseIdle = lastOf(e.noiseGain.gain);
          sys.setEngine(true, 1, 0);
          const noiseTop = lastOf(e.noiseGain.gain);
          asserts++;
          if (!(noiseTop > noiseIdle + 0.05)) {
            probs.push(`转速推满路噪没起来（${noiseIdle} → ${noiseTop}）`);
          }
        }
      }

      // ---------------------------------------------------------- 重复点火不重建
      // 每帧都调 setEngine(true)，重建节点链的后果是几分钟后几百个振荡器
      // 挂在图上——那种泄漏在画面与帧率上都看不出来，只在音频线程上现形。
      if (ctx) {
        const oscBefore = ctx.created.filter((n) => n.__kind === 'osc').length;
        for (let i = 0; i < 30; i++) sys.setEngine(true, 0.4, 0.2);
        asserts++;
        const oscAfter = ctx.created.filter((n) => n.__kind === 'osc').length;
        if (oscAfter !== oscBefore) probs.push(`30 次点火多建了 ${oscAfter - oscBefore} 个振荡器`);
      }

      // ---------------------------------------------------------- 熄火
      // 淡出 + 排进 WebAudio 时间轴的停止。用 setTimeout 的话这条判据
      // 得等 520ms，而排进时间轴之后它是同步可断言的。
      {
        // 先把引擎增益的引用攥在手里：teardown 会把 `engine` 摘成 null，
        // 事后再想量那个增益就只能去日志里跟噪声增益抢同一个 tag。
        const eg = engineOf(sys);
        asserts++;
        if (!eg) probs.push('熄火前引擎链不见了');
        if (ctx) ctx.log.length = 0;
        sys.setEngine(false, 0, 0);
        asserts++;
        if (sys.engineOn) probs.push('熄火后 engineOn 仍为真');
        const stops = (ctx?.log ?? []).filter((l) => l.startsWith('osc.stop') || l.startsWith('src.stop'));
        asserts++;
        if (stops.length !== 4) probs.push(`熄火只排了 ${stops.length} 个停止，应为 4（两振一 LFO 一噪声）`);
        for (const s of stops) {
          asserts++;
          if (!s.includes(`@ ${(1.5 + ENGINE_TEARDOWN_S).toFixed(3)}`)) {
            probs.push(`停止时刻没有排在 currentTime+${ENGINE_TEARDOWN_S}s：${s}`);
          }
        }
        asserts++;
        if (eg) {
          const vol = lastOf(eg.gain.gain);
          if (vol !== 0) probs.push(`熄火没有把引擎增益淡到 0（停在 ${vol}）`);
        }
      }

      // ---------------------------------------------------------- stopAll 一并熄火
      {
        sys.setEngine(true, 0.6, 0.5);
        asserts++;
        if (!sys.engineOn) probs.push('重新点火失败');
        sys.stopAll();
        asserts++;
        if (sys.engineOn) probs.push('stopAll() 之后引擎还在烧');
      }

      // ---------------------------------------------------------- 怠速常量被用上
      // main.ts 靠它把"站着不动"烧成怠速而不是熄火。常量掉了没人会报错，
      // 症状只是停车时引擎静下来——而那不是摩托车。
      asserts++;
      if (!(ENGINE_IDLE_RPM > 0 && ENGINE_IDLE_RPM < 0.3)) {
        probs.push(`怠速转速 ${ENGINE_IDLE_RPM} 不在 (0, 0.3) 里`);
      }
    } finally {
      win.AudioContext = prev;
    }

    return expect(probs.length === 0, probs.length ? probs.join('；') : `映射 ${ENGINE_HZ_MIN}→${ENGINE_HZ_MAX}Hz 指数`, asserts);
  });
}
