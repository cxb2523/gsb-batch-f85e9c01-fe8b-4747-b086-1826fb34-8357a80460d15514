import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {VideoQuality} from '../src/shared/types';
import {MediaCache} from '../src/main/media';
import {CacheManager} from '../src/main/cache-manager';

const ids=Array.from({length:6},(_,i)=>String(7695386527160863800n+BigInt(i)));
const groupId='7695386527160863900';
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
async function until(check:()=>boolean|Promise<boolean>,label='condition'){for(let i=0;i<400;i++){if(await check())return;await tick()}assert.fail(`timed out waiting for ${label}`)}
// Must match MediaCache#partialName: sha256(id:quality) first 32 hex chars.
const partialBase=(id:string,quality:VideoQuality)=>createHash('sha256').update(id+':'+quality).digest('hex').slice(0,32)+'.partial';

interface FixtureOptions {holdDownload?:string;holdEncode?:number;concurrency?:number;outputBytes?:number;streamHold?:string;streamBytes?:number;failId?:string}
async function fixture(t:any,options:FixtureOptions={}){
 const dir=await mkdtemp(path.join(tmpdir(),'manju-quality-'));
 const fetchCalls:{id:string;range?:string}[]=[];
 const resourceCalls:{id:string;quality?:VideoQuality}[]=[];
 const aborted:string[]=[];const killed:string[]=[];const encoded:string[]=[];
 let failureActive=!!options.failId;
 let streamController:ReadableStreamDefaultController<Uint8Array>|undefined;
 const waiters=new Map<string,{resolve:()=>void;reject:(error:unknown)=>void}>();
 const spawnMock=t.mock.method(childProcess,'spawn',(_exe:string,args:readonly string[])=>{
  const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{const input=path.basename(args[args.indexOf('-i')+1]||'');killed.push(input);queueMicrotask(()=>child.emit('close',null));return true}});
  const input=path.basename(args[args.indexOf('-i')+1]||'');encoded.push(input);
  child.stdout.resume();child.stderr.resume();
  if(options.holdEncode===encoded.length)return child;
  queueMicrotask(async()=>{await writeFile(args.at(-1)!,Buffer.alloc(options.outputBytes??14));child.stdout.write('out_time_us=1000000\n');child.emit('close',0)});
  return child;
 });
 const fetchMock=t.mock.method(globalThis,'fetch',async(url:string,init?:RequestInit)=>{
  const id=new URL(url).pathname.slice(1);
  const headers=(init?.headers??{}) as Record<string,string>;
  fetchCalls.push({id,range:headers.Range||headers.range});
  if(options.streamHold===id){
   return new Response(new ReadableStream<Uint8Array>({start(controller){streamController=controller;if(options.streamBytes)controller.enqueue(new Uint8Array(Buffer.alloc(options.streamBytes)));init?.signal?.addEventListener('abort',()=>controller.error(new Error('aborted')),{once:true})}}),{headers:{etag:'"stable-etag"'}});
  }
  if(options.holdDownload===id)await new Promise<void>((resolve,reject)=>{waiters.set(id,{resolve,reject});init?.signal?.addEventListener('abort',()=>{aborted.push(id);reject(new Error('aborted'))},{once:true})});
  if(options.failId===id&&failureActive)throw new Error('offline');
  return new Response(Buffer.from('source-bytes'));
 });
 syncBuiltinESMExports();
 const media=new MediaCache(dir,'fake-ffmpeg',async(id,quality)=>(resourceCalls.push({id,quality}),{episodeId:id,duration:1,definition:'720p',codec:'h264',encrypted:false,url:`https://example.com/${id}`,size:12}),{concurrency:options.concurrency??2,freeBytes:async()=>10*1024**3});
 await media.init();
 t.after(async()=>{for(const waiter of waiters.values())waiter.resolve();try{streamController?.error(new Error('done'))}catch{}await media.close();spawnMock.mock.restore();fetchMock.mock.restore();syncBuiltinESMExports();await rm(dir,{recursive:true,force:true})});
 return {
  media,dir,fetchCalls,resourceCalls,aborted,killed,encoded,
  pushStream:(bytes:Buffer)=>streamController?.enqueue(new Uint8Array(bytes)),
  closeStream:()=>streamController?.close(),
  recover:()=>{failureActive=false},
  release:(id:string)=>waiters.get(id)?.resolve(),
 };
}

test('切换画质后快照状态、已缓存字节与活动项只反映新画质',async t=>{
 const f=await fixture(t,{holdDownload:ids[1],concurrency:2});
 f.media.setBackgroundGroups([{id:groupId,ids:ids.slice(0,4),paused:false}]);
 await until(()=>f.fetchCalls.some(call=>call.id===ids[1])&&f.media.stateFor(ids.slice(0,4)).ready>=1,'initial cache progress');
 await f.media.setQuality('720p');
 const state=f.media.stateFor(ids.slice(0,4));
 assert.equal(state.ready,0,'old-quality completed episodes are not ready in the new quality');
 assert.equal(state.failed,0,'cleared failure set stays empty after cancellation');
 assert.equal(state.cachedBytes,0,'old-quality entry/progress bytes are not shown');
 assert.ok((state.activities?.length??0)>0,'new-quality queue starts producing active items');
 assert.ok(state.activities!.every(activity=>!activity.activity?.transferred||activity.activity.transferred===0||activity.activity.stage==='resolving'),'no old download progress survives');
 assert.ok([...(f.media as any).activeJobs].every((job:any)=>job.quality==='720p'&&job.generation===1),'active jobs belong to the new quality generation');
});

test('旧画质断点文件按画质哈希区分，切换时清理且新画质从零续传',async t=>{
 const f=await fixture(t,{holdDownload:ids[1],concurrency:2});
 f.media.setBackgroundGroups([{id:groupId,ids:ids.slice(0,4),paused:false}]);
 await until(()=>f.fetchCalls.some(call=>call.id===ids[1]),'held download starts');
 const oldMp4=partialBase(ids[1],'auto')+'.mp4',oldJson=partialBase(ids[1],'auto')+'.json';
 await until(async()=>(await readdir(f.dir)).includes(oldJson),'old-quality checkpoint exists');
 assert.ok((await readdir(f.dir)).includes(oldMp4));
 const callsForHeld=f.fetchCalls.filter(call=>call.id===ids[1]).length;
 await f.media.setQuality('720p');
 let names=await readdir(f.dir);
 assert.ok(!names.includes(oldMp4),'old partial media file removed at switch');
 assert.ok(!names.includes(oldJson),'old checkpoint file removed at switch');
 const newMp4=partialBase(ids[1],'720p')+'.mp4',newJson=partialBase(ids[1],'720p')+'.json';
 await until(async()=>(await readdir(f.dir)).includes(newJson),'new-quality checkpoint name is recomputed');
 names=await readdir(f.dir);
 assert.ok(names.includes(newMp4),'new-quality partial uses the new quality-scoped name');
 assert.notEqual(newMp4,oldMp4);
 await until(()=>f.fetchCalls.slice(callsForHeld).some(call=>call.id===ids[1]&&call.range===undefined),'fresh new-quality fetch starts without a Range resume');
 assert.ok(f.aborted.includes(ids[1]),'in-flight old download was aborted');
});

test('带已下载字节的进行中任务被取消，断点字节与额度占用在切换后释放',async t=>{
 const f=await fixture(t,{streamHold:ids[0],streamBytes:4,concurrency:1});
 void f.media.prepare(ids[0]).catch(()=>{});
 await until(()=>f.media.usedBytes>=4,'streamed partial bytes are accounted');
 assert.ok(f.media.usedBytes>=4);
 const transition=f.media.setQuality('720p');
 assert.equal(f.media.usedBytes,0,'superseded breakpoint bytes leave quota accounting synchronously');
 await transition;
 assert.equal(f.media.usedBytes,0,'superseded breakpoint bytes no longer occupy quota');
 const names=await readdir(f.dir);
 assert.ok(!names.some(name=>/\.partial\.(mp4|json)$/.test(name)),'all breakpoint files removed');
 assert.equal(f.media.stateFor([ids[0]]).cachedBytes,0);
});

test('切换画质取消正在转码的任务且不记失败，随后新画质整队完成',async t=>{
 const f=await fixture(t,{holdEncode:1,concurrency:2});
 const work=ids.slice(0,3);
 f.media.setBackgroundGroups([{id:groupId,ids:work,paused:false}]);
 await until(()=>f.encoded.length>=1&&f.media.stateFor(work).ready>=1,'one episode encoding held while another is ready');
 const resourceMark=f.resourceCalls.length;
 await f.media.setQuality('480p');
 assert.ok(f.killed.length>=1,'held ffmpeg process killed');
 await until(()=>f.media.stateFor(work).ready===work.length,'new-quality queue completes all episodes');
 const state=f.media.stateFor(work);
 assert.equal(state.failed,0,'cancelled encoding episodes are not failures');
 assert.ok(!(await readdir(f.dir)).some(name=>/\.(input|working)\.mp4$/.test(name)),'no transient input/working files remain');
 assert.ok(f.resourceCalls.slice(resourceMark).length>0&&f.resourceCalls.slice(resourceMark).every(call=>call.quality==='480p'),'new work resolves resources at the new quality');
});

test('切换后后台队列按新画质重新缓存全部剧集，取消的集不重试旧画质',async t=>{
 const f=await fixture(t,{concurrency:2});
 const work=ids.slice(0,4);
 f.media.setBackgroundGroups([{id:groupId,ids:work,paused:false}]);
 await until(()=>f.media.stateFor(work).ready===work.length,'initial auto-quality cache completes');
 const firstUrls=new Map(work.map(id=>[id,f.media.stateFor([id])]));
 f.fetchCalls.length=0;f.resourceCalls.length=0;
 await f.media.setQuality('720p');
 await until(()=>f.media.stateFor(work).ready===work.length,'720p re-cache completes');
 assert.deepEqual([...f.fetchCalls].map(call=>call.id).sort(),[...work].sort(),'every episode downloaded again at the new quality');
 assert.ok(f.resourceCalls.every(call=>call.quality==='720p'));
 assert.equal(f.media.stateFor(work).failed,0);
 assert.ok(firstUrls.size===4);
});

test('切换清空旧画质的既有失败集合，失败集在新画质下重新排队并完成',async t=>{
 const f=await fixture(t,{failId:ids[1],concurrency:2});
 const work=ids.slice(0,3);
 f.media.setBackgroundGroups([{id:groupId,ids:work,paused:false}]);
 await until(()=>f.media.stateFor(work).failed===1&&f.media.stateFor(work).ready===2,'one episode fails at old quality');
 assert.equal(f.media.stateFor(work).failed,1);
 f.recover();
 await f.media.setQuality('720p');
 assert.equal(f.media.stateFor(work).failed,0,'failure set cleared by the switch');
 await until(()=>f.media.stateFor(work).ready===work.length,'previously failed episode completes at new quality');
 assert.ok(f.resourceCalls.some(call=>call.id===ids[1]&&call.quality==='720p'));
});

test('切换后重新播放触发新画质取流，旧画质缓存地址不复用',async t=>{
 const f=await fixture(t,{concurrency:1});
 const oldPlayback=await f.media.prepare(ids[0]);
 assert.equal(f.resourceCalls.at(-1)?.quality,'auto');
 await f.media.setQuality('1080p');
 const newPlayback=await f.media.prepare(ids[0]);
 assert.notEqual(newPlayback.url,oldPlayback.url,'old-quality local URL is not reused');
 assert.equal(f.resourceCalls.at(-1)?.quality,'1080p');
 const lookups=f.resourceCalls.length;
 const reused=await f.media.prepare(ids[0]);
 assert.equal(reused.url,newPlayback.url,'same-quality prepare reuses the new cache');
 assert.equal(f.resourceCalls.length,lookups,'same quality does not fetch again');
});

test('磁盘上的旧断点在新 MediaCache 实例切换画质时也会被清理并释放额度',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'manju-quality-disk-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const oldBase=partialBase(ids[2],'auto');
 await writeFile(path.join(dir,oldBase+'.mp4'),Buffer.alloc(37));
 await writeFile(path.join(dir,oldBase+'.json'),JSON.stringify({version:1,bytes:37}));
 const media=new MediaCache(dir,'fake-ffmpeg',async()=>{throw new Error('no lookup expected')});
 await media.init();
 assert.equal(media.usedBytes,37);
 await media.setQuality('720p');
 assert.equal(media.usedBytes,0);
 const names=await readdir(dir);
 assert.ok(!names.includes(oldBase+'.mp4')&&!names.includes(oldBase+'.json'));
 await media.close();
});

test('CacheManager.setQuality 持久化画质、驱动媒体迁移并出现在快照中，重启恢复不清同画质断点',async t=>{
 const profile=await mkdtemp(path.join(tmpdir(),'manju-quality-mgr-'));t.after(()=>rm(profile,{recursive:true,force:true}));
 const calls:[string,VideoQuality][]=[];
 const makeFakeMedia=(initial:VideoQuality)=>{const media:any={
  location:path.join(profile,'media-cache'),usedBytes:0,downloadBytesPerSecond:0,quality:initial,
  restoreQuality(q:VideoQuality){calls.push(['restore',q]);this.quality=q},
  setQuality(q:VideoQuality){calls.push(['set',q]);this.quality=q;return Promise.resolve()},
  setLimits(){},setBackgroundGroups(){},setConcurrency(){},freeBytes:async()=>0,
  stateFor:()=>({status:'idle',total:0,ready:0,failed:0,message:''}),
 };return media};
 const first=new CacheManager(profile,makeFakeMedia('auto'));
 await first.init();
 const snapshot=await first.setQuality('720p');
 assert.equal(snapshot.quality,'720p');
 assert.deepEqual(calls.filter(call=>call[0]==='set'),[['set','720p']]);
 const saved=JSON.parse(await (await import('node:fs/promises')).readFile(path.join(profile,'cache-settings.json'),'utf8'));
 assert.equal(saved.quality,'720p');
 await assert.rejects(first.setQuality('4K' as VideoQuality),{code:'INVALID_INPUT'});
 const secondMedia=makeFakeMedia('auto');
 const reopened=new CacheManager(profile,secondMedia);
 await reopened.init();
 assert.equal(secondMedia.quality,'720p','persisted quality restored to the media layer');
 assert.ok(calls.some(call=>call[0]==='restore'&&call[1]==='720p'));
 assert.equal((await reopened.snapshot()).quality,'720p');
});

const series=(id:string)=>({id,title:'缓存作品'+id,cover:'',description:'',total:2,episodes:[{id:id+'01',order:1},{id:id+'02',order:2}]});

test('重启恢复持久化画质后，只把匹配画质的断点计为已缓存字节且不清理它',async t=>{
 const profile=await mkdtemp(path.join(tmpdir(),'manju-quality-restore-'));t.after(()=>rm(profile,{recursive:true,force:true}));
 const mediaDir=path.join(profile,'media-cache');
 await (await import('node:fs/promises')).mkdir(mediaDir,{recursive:true});
 const episode=series('34567890').episodes[0].id;
 const autoName=partialBase(episode,'auto')+'.mp4',hdName=partialBase(episode,'720p')+'.mp4';
 await writeFile(path.join(mediaDir,autoName),Buffer.alloc(11));
 await writeFile(path.join(mediaDir,autoName.replace('.mp4','.json')),'{}');
 await writeFile(path.join(mediaDir,hdName),Buffer.alloc(22));
 await writeFile(path.join(mediaDir,hdName.replace('.mp4','.json')),'{}');
 await writeFile(path.join(profile,'cache-settings.json'),JSON.stringify({version:1,directory:mediaDir,closeToTray:true,tasks:[],quality:'720p'}));
 const media=new MediaCache(mediaDir,'fake-ffmpeg',async()=>{throw new Error('no lookup')});
 await media.init();
 const manager=new CacheManager(profile,media);
 await manager.init();
 assert.equal(media.quality,'720p');
 assert.equal((await manager.snapshot()).quality,'720p');
 assert.equal(media.stateFor([episode]).cachedBytes,22,'only the restored-quality breakpoint counts');
 const names=await readdir(mediaDir);
 assert.ok(names.includes(hdName),'matching-quality breakpoint is preserved for resume');
 assert.ok(names.includes(autoName),'startup restore must not purge files (live switch owns purging)');
 await media.close();
});

test('CacheManager 快照与真实 MediaCache 联动：切换后任务零进度，旧完成文件保留到新画质替换',async t=>{
 const f=await fixture(t,{concurrency:1});
 const profile=path.join(f.dir,'profile');
 const media=f.media;
 const manager=new CacheManager(profile,media);
 await manager.init();
 const work=series('12345678');
 await manager.add(work);
 await manager.action(work.id,'pause');
 await media.prepare(work.episodes[0].id);
 let snapshot=await manager.snapshot();
 assert.equal(snapshot.quality,'auto');
 assert.equal(snapshot.tasks[0].state.ready,1);
 assert.ok((snapshot.tasks[0].state.cachedBytes??0)>0);
 const physicalAfterComplete=media.usedBytes;
 snapshot=await manager.setQuality('720p');
 assert.equal(snapshot.quality,'720p');
 assert.equal(snapshot.tasks[0].state.ready,0);
 assert.equal(snapshot.tasks[0].state.failed,0);
 assert.equal(snapshot.tasks[0].state.cachedBytes,0);
 assert.ok(media.usedBytes>=physicalAfterComplete,'old-quality file still occupies physical quota until replaced');
 const replayed=await media.prepare(work.episodes[0].id);
 assert.ok(replayed.url.includes('manju-media://'));
 await until(()=>media.stateFor([work.episodes[0].id]).ready===1,'new quality replacement completes');
 assert.equal(media.stateFor(work.episodes.map(e=>e.id)).ready,1);
 assert.equal(media.usedBytes,physicalAfterComplete,'old file replaced, no double quota');
});

test('仅存旧画质缓存的只读作品切换后仍保留清理入口',async t=>{
 const f=await fixture(t,{concurrency:1});
 const profile=path.join(f.dir,'profile-local');
 const media=f.media;
 const manager=new CacheManager(profile,media);
 await manager.init();
 const work=series('23456789');
 await manager.remember(work);
 await media.prepare(work.episodes[0].id);
 assert.equal((await manager.snapshot()).tasks.length,1);
 await manager.setQuality('720p');
 const snapshot=await manager.snapshot();
 assert.equal(snapshot.tasks.length,1,'other-quality files still justify a read-only cleanup entry');
 assert.equal(snapshot.tasks[0].registered,false);
 assert.equal(snapshot.tasks[0].state.cachedBytes,0);
});
