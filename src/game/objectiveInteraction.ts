import type {Actor,BombState,GameSnapshot,ObjectiveSite} from './types';
import {wallDistance} from './collision';
import {getActiveMap} from './map';
export const PLANT_SECONDS=3,BOMB_SECONDS=40,DEFUSE_SECONDS=10,KIT_DEFUSE_SECONDS=5;
export const RESCUE_ROUND_SECONDS=180,DEMOLITION_ROUND_SECONDS=120;
/** Shared use ranges: defusing and ground recovery. */
export const DEFUSE_RADIUS=2.4,BOMB_PICKUP_RADIUS=1.1;
type Point={x:number;y?:number;z:number};
export function objectiveReachable(a:Point,b:Point,radius:number,height=1.5):boolean{
 const dx=b.x-a.x,dz=b.z-a.z,dy=(b.y??0)-(a.y??0),distance=Math.hypot(dx,dz);
 if(distance>radius||Math.abs(dy)>height)return false;
 const n=Math.hypot(dx,dz,dy);return n<.01||wallDistance(a.x,(a.y??0)+.8,a.z,dx/n,dy/n,dz/n)>=n-.05;
}
export function insideBombSite(a:Point,site:ObjectiveSite):boolean{
 const b=site.bounds;
 return b?a.x>=b.minX&&a.x<=b.maxX&&a.z>=b.minZ&&a.z<=b.maxZ&&(a.y??0)>=b.minY-.15&&(a.y??0)<=b.maxY
  :Math.hypot(a.x-site.x,a.z-site.z)<=site.radius&&Math.abs((a.y??0)-(site.y??0))<1.5;
}
/** Resolve where a falling/held bomb actually rests. The drop keeps both the
 * horizontal position and the real floor height so pickup, rendering and
 * interaction height checks all read the same point. */
export function bombLandingPoint(x:number,z:number,y=0):{x:number;y:number;z:number}{
 const geometry=getActiveMap().geometry;
 const floor=geometry?.ground(x,z,y+.5)??null;
 // Arena maps have no BSP floors; their playable ground is y = 0.
 return {x,y:floor??(geometry?y:0),z};
}
/** One interaction rule for every actor, human or bot. A plant needs a live T
 * carrying the bomb inside an authored site; a defuse needs a live CT within
 * reach of a planted bomb on the same floor and with a clear body line. */
export function bombTarget(s:GameSnapshot,a:Actor):'plant'|'defuse'|null{
 if(s.mode!=='demolition'||a.health<=0)return null;
 if(a.faction==='t'&&a.hasBomb&&s.bomb.status==='carried'&&s.sites.some(site=>insideBombSite(a,site)))return 'plant';
 if(a.faction==='ct'&&s.bomb.status==='planted'&&objectiveReachable(a,s.bomb,DEFUSE_RADIUS))return 'defuse';
 return null;
}
/** The operator must be alive, actively interacting, stationary, grounded and
 * not firing. Movement, range loss or death therefore resets progress for
 * players and bots through the same predicate. */
export interface BombOperationContext {interacting:boolean;moving:boolean;airborne:boolean;firedRecently:boolean;}
export function bombOperationReady(a:Actor,context:BombOperationContext):boolean{
 return a.health>0&&context.interacting&&!context.moving&&!context.airborne&&!context.firedRecently;
}
/** A dropped bomb carries no plant/defuse ownership. Called when the carrier
 * dies or the round restarts so no stale progress or operator can survive. */
export function clearBombOperation(b:BombState):void{
 b.plantProgress=0;b.planterId=null;b.plantSite=null;b.progress=0;b.defuserId=null;
}
export function clearBombDrop(b:BombState):void{b.dropX=null;b.dropY=null;b.dropZ=null;}
export function objectiveInteraction(s:GameSnapshot,a:Actor):{kind:'rescue'|'wait'|'plant'|'defuse';label:string;hint:string;progress:number;targetId?:number}|null{
 if(a.health<=0||s.phase!=='playing'&&s.phase!=='planted')return null;
 if(s.mode==='hostageRescue'&&s.rescue&&a.faction==='ct'){
  const h=s.rescue.hostages.filter(h=>h.status!=='rescued'&&(h.leaderId===null||h.leaderId===a.id)&&objectiveReachable(a,h,2.2))
   .sort((p,q)=>(p.status==='waiting'?0:1)-(q.status==='waiting'?0:1)||Math.hypot(a.x-p.x,a.z-p.z)-Math.hypot(a.x-q.x,a.z-q.z))[0];
  return h?{kind:h.leaderId===a.id?'wait':'rescue',label:h.leaderId===a.id?'等待':'跟随',hint:h.leaderId===a.id?'按 E 让人质等待':'按 E 让人质跟随，护送至救援区',progress:0,targetId:h.id}:null;
 }
 if(s.mode!=='demolition')return null;
 const target=bombTarget(s,a);
 if(target==='plant')return {kind:'plant',label:'安放',hint:'按住 E 安放 C4 · 保持静止 3 秒',progress:s.bomb.planterId===a.id?s.bomb.plantProgress??0:0};
 if(target==='defuse')return {kind:'defuse',label:'拆除',hint:`按住 E 拆弹 · ${a.defuseKit?5:10} 秒`,progress:s.bomb.defuserId===a.id?s.bomb.progress:0};
 return null;
}
