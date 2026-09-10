const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {_test:{createTracker,shouldTrack,wrapFetch}}=require('../operations/action-progress');
function clock(){let id=0;const jobs=new Map(),states=[];return {jobs,states,tracker:createTracker({setTimer:(fn,ms)=>{jobs.set(++id,{fn,ms});return id;},clearTimer:id=>jobs.delete(id),notify:state=>states.push(state)}),run(ms){for(const [id,job]of [...jobs])if(job.ms===ms){jobs.delete(id);job.fn();}},get state(){return states.at(-1);}};}
test('quick operations do not flash and delayed callbacks are removed',()=>{const c=clock(),end=c.tracker.begin();assert.equal(c.state,null);end();c.run(350);assert.equal(c.state,null);assert.equal(c.jobs.size,0);end();assert.equal(c.state,null);});
test('slow operations show honest feedback without fabricated percentage',()=>{const c=clock(),end=c.tracker.begin();c.run(350);assert.deepEqual(c.state,{label:'Working on your request…',long:false,count:1});c.run(10000);assert.equal(c.state.long,true);end();assert.equal(c.state,null);});
test('explicit operations immediately show a specific message and outrank transport',()=>{const c=clock(),transport=c.tracker.begin(),action=c.tracker.begin({label:'Scheduling interview…',priority:10,immediate:true});c.run(350);assert.equal(c.state.label,'Scheduling interview…');transport();assert.equal(c.state.label,'Scheduling interview…');action();assert.equal(c.state,null);});
test('one finished operation cannot hide another concurrent operation',()=>{const c=clock(),a=c.tracker.begin({label:'A',immediate:true}),b=c.tracker.begin({label:'B',immediate:true});a();assert.equal(c.state.label,'B');a();assert.equal(c.state.label,'B');b();assert.equal(c.state,null);});
test('clear removes timers and old completion cannot clear new progress',()=>{const c=clock(),old=c.tracker.begin();c.tracker.clear();const next=c.tracker.begin({label:'New',immediate:true});old();assert.equal(c.state.label,'New');next();assert.equal(c.jobs.size,0);});
test('cosmetic rendering failures do not stop or alter work',()=>{const tracker=createTracker({notify:()=>{throw Error('display');}});assert.doesNotThrow(()=>tracker.begin({immediate:true})());});
test('only trusted writes are tracked; polling, auth, GET and unrelated origins are excluded',()=>{
 const base='https://thesorogroup.com/operations/',storage='https://example.supabase.co';
 const check=(url,method)=>shouldTrack(url,{method},base,storage);
 assert.equal(check('/.netlify/functions/talent-verification','POST'),true);
 assert.equal(check('/.netlify/functions/talent-review-queue','GET'),false);
 assert.equal(check('/.netlify/functions/support-tickets?notifications=1','GET'),false);
 assert.equal(check(storage+'/storage/v1/object/upload/sign/file','PUT'),true);
 assert.equal(check(storage+'/rest/v1/applicants','PATCH'),true);
 assert.equal(check(storage+'/auth/v1/token','POST'),false);
 assert.equal(check('https://unrelated.test/.netlify/functions/test','POST'),false);
 assert.equal(check('/operations/index.html','POST'),false);
 assert.equal(shouldTrack(new Request(base+'../.netlify/functions/test',{method:'POST'}),{},base,storage),true);
});
test('fetch wrapper preserves request identity, response, and exact arguments; no retry',async()=>{
 const c=clock(),response={ok:true},input='/.netlify/functions/talent-verification',init={method:'POST',body:'private payload'};let calls=0;
 const fetcher=wrapFetch((a,b)=>{calls++;assert.equal(a,input);assert.equal(b,init);return Promise.resolve(response);},c.tracker,{href:()=> 'https://thesorogroup.com/operations/',storage:()=>''});
 assert.equal(await fetcher(input,init),response);assert.equal(calls,1);assert.equal(c.jobs.size,0);
});
test('fetch rejection and abort release progress and preserve errors without retry',async()=>{
 for(const error of [new Error('network'),new DOMException('aborted','AbortError')]){const c=clock();let calls=0;const fetcher=wrapFetch(()=>{calls++;return Promise.reject(error);},c.tracker,{href:()=> 'https://thesorogroup.com/',storage:()=>''});await assert.rejects(fetcher('/.netlify/functions/test',{method:'POST'}),e=>e===error);assert.equal(calls,1);assert.equal(c.jobs.size,0);assert.equal(c.state,null);}
});
test('motion is restrained and disabled by reduced-motion preference',()=>{const css=fs.readFileSync('operations/action-progress.css','utf8');assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);assert.match(css,/animation:none/);assert.match(css,/pointer-events:none/);assert.doesNotMatch(css,/\.soro-action-progress__mark img[^}]*animation/);});
test('indicator is loaded before SDK and all feature modules',()=>{const html=fs.readFileSync('operations/index.html','utf8');const pos=html.indexOf('src="action-progress.js');assert.ok(pos>0&&pos<html.indexOf('src="https://cdn.jsdelivr.net/npm/@supabase'));assert.ok(pos<html.indexOf('src="talent-review-queue.js'));});
