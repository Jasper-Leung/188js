/**
 * 音频 —— 纯 WebAudio（AudioBuffer），三条总线，环境声分层，分站变奏。
 *
 * ## 为什么不用 HTMLAudioElement
 *
 * 原来这一层用的是 `new Audio()` + `createMediaElementSource`。换掉有两个原因，
 * 第二个是用户实际遇到的：
 *
 * 1. **循环接缝**。HTMLAudioElement 的循环在解码流上有一小段缝，麦克风一样的
 *    "咔"声在安静的环境声里听得见。原来的绕法是播两份错开半个周期，
 *    内存翻倍、逻辑绕，而 AudioBufferSourceNode 的 `loop=true` 本来就是无缝的。
 * 2. **下载管理器会抢**。媒体元素是一条浏览器认为"该由下载器接管"的通道 ——
 *    IDM 这类扩展的默认过滤规则里就含音频，于是装了 IDM 的机器上
 *    每条环境声都会弹一次下载框。`fetch` + `decodeAudioData` 走的是
 *    完全不同的通道，**不经过媒体元素**，那条路就断了。
 *
 * 顺带的好处：解码一次就常驻，播放时零解码；三个环境层的音量可以用
 * `setTargetAtTime` 平滑过渡，而 `<audio>.volume` 是一跳一跳的。
 *
 * ## 内存代价
 *
 * 解码后的 PCM 比压缩包大得多：2.2MB 的 ogg 大约摊到 20MB PCM。
 * 4GB 内存的机器上这是可以接受的，但它**不在首屏路径上**——
 * 预热在世界可交互之后才开始，而且是串行的。
 *
 * ## 自动播放策略
 *
 * AudioContext 必须在一次**用户手势**里创建或 resume，否则被浏览器挂起。
 * `unlock()` 由第一次点击/按键触发（标题页的「开始」就是那一下）。
 * 在此之前所有播放调用都是空操作，不报错。
 */
export type BusName = 'bgm' | 'sfx' | 'ambient';

const AUDIO_BASE = 'audio/';

/**
 * 拉取失败后的冷却。冷却期内同一 url 直接判负，**不再发请求**。
 *
 * 定 6 秒：短到"网络抖一下、环境声晚十几秒才回来"不至于被永久放弃，
 * 长到风暴期间（每帧一次）实际请求数被压到 6 秒一条。
 */
const FAIL_COOLDOWN_MS = 6000;

/** 一次性音效名白名单。`sfx()` 拿它挡掉不存在的名字。 */
const SFX_NAMES = [
  'collect', 'open', 'export', 'synthesis',
  'cloud_brush', 'tea_pour', 'bamboo_cut', 'bird_call',
  'zither_1', 'zither_2', 'zither_3', 'zither_4',
] as const;

interface Layer {
  buf: AudioBuffer;
  gain: GainNode;
  src: AudioBufferSourceNode | null;
  playing: boolean;
  target: number;
}

export class AudioSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buses: Record<BusName, GainNode> | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private layers = new Map<string, Layer>();
  /** 在途的 buffer 请求，见 {@link getBuffer} */
  private pending = new Map<string, Promise<AudioBuffer | null>>();
  /** 在途的建层请求，见 {@link getLayer} */
  private layerPending = new Map<string, Promise<Layer | null>>();
  /** 拉取失败的 url → 冷却到期的时间戳，见 {@link getBuffer} */
  private failed = new Map<string, number>();
  private unlocked = false;

  bgmMuted = false;
  sfxMuted = false;
  fullyMuted = false;
  /** 环境层数上限（画质档给的） */
  ambientLayers = 3;

  // ---- 分站变奏的节点链 ----
  private bgmFilter: BiquadFilterNode | null = null;
  private bgmTone: BiquadFilterNode | null = null;
  private bgmIn: GainNode | null = null;

  private prefetched = false;

  /** 首次用户手势时调一次 */
  async unlock(): Promise<void> {
    if (this.unlocked) return;
    try {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.fullyMuted ? 0 : 1;
      this.master.connect(this.ctx.destination);

      const mk = (v: number) => {
        const g = this.ctx!.createGain();
        g.gain.value = v;
        g.connect(this.master!);
        return g;
      };
      this.buses = { bgm: mk(0.55), sfx: mk(0.85), ambient: mk(0.6) };
      this.applyBuses();
      this.unlocked = true;
    } catch {
      // 没有音频设备 / 用户禁了：游戏照跑，只是不出声
      this.unlocked = false;
    }
  }

  get ready() {
    return this.unlocked && this.ctx !== null;
  }

  // ---------------------------------------------------------------- buffer
  /**
   * 取一个已解码的 buffer。**在途去重 + 失败冷却**是这个函数存在的全部意义。
   *
   * 它的调用方是每帧都跑的 {@link setAmbient}，而它原来是"解码成功才写缓存"：
   * 在途的请求不记账、失败的请求不记账。于是只要网络比一帧慢（线上 CDN、
   * 弱网、任何一个 30ms 以上的往返），下一帧就会再发一条**同 url** 的请求。
   * 60fps 下那是每秒 60 条、永不停歇，浏览器把连接与加载器耗尽后报
   * `ERR_INSUFFICIENT_RESOURCES`；同一源上的 `.glb` 被挤到队尾取不到，
   * 于是树、房子、摩托车一起消失。
   *
   * 所以这里发请求之前先问两件事：这条 url 有没有已经在飞、它是不是刚失败过。
   * 前者让 N 个并发调用共享一条请求，后者让风暴期间的实际请求数降到
   * {@link FAIL_COOLDOWN_MS} 一条。
   */
  private async getBuffer(url: string): Promise<AudioBuffer | null> {
    if (!this.ctx) return null;
    const hit = this.buffers.get(url);
    if (hit) return hit;
    const flying = this.pending.get(url);
    if (flying) return flying;
    const until = this.failed.get(url);
    if (until !== undefined && until > Date.now()) return null;

    const p = (async (): Promise<AudioBuffer | null> => {
      try {
        const res = await fetch(AUDIO_BASE + url);
        if (!res.ok) throw new Error(String(res.status));
        const buf = await this.ctx!.decodeAudioData(await res.arrayBuffer());
        this.buffers.set(url, buf);
        this.failed.delete(url);
        return buf;
      } catch {
        this.failed.set(url, Date.now() + FAIL_COOLDOWN_MS);
        return null;
      }
    })();
    this.pending.set(url, p);
    // 摘牌放在 set 之后：即使请求已经 settle，回调也是微任务，
    // 一定晚于上面那行 set，不会把刚登记的条目先删掉。
    void p.then(
      () => this.pending.delete(url),
      () => this.pending.delete(url),
    );
    return p;
  }

  /** 同 {@link getBuffer}：在途去重，否则每帧各建一个 GainNode 挂到总线上。 */
  private getLayer(key: string, bus: BusName, url: string): Promise<Layer | null> {
    const existing = this.layers.get(key);
    if (existing) return Promise.resolve(existing);
    const flying = this.layerPending.get(key);
    if (flying) return flying;
    if (!this.ready) return Promise.resolve(null);

    const p = (async (): Promise<Layer | null> => {
      const buf = await this.getBuffer(url);
      if (!buf || !this.ctx || !this.buses) return null;
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      // BGM 走滤波链（分站变奏），其余直连总线
      if (bus === 'bgm') gain.connect(this.getBgmIn());
      else gain.connect(this.buses[bus]);
      const layer: Layer = { buf, gain, src: null, playing: false, target: 0 };
      this.layers.set(key, layer);
      return layer;
    })();
    this.layerPending.set(key, p);
    void p.then(
      () => this.layerPending.delete(key),
      () => this.layerPending.delete(key),
    );
    return p;
  }

  private start(layer: Layer, offset = 0): void {
    if (layer.playing || !this.ctx) return;
    const src = this.ctx.createBufferSource();
    src.buffer = layer.buf;
    src.loop = true;
    src.connect(layer.gain);
    src.start(0, offset % layer.buf.duration);
    layer.src = src;
    layer.playing = true;
  }

  // ---------------------------------------------------------------- BGM
  /**
   * BGM 的入口节点。声音走 `源 → 入口 → 低通 → 高通 → BGM 总线`。
   *
   * 滤波插在**总线之前**是刻意的：插在之后的话，变奏会连着静音一起被绕过，
   * 而"关掉声音之后变奏还在响"是一个只在静音时才复现的 bug。
   */
  private getBgmIn(): GainNode {
    if (this.bgmIn) return this.bgmIn;
    const ctx = this.ctx!;
    this.bgmFilter = ctx.createBiquadFilter();
    this.bgmFilter.type = 'lowpass';
    this.bgmTone = ctx.createBiquadFilter();
    this.bgmTone.type = 'highpass';
    this.bgmFilter.connect(this.bgmTone);
    this.bgmTone.connect(this.buses!.bgm);
    this.bgmIn = ctx.createGain();
    this.bgmIn.connect(this.bgmFilter);
    return this.bgmIn;
  }

  async playBgm(name = 'bgm', volume = 0.5) {
    if (!this.ready) return;
    this.getBgmIn();
    const layer = await this.getLayer('bgm:' + name, 'bgm', name + '.ogg');
    if (!layer) return;
    layer.target = volume;
    this.start(layer);
    this.ramp(layer, volume);
  }

  /**
   * 分站音乐变奏。
   *
   * 原作把这个列为缺口：BGM 是一条循环，五座驿站听起来一样。
   * 这里用**滤波 + 微调速**做出五种"乐事"的色彩，不新增任何音频素材：
   *
   *   云 —— 亮、空气感（高通拉高，低频收掉）
   *   茶 —— 暖（低通压下来）
   *   琴 —— 收（低通最低，留出中央频段给琴音）
   *   竹 —— 脆（高频轻抬）
   *   禽 —— 最亮（高通最高）
   *
   * 刻意**只改音色不改旋律**：`playbackRate` 的偏移上限是 0.4%，
   * 再大就明显能听出"走调"，而那会让一首本该平静的曲子变得不安。
   * 变奏的作用是让"我到了哪座驿站"在听觉上也成立，不是换一首曲子。
   */
  setBgmMood(slot: number) {
    if (!this.ready) return;
    this.getBgmIn();
    const lp = this.bgmFilter;
    const hp = this.bgmTone;
    if (!lp || !hp) return;
    // 默认值是"不在驿站附近"：全开、不染色
    const M = [
      { lp: 12000, hp: 180, rate: 1.002 }, // 云
      { lp: 2400, hp: 40, rate: 0.999 }, // 茶
      { lp: 1600, hp: 60, rate: 1.0 }, // 琴
      { lp: 9000, hp: 120, rate: 1.003 }, // 竹
      { lp: 16000, hp: 320, rate: 1.004 }, // 禽
    ][slot] ?? { lp: 16000, hp: 30, rate: 1.0 };

    const now = this.ctx!.currentTime;
    lp.frequency.setTargetAtTime(M.lp, now, 0.9);
    hp.frequency.setTargetAtTime(M.hp, now, 0.9);
    const layer = this.layers.get('bgm:bgm');
    if (layer?.src) layer.src.playbackRate.value = M.rate;
  }

  // ---------------------------------------------------------------- 环境声
  /**
   * 更新环境声强度。
   * - `nearWater` 0..1：离最近一只水碗越近，水声越大
   * - `dusk` 0..1：黄昏时鸟声淡下去，风声起来
   * - `speed01`：车速带来的风
   */
  setAmbient(nearWater: number, dusk: number, speed01: number) {
    if (!this.ready) return;
    const L = this.ambientLayers;
    const wind = 0.25 + dusk * 0.3 + speed01 * 0.25;
    const water = nearWater * 0.75;
    const birds = Math.max(0, 0.55 - dusk * 0.6) * (1 - Math.min(speed01, 0.6));

    const targets: [string, number][] = [
      ['ambient:wind', L >= 1 ? wind : 0],
      ['ambient:water', L >= 2 ? water : 0],
      ['ambient:birds', L >= 3 ? birds : 0],
    ];
    for (const [key, v] of targets) {
      if (v <= 0.001) {
        this.fadeOut(key);
        continue;
      }
      void this.playLayer(key, 'ambient', key.split(':')[1] + '.ogg', v);
    }
  }

  private async playLayer(key: string, bus: BusName, url: string, volume: number) {
    const layer = await this.getLayer(key, bus, url);
    if (!layer) return;
    layer.target = volume;
    this.start(layer);
    this.ramp(layer, volume);
  }

  // ---------------------------------------------------------------- 音效
  sfx(name: string, volume = 0.9) {
    if (!this.ready) return;
    if (!(SFX_NAMES as readonly string[]).includes(name)) return;
    void this.playSfx(name, volume);
  }

  private async playSfx(name: string, volume: number) {
    if (!this.ready || !this.ctx) return;
    const url = `sfx/${name}.ogg`;
    const buf = await this.getBuffer(url);
    if (!buf) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = volume;
    src.connect(g);
    g.connect(this.buses!.sfx);
    src.start();
    // 播完自己摘掉。不摘的话，玩到第 15 局时节点数会累积到几百个，
    // 而每个都还挂在图上——这一条在低配上尤其明显。
    src.onended = () => {
      try {
        src.disconnect();
        g.disconnect();
      } catch {
        /* 已经断了 */
      }
    };
  }

  /** 琴音：0..3 */
  note(index: number) {
    this.sfx(`zither_${Math.min(Math.max(index, 0), 3) + 1}`, 0.75);
  }

  /** 小游戏期间压低环境声 */
  duckAmbient(on: boolean) {
    if (!this.ready || !this.buses) return;
    const g = this.buses.ambient.gain;
    const now = this.ctx!.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(on ? 0.12 : 0.6, now + 0.25);
  }

  // ---------------------------------------------------------------- 静音
  setBgmMuted(v: boolean) {
    this.bgmMuted = v;
    this.applyBuses();
  }
  setSfxMuted(v: boolean) {
    this.sfxMuted = v;
    this.applyBuses();
  }
  setFullyMuted(v: boolean) {
    this.fullyMuted = v;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(v ? 0 : 1, this.ctx.currentTime, 0.08);
    }
  }

  private applyBuses() {
    if (!this.ready || !this.buses) return;
    const now = this.ctx!.currentTime;
    this.buses.bgm.gain.setTargetAtTime(this.bgmMuted ? 0 : 0.55, now, 0.05);
    this.buses.sfx.gain.setTargetAtTime(this.sfxMuted ? 0 : 0.85, now, 0.05);
  }

  // ---------------------------------------------------------------- 工具
  private ramp(layer: Layer, value: number, tau = 0.6) {
    if (!this.ctx) return;
    layer.target = value;
    layer.gain.gain.setTargetAtTime(value, this.ctx.currentTime, tau);
  }

  private fadeOut(key: string) {
    const v = this.layers.get(key);
    if (!v || !this.ctx) return;
    v.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.4);
    if (v.playing) {
      v.playing = false;
      const src = v.src;
      setTimeout(() => {
        // 已经被重新拉起来了就别停
        if (!v.playing) {
          try {
            src?.stop();
            src?.disconnect();
          } catch {
            /* 已经停了 */
          }
          v.src = null;
        }
      }, 700);
    }
  }

  stopAll() {
    for (const key of [...this.layers.keys()]) this.fadeOut(key);
  }

  /**
   * 后台预热。**刻意不放在启动关键路径上**。
   *
   * 起因是一次实测：启动时把 17 个音频文件一起并发拉下来，
   * 其中 `bgm.ogg` 单独 1667KB、耗时 3.6 秒，而它和**关键路径**上的
   * `bike.glb`（299KB，却是玩家第一眼要看到的那个）抢同一条带宽。
   *
   * 更根本的原因是：浏览器不允许在用户手势之前出声，所以启动时把这些
   * 拉下来**一个字节都用不上**。现在改成世界可交互之后再**串行**预热，
   * 玩家正读操作说明的时候音乐在流，而首屏一个音频字节都不下。
   *
   * 串行而不是并行：并行会和地标模型的按需加载抢带宽，而地标是
   * 玩家看得见的东西，音频玩家看不见。
   */
  prefetchSfx(): void {
    if (this.prefetched) return;
    this.prefetched = true;
    const urls = [
      'sfx/collect.ogg', 'sfx/open.ogg', 'sfx/cloud_brush.ogg', 'sfx/tea_pour.ogg',
      'sfx/zither_1.ogg', 'sfx/zither_2.ogg', 'sfx/zither_3.ogg', 'sfx/zither_4.ogg',
      'sfx/bamboo_cut.ogg', 'sfx/bird_call.ogg', 'sfx/synthesis.ogg', 'sfx/export.ogg',
      'ambient/wind.ogg', 'ambient/water.ogg', 'ambient/birds.ogg',
    ];
    void this.serialPrefetch(urls, 0);
  }

  private async serialPrefetch(urls: string[], i: number): Promise<void> {
    if (i >= urls.length) return;
    const url = urls[i];
    try {
      if (!this.buffers.has(url)) {
        const res = await fetch(AUDIO_BASE + url, { cache: 'force-cache' });
        // 顺手解码掉：这样真正用到时是零延迟，而预热本来就要等这一条下载。
        // 解码完直接进缓存，`getBuffer` 后面就不会再 fetch 一次。
        if (res.ok && this.ctx) this.buffers.set(url, await this.ctx.decodeAudioData(await res.arrayBuffer()));
      }
    } catch {
      /* 拉不到就等真正要用时再拉 */
    }
    return this.serialPrefetch(urls, i + 1);
  }
}

export const audio = new AudioSystem();
