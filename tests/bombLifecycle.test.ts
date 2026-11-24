import test from 'node:test';
import assert from 'node:assert/strict';
import {Simulation} from '../src/game/simulation';
import {setActiveMap,type MapId} from '../src/game/map';
import {botObjective} from '../src/game/botTactics';
import {bombTarget,objectiveReachable} from '../src/game/objectiveInteraction';
import {EMPTY_INPUT,type Actor,type GameSnapshot,type PlayerInput} from '../src/game/types';

const DT=1/60,HOLD={...EMPTY_INPUT,interact:true};
// Arena maps are asset-independent: the C4 lifecycle can be verified offline
// while still using the real simulation, collision and bot code.
const SITE={id:'A' as const,x:0,z:10,radius:2.6};
function game(seed=123){
 setActiveMap('desert');
 const sim=new Simulation(seed);sim.start('demolition');
 const s=sim.state;s.sites=[SITE];return {sim,s};
}
function passive(s:GameSnapshot){for(const a of s.actors)a.player=true;}
function place(a:Actor,p:{x:number;y?:number;z:number}){
 Object.assign(a,{x:p.x,y:p.y??0,z:p.z,groundY:p.y??0,verticalSpeed:0,climbing:false,moving:false,crouched:false,shotTime:-10});
}
function frames(sim:Simulation,count:number,input:PlayerInput=EMPTY_INPUT){
 for(let n=0;n<count;n++)sim.update(DT,input);
}
function withMap(run:()=>void){try{run();}finally{setActiveMap('desert');}}

test('dropped C4 records its real landing point and height; only a live T in reach recovers it',()=>withMap(()=>{
 const {sim,s}=game();passive(s);
 const carrier=s.actors.find(a=>a.id===s.bomb.carrierId)!;
 const other=s.actors.find(a=>a.faction==='t'&&a!==carrier)!;
 const ct=s.actors.find(a=>a.faction==='ct')!;
 // The carrier dies in mid-air over flat arena ground.
 place(carrier,{x:SITE.x+1,z:SITE.z+1,y:3.5});
 frames(sim,1);
 carrier.health=0;frames(sim,1);
 assert.equal(s.bomb.status,'dropped');
 assert.equal(s.bomb.carrierId,null);assert.equal(carrier.hasBomb,false);
 // Real rest point: same XZ, floor height, and a stored drop coordinate.
 assert.deepEqual({x:s.bomb.x,y:s.bomb.y,z:s.bomb.z},{x:SITE.x+1,y:0,z:SITE.z+1});
 assert.deepEqual({x:s.bomb.dropX,y:s.bomb.dropY,z:s.bomb.dropZ},{x:s.bomb.x,y:s.bomb.y,z:s.bomb.z});
 assert.equal(s.bomb.planterId,null);assert.equal(s.bomb.plantProgress,0);
 // A CT standing on the bomb cannot take it.
 place(ct,s.bomb);frames(sim,1);
 assert.equal(s.bomb.status,'dropped');assert.equal(ct.hasBomb,false);
 // A dead T on the bomb cannot take it either.
 place(carrier,s.bomb);frames(sim,1);
 assert.equal(s.bomb.status,'dropped');
 // A live T beyond reach cannot take it.
 place(other,{x:s.bomb.x+4,z:s.bomb.z});frames(sim,1);
 assert.equal(s.bomb.status,'dropped');
 // A live T that reaches the drop takes it and the ground coordinate clears.
 place(other,s.bomb);frames(sim,1);
 assert.equal(s.bomb.status,'carried');assert.equal(s.bomb.carrierId,other.id);
 assert.equal(other.hasBomb,true);assert.equal(carrier.hasBomb,false);
 assert.equal(s.bomb.dropX,null);assert.equal(s.bomb.dropY,null);assert.equal(s.bomb.dropZ,null);
 assert.deepEqual({x:s.bomb.x,y:s.bomb.y,z:s.bomb.z},{x:other.x,y:other.y,z:other.z});
 // The carried bomb now follows the new carrier instead of the old spot.
 place(other,{x:SITE.x-3,z:SITE.z-4});
 frames(sim,1);
 assert.deepEqual({x:s.bomb.x,z:s.bomb.z},{x:other.x,z:other.z});
}));

test('plant progress belongs to the current operator and zeroes on movement, death and re-start',()=>withMap(()=>{
 const {sim,s}=game();passive(s);
 const carrier=s.actors.find(a=>a.id===s.bomb.carrierId)!;
 const other=s.actors.find(a=>a.faction==='t'&&a!==carrier)!;
 for(const a of s.actors.filter(a=>a.faction==='t'&&a!==carrier))place(a,{x:-18,z:-16});
 s.player=carrier;place(carrier,{...SITE,x:SITE.x+.4});
 frames(sim,90,HOLD);
 assert.equal(s.bomb.status,'carried');
 assert.ok((s.bomb.plantProgress??0)>.45,'half of the three-second plant');
 assert.equal(s.bomb.planterId,carrier.id);
 // Moving breaks the hold: no progress and no operator remains.
 frames(sim,1,{...HOLD,moveX:1});
 assert.equal(s.bomb.planterId,null);assert.ok((s.bomb.plantProgress??0)<.01);
 assert.equal(s.bomb.progress,0);assert.equal(s.bomb.defuserId,null);
 // Resume and let the carrier die mid-plant; the drop clears ownership.
 frames(sim,60,HOLD);
 assert.ok((s.bomb.plantProgress??0)>.3);
 carrier.health=0;frames(sim,1);
 assert.equal(s.bomb.status,'dropped');
 assert.equal(s.bomb.planterId,null);assert.equal(s.bomb.plantProgress,0);assert.equal(s.bomb.plantSite,null);
 assert.notEqual(s.bomb.dropX,null);
 // The new carrier must time the full action again from zero.
 place(other,s.bomb);frames(sim,1);
 assert.equal(s.bomb.status,'carried');assert.equal(other.hasBomb,true);
 assert.equal(s.bomb.plantProgress,0);assert.equal(s.bomb.planterId,null);
 s.player=other;place(other,{...SITE,x:SITE.x-.4});
 frames(sim,90,HOLD);
 assert.ok((s.bomb.plantProgress??0)>.45&&(s.bomb.plantProgress??0)<.6,'restarts from zero rather than resuming');
 assert.equal(s.bomb.planterId,other.id);
 frames(sim,90,HOLD);
 assert.equal(s.bomb.status,'planted');assert.equal(s.bomb.site,'A');
}));

test('defuse progress belongs to the current operator, zeroes on movement, range loss and death, and re-times',()=>withMap(()=>{
 const {sim,s}=game();passive(s);
 const carrier=s.actors.find(a=>a.id===s.bomb.carrierId)!;
 s.player=carrier;place(carrier,SITE);frames(sim,180,HOLD);
 assert.equal(s.bomb.status,'planted');assert.equal(s.bomb.site,'A');
 const ct=s.actors.find(a=>a.faction==='ct')!;
 ct.defuseKit=true;s.player=ct;
 for(const a of s.actors.filter(a=>a.faction==='t'))a.health=0;
 place(ct,SITE);frames(sim,60,HOLD);
 assert.ok(s.bomb.progress>.15&&s.bomb.progress<.3,'one second of a five-second kit defuse');
 assert.equal(s.bomb.defuserId,ct.id);
 frames(sim,1,{...HOLD,moveX:1});
 assert.equal(s.bomb.progress,0);assert.equal(s.bomb.defuserId,null);
 // Leaving range also clears the operator and progress.
 place(ct,SITE);frames(sim,60,HOLD);assert.ok(s.bomb.progress>.15);
 place(ct,{...SITE,x:SITE.x+4});frames(sim,1,HOLD);
 assert.equal(s.bomb.progress,0);assert.equal(s.bomb.defuserId,null);
 // Death clears the operator entirely, so a teammate must start over.
 place(ct,SITE);frames(sim,60,HOLD);assert.ok(s.bomb.progress>.15);
 ct.health=0;frames(sim,1,HOLD);
 assert.equal(s.bomb.progress,0);assert.equal(s.bomb.defuserId,null);
 assert.equal(s.bomb.status,'planted');
 // Re-timing from zero: the full five seconds is required again.
 const mate=s.actors.find(a=>a.faction==='ct'&&a!==ct)!;
 mate.defuseKit=true;mate.health=100;s.player=mate;place(mate,SITE);
 frames(sim,299,HOLD);
 assert.equal(s.bomb.status,'planted');assert.ok(s.bomb.progress>.99);
 frames(sim,1,HOLD);
 assert.equal(s.bomb.status,'defused');assert.equal(s.winner,'blue');
 assert.ok(sim.events.some(e=>e.type==='defuseComplete'&&e.actorId===mate.id));
}));

test('T bots recover a dropped bomb instead of chasing a visible distant enemy',()=>withMap(()=>{
 const {sim,s}=game(321);
 passive(s);
 const carrier=s.actors.find(a=>a.id===s.bomb.carrierId)!;
 const rescuer=s.actors.find(a=>a.faction==='t'&&a!==carrier)!;
 const ct=s.actors[0];
 place(carrier,SITE);frames(sim,1);carrier.health=0;frames(sim,1);
 assert.equal(s.bomb.status,'dropped');
 // The rescue bot starts behind the drop, facing an unobstructed CT target.
 // A naive "fight what you can see" bot walks to cover instead of the bomb.
 place(rescuer,{x:16,z:17});rescuer.player=false;rescuer.yaw=0;
 Object.assign(ct,{x:16,z:9,y:0,health:1_000_000,player:true});s.player=ct;
 const start={x:rescuer.x,z:rescuer.z};
 assert.equal(botObjective(rescuer,s).role,'recover');
 let picked=null;
 // Read through a helper so TS keeps the narrowed union from the assert above
 // from pinning the live snapshot status.
 const status=()=>s.bomb.status as string;
 for(let frame=0;frame<20*60&&status()==='dropped';frame++){
  sim.update(DT);
  if(status()==='carried')picked=frame/60;
 }
 assert.ok(picked!==null,'a surviving T must recover the bomb');
 assert.ok(picked<10,`recovered in ${picked?.toFixed(2)}s instead of fighting first`);
 assert.equal(s.bomb.carrierId,rescuer.id);assert.equal(rescuer.hasBomb,true);
 assert.ok(Math.hypot(rescuer.x-start.x,rescuer.z-start.z)>11,'moved to the drop, not to the enemy');
 assert.ok(Math.hypot(rescuer.x-SITE.x,rescuer.z-SITE.z)<1.2);
}));

test('CT bots head for a planted bomb and complete the defuse instead of patrolling',()=>withMap(()=>{
 const {sim,s}=game(555);
 passive(s);
 const carrier=s.actors.find(a=>a.id===s.bomb.carrierId)!;
 s.player=carrier;place(carrier,SITE);frames(sim,180,HOLD);
 assert.equal(s.bomb.status,'planted');
 const cts=s.actors.filter(a=>a.faction==='ct');
 const human=cts[0];
 // Keep a clear-laned T target in front of the defenders: a bot that treats
 // the gunfight as the mission will take cover and never reach the C4.
 const decoy=s.actors.find(a=>a.faction==='t'&&a!==carrier)!;
 for(const a of s.actors.filter(a=>a.faction==='t'&&a!==decoy&&a!==carrier))a.health=0;
 Object.assign(decoy,{health:1_000_000,x:16,z:17,y:0,player:true});
 human.player=true;human.health=0;s.player=human;
 for(const a of cts)if(a!==human){a.player=false;place(a,{x:16,z:9});a.yaw=Math.PI;}
 // Every defender's objective is the bomb (defuse) or a close guard slot,
 // never a spawn patrol or the decoy's coordinates.
 const objectives=cts.filter(a=>a!==human).map(a=>botObjective(a,s));
 assert.ok(objectives.every(o=>o.role==='defuse'||o.role==='guard'),JSON.stringify(objectives));
 assert.ok(objectives.every(o=>Math.hypot(o.point.x-SITE.x,o.point.z-SITE.z)<5.5));
 assert.equal(objectives.filter(o=>o.role==='defuse').length,1);
 const start=s.time;
 for(let frame=0;frame<40*60&&s.bomb.status==='planted';frame++)sim.update(DT);
 assert.equal(s.bomb.status,'defused',JSON.stringify({elapsed:s.time-start,progress:s.bomb.progress,defuserId:s.bomb.defuserId}));
 assert.ok(s.time-start<20,`defused in ${(s.time-start).toFixed(2)}s`);
 assert.equal(s.winner,'blue');
 assert.ok(sim.events.some(e=>e.type==='defuseComplete'&&e.actorId!==human.id));
}));

test('the round reset leaves no stale planter, defuser, progress or drop coordinate',()=>withMap(()=>{
 const {sim,s}=game();passive(s);
 const carrier=s.actors.find(a=>a.id===s.bomb.carrierId)!;
 const ct=s.actors.find(a=>a.faction==='ct')!;
 // Plant, start a defuse, then force a fresh round via the normal reset path.
 s.player=carrier;place(carrier,SITE);frames(sim,180,HOLD);
 assert.equal(s.bomb.status,'planted');
 ct.defuseKit=true;s.player=ct;place(ct,SITE);frames(sim,30,HOLD);
 assert.ok(s.bomb.progress>0&&s.bomb.defuserId===ct.id);
 s.round=2;sim.resetRound();
 assert.equal(s.bomb.status,'carried');
 assert.equal(s.bomb.carrierId,s.actors.find(a=>a.faction==='t')!.id);
 assert.equal(s.bomb.planterId,null);assert.equal(s.bomb.plantProgress,0);assert.equal(s.bomb.plantSite,null);
 assert.equal(s.bomb.defuserId,null);assert.equal(s.bomb.progress,0);
 assert.equal(s.bomb.dropX,null);assert.equal(s.bomb.dropY,null);assert.equal(s.bomb.dropZ,null);
 assert.equal(s.actors.filter(a=>a.hasBomb).length,1);
}));

test('player and bots share one bomb interaction rule and one reachability check',()=>{
 const {sim,s}=game(9);passive(s);
 const ct=s.actors.find(a=>a.faction==='ct')!;
 Object.assign(s.bomb,{status:'planted',carrierId:null,x:SITE.x,y:0,z:SITE.z,site:'A',timer:40,progress:0,defuserId:null});
 s.phase='planted';
 place(ct,SITE);
 const asPlayer={...ct,player:true},asBot={...ct,player:false};
 assert.equal(bombTarget(s,asPlayer),'defuse');
 assert.equal(bombTarget(s,asPlayer),bombTarget(s,asBot));
 assert.equal(objectiveReachable(asPlayer,s.bomb,2.4),objectiveReachable(asBot,s.bomb,2.4));
 // Out of reach on the same floor, neither flag may interact.
 place(ct,{...SITE,x:SITE.x+3.2});
 assert.equal(bombTarget(s,{...ct,player:true}),null);
 assert.equal(bombTarget(s,{...ct,player:false}),null);
 // A different floor is not reachable for either.
 place(ct,{...SITE,y:2});
 assert.equal(bombTarget(s,ct),null);
 setActiveMap('desert');
});
