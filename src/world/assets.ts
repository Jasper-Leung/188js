/**
 * GLB 加载 —— 渐进式、可中断、按距离加载。
 *
 * 低配玩家往往也是慢网络玩家，所以加载策略和画质档一样重要：
 *
 * · **地标按距离加载**。16 座驿站的 GLB 一共 4.4MB，一次全加载等于
 *   在 3G 上先卡十秒。它们按 `stationLoadDistance` 分批进场，
 *   玩家在 300m 外时只加载他看得见的那几座。
 *
 * · **贴图不进内存直到要用**。GLB 里的 JPEG 走 Blob URL，
 *   解码由 three 的 TextureLoader 交给浏览器，进度可感知。
 *
 * · **同一模型共享 geometry**。树有 3 个实例来源但只下载一次。
 *
 * · **Meshopt 解码器按需装**。`MeshoptDecoder` 是个 20KB 的 wasm，
 *   比 Draco 的 250KB 小一个量级，首次解码也没有卡顿——
 *   低配机上"解码卡一下"的代价比多 2MB 流量更难受。
 */
import {
  type Object3D,
  Material,
  MeshStandardMaterial,
  Box3,
  Vector3,
  Group,
  type Mesh,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

let meshoptReady: Promise<boolean> | null = null;

export function ensureMeshopt(): Promise<boolean> {
  if (!meshoptReady) meshoptReady = MeshoptDecoder.ready.then(() => true);
  return meshoptReady;
}

const MODEL_BASE = 'models/';

export interface LoadedModel {
  root: Group;
  /** 模型自身的包围盒（未缩放），用来算落地高度与 keepout */
  box: Box3;
  meshes: Mesh[];
}

const loader = new GLTFLoader();
const cache = new Map<string, Promise<LoadedModel | null>>();
const inflight = new Set<Promise<unknown>>();

/** 源项目里 `res://assets/models/xxx.glb` → web 上的相对路径 */
export function modelUrl(godotPath: string): string {
  const name = godotPath.split('/').pop() ?? godotPath;
  return `${MODEL_BASE}${encodeURIComponent(name)}`;
}

async function loadInternal(url: string): Promise<LoadedModel | null> {
  await ensureMeshopt();
  loader.setMeshoptDecoder(MeshoptDecoder);
  return new Promise<LoadedModel | null>((resolve) => {
    loader.load(
      url,
      (gltf: GLTF) => {
        const root = new Group();
        root.name = url;
        const meshes: Mesh[] = [];
        gltf.scene.traverse((o: Object3D) => {
          if ((o as Mesh).isMesh) {
            const m = o as Mesh;
            // 低配：所有贴图不各向异性、各向异性 1 由 renderer 统一设
            const mats = Array.isArray(m.material) ? m.material : [m.material];
            for (const mat of mats) {
              const sm = mat as MeshStandardMaterial;
              if (sm && sm.map) {
                sm.map.colorSpace = 'srgb';
                sm.map.generateMipmaps = true;
                sm.map.minFilter = 1008; // LinearMipmapLinearFilter
                sm.map.magFilter = 1006; // LinearFilter
                sm.map.anisotropy = 1;
              }
              if (sm) sm.envMapIntensity = 0.6;
            }
            m.castShadow = true;
            m.receiveShadow = true;
            meshes.push(m);
          }
        });
        root.add(gltf.scene);
        // 算包围盒时用身份变换：缩放/旋转由调用方施加在 Group 上，
        // 在这里算会把包围盒算进一个之后又被 groupScale 二次放大的世界。
        gltf.scene.updateMatrixWorld(true);
        const box = new Box3().setFromObject(root);
        resolve({ root, box, meshes });
      },
      undefined,
      () => resolve(null),
    );
  });
}

export function loadModel(url: string): Promise<LoadedModel | null> {
  const existing = cache.get(url);
  if (existing) return existing;
  const p = loadInternal(url);
  cache.set(url, p);
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
  return p;
}

/** 还有几个模型在飞。进度条用它。 */
export function pendingCount(): number {
  return inflight.size;
}

export function loadedCount(): number {
  return cache.size;
}

/**
 * 递归遍历，把 Group 下所有 Mesh 的某种材质参数改掉。
 * 驿站要在运行时染色（RoofTint），走这里。
 */
export function tintModel(root: Object3D, match: (mat: Material) => boolean, apply: (mat: MeshStandardMaterial) => void) {
  root.traverse((o: Object3D) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) {
      if (match(mat)) apply(mat as MeshStandardMaterial);
    }
  });
}

const _v = new Vector3();

/** 把一个模型按给定的缩放与朝向摆到世界坐标上，底面贴地。 */
export function placeModel(
  root: Object3D,
  box: Box3,
  x: number,
  groundY: number,
  z: number,
  scale: number,
  rotYDeg: number,
  yOffset = 0,
): void {
  root.position.set(x, 0, z);
  root.rotation.y = (rotYDeg * Math.PI) / 180;
  root.scale.setScalar(scale);
  root.updateMatrix();
  root.updateMatrixWorld(true);
  // Blender 导出的模型原点在底面中心，但保险起见用包围盒校正一次
  box.copy(box);
  box.getSize(_v);
  const minY = box.min.y;
  root.position.y = groundY - minY * scale + yOffset;
  root.updateMatrixWorld(true);
}
