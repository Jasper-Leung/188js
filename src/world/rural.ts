import { Group, InstancedMesh, BoxGeometry, PlaneGeometry, MeshStandardMaterial, MeshBasicMaterial, Object3D, DoubleSide, DataTexture, RGBAFormat, LinearFilter, AdditiveBlending, Vector3 } from 'three';
import { pointAtArcLength, TOTAL_ARCLENGTH, STATIONS, distToCenterline } from '../data/route';
import { WORLD_EXPERIENCE } from '../data/worldExperience';
import { getBasins, WATER_LEVEL } from './basins';
import type { Terrain } from './terrain';
import type { QualityPreset } from '../core/settings';
export interface RuralPlacement { x: number; z: number; yaw: number; kind: 'lamp' | 'post' | 'crop' }
const C = WORLD_EXPERIENCE.rural;
/** 只用种子和样条派生位置；过滤另一条路、站点和湖面，不改变道路碰撞。 */
export function ruralPlan(seed: number = C.seed): RuralPlacement[] {
  const out: RuralPlacement[] = [];
  let rng = seed >>> 0;
  const random = () => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng / 4294967296; };
  const allowed = (x: number, z: number, margin: number) => distToCenterline(x, z) > margin && !STATIONS.some(s => Math.hypot(x-s.x,z-s.z) < C.keepout) && !getBasins().some(b => Math.hypot(x-b.cx,z-b.cz) < b.radius + 8);
  for (let arc = 0, i = 0; arc < TOTAL_ARCLENGTH; i++) {
    const p = pointAtArcLength(arc).pos;
    const q = pointAtArcLength(arc + 2).pos;
    const yaw = Math.atan2(q.x-p.x,q.z-p.z);
    const side = i % 2 ? -1 : 1;
    const place = (offset: number, kind: RuralPlacement['kind']) => {
      const x = p.x + Math.cos(yaw)*offset, z = p.z-Math.sin(yaw)*offset;
      if (allowed(x,z,kind === 'crop' ? 18 : 7.4)) out.push({x,z,yaw,kind});
    };
    place(side*C.lampOffset,'lamp');
    const village = STATIONS.some(s => Math.hypot(p.x-s.x,p.z-s.z) < 45);
    arc += village ? C.villageSpacing : C.lampSpacing;
  }
  for (let arc=0; arc<TOTAL_ARCLENGTH; arc+=C.postSpacing) {
    const p=pointAtArcLength(arc).pos,q=pointAtArcLength(arc+2).pos;
    const yaw=Math.atan2(q.x-p.x,q.z-p.z);
    for (const side of [-1,1]) {
      const x=p.x+Math.cos(yaw)*7.6*side,z=p.z-Math.sin(yaw)*7.6*side;
      if(allowed(x,z,7.4)) out.push({x,z,yaw,kind:'post'});
    }
  }
  for(let arc=0;arc<TOTAL_ARCLENGTH;arc+=C.fieldSpacing){
    const p=pointAtArcLength(arc).pos,q=pointAtArcLength(arc+2).pos;
    const yaw=Math.atan2(q.x-p.x,q.z-p.z),side=random()<.5?-1:1;
    for(let r=0;r<3;r++)for(let c=-2;c<=2;c++){
      const offset=side*(C.fieldOffset+r*3);
      const x=p.x+Math.cos(yaw)*offset+Math.sin(yaw)*c*2,z=p.z-Math.sin(yaw)*offset+Math.cos(yaw)*c*2;
      if(allowed(x,z,18))out.push({x,z,yaw,kind:'crop'});
    }
  }
  return out;
}
/** Compact radial texture with zero alpha and zero slope at its entire boundary. */
export function lampHaloTexture(size = 64): DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = Math.hypot((x / (size - 1) - .5) * 2, (y / (size - 1) - .5) * 2);
    const taper = Math.max(0, 1 - r * r);
    const i = (y * size + x) * 4;
    data[i] = data[i+1] = data[i+2] = 255;
    data[i+3] = Math.round(255 * Math.exp(-3 * r * r) * taper * taper);
  }
  const texture = new DataTexture(data, size, size, RGBAFormat);
  texture.magFilter = texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
export class Rural {
  readonly group = new Group();
  readonly placements = ruralPlan();
  private glow = new MeshBasicMaterial({color:0xffd28a,transparent:true,opacity:0,depthWrite:false});
  private haloMap = lampHaloTexture();
  private pool = new MeshBasicMaterial({map:this.haloMap,color:0xffd6a0,transparent:true,opacity:0,depthWrite:false,side:DoubleSide,blending:AdditiveBlending,toneMapped:false});
  private halo = new MeshBasicMaterial({map:this.haloMap,color:0xffdfa8,transparent:true,opacity:0,depthWrite:false,side:DoubleSide,blending:AdditiveBlending,toneMapped:false});
  private windows = new MeshBasicMaterial({color:0xffd89b});
  private lit: InstancedMesh[] = [];
  private radius = 100;
  constructor(terrain: Terrain, preset: QualityPreset) {
    this.group.name='rural-road'; this.setPreset(preset);
    const lamps=this.placements.filter(p=>p.kind==='lamp'), posts=this.placements.filter(p=>p.kind==='post'), crops=this.placements.filter(p=>p.kind==='crop');
    const metal=new MeshStandardMaterial({color:0x526057,roughness:1}), white=new MeshStandardMaterial({color:0xd8d2bf,roughness:1}), green=new MeshStandardMaterial({color:0x69794a,roughness:1});
    const make=(geo: BoxGeometry | PlaneGeometry,mat:MeshStandardMaterial|MeshBasicMaterial, list:readonly RuralPlacement[],offset:number,tilt=false)=>{
      const mesh=new InstancedMesh(geo,mat,list.length),o=new Object3D();
      list.forEach((p,i)=>{o.position.set(p.x,Math.max(terrain.getHeightAt(p.x,p.z),WATER_LEVEL+.2)+offset,p.z);o.rotation.set(0,p.yaw,0);
        if (tilt) {
          const normal = new Vector3(terrain.getHeightAt(p.x-.5,p.z)-terrain.getHeightAt(p.x+.5,p.z),1,terrain.getHeightAt(p.x,p.z-.5)-terrain.getHeightAt(p.x,p.z+.5)).normalize();
          o.quaternion.setFromUnitVectors(new Vector3(0,0,1),normal);
        }
        o.updateMatrix();mesh.setMatrixAt(i,o.matrix);});
      mesh.userData.placements=list; mesh.instanceMatrix.needsUpdate=true; mesh.computeBoundingSphere(); this.group.add(mesh);return mesh;
    };
    make(new BoxGeometry(.12,C.lampHeight,.12),metal,lamps,C.lampHeight/2);
    make(new BoxGeometry(1.5,.12,.18),metal,lamps,C.lampHeight);
    this.lit.push(make(new BoxGeometry(1,.08,.3),this.glow,lamps,C.lampHeight-.1));
    this.lit.push(make(new PlaneGeometry(C.lightRadius*2,C.lightRadius*2),this.pool,lamps,.1,true));
    this.lit.push(make(new PlaneGeometry(2.2,2.2),this.halo,lamps,C.lampHeight-.1));
    this.lit.push(make(new PlaneGeometry(2.2,2.2),this.halo,lamps.map(p=>({...p,yaw:p.yaw+Math.PI/2})),C.lampHeight-.1));
    make(new BoxGeometry(.18,.9,.18),white,posts,.45);
    make(new BoxGeometry(.21,.15,.21),this.windows,posts,.7);
    make(new BoxGeometry(.28,.35,1.5),green,crops,.17);
    const doorLights=STATIONS.map(s=>({x:s.x,z:s.z,yaw:0,kind:'lamp' as const}));
    this.lit.push(make(new BoxGeometry(.55,.5,.55),this.glow,doorLights,3));
  }
  setPreset(p: QualityPreset):void { this.radius = p.shadowMapSize === 0 ? C.viewDistance[0] : p.shadowMapSize <= 1024 ? C.viewDistance[1] : C.viewDistance[2]; }
  update(night:number,x:number,z:number):void {
    this.glow.opacity=night*.95;this.pool.opacity=night*C.poolOpacity;this.halo.opacity=night*C.haloOpacity;
    this.windows.color.setHex(night>.5?0xf1d5a0:0xe2d8c3);
    for(const mesh of this.lit) mesh.visible=night>.01;
    // 少量实例共用材料；按每种设施整体包围范围剔除，不增加实时灯或阴影。
    for(const child of this.group.children){
      const mesh=child as InstancedMesh,points=mesh.userData.placements as RuralPlacement[];
      const near=points.some(p=>Math.hypot(p.x-x,p.z-z)<this.radius);
      mesh.visible=near&&(!this.lit.includes(mesh)||night>.01);
    }
  }
}
