import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const extract=name=>{const a=src.search(new RegExp('        (?:async )?function '+name+'\\('));return src.slice(a,src.indexOf('\n        }',a)+10);};
const ctx=vm.createContext({TextDecoder,setTimeout,clearTimeout,Date});
vm.runInContext(extract('sseScanner')+'\n'+extract('readAIStream'),ctx);
const encode=s=>new TextEncoder().encode(s);
const event=x=>`data: ${JSON.stringify(x)}\n\n`;
const delta=text=>event({type:'content_block_delta',delta:{type:'text_delta',text}});
const stop=event({type:'message_stop'});
function response(start){return {body:new ReadableStream({start})};}
const messages=[];
const answer=await ctx.readAIStream(response(c=>c.enqueue(encode(delta('שלום')+event({type:'message_delta',delta:{stop_reason:'end_turn'}})+stop))),t=>messages.push(t),null,{idleMs:100,totalMs:200});
assert.equal(answer.text,'שלום');assert.equal(answer.stopReason,'end_turn');assert.deepEqual(messages,['שלום']);
await assert.rejects(ctx.readAIStream(response(()=>{}),null,null,{idleMs:10,totalMs:100}),/AI_STREAM_TIMEOUT/);
// Real timed pings must not count as useful model progress.
let interval;
const pings=response(c=>{interval=setInterval(()=>c.enqueue(encode(': ping\n\n')),2);});
try {await assert.rejects(ctx.readAIStream(pings,null,null,{idleMs:15,totalMs:100}),/AI_STREAM_TIMEOUT/);} finally {clearInterval(interval);}
let ticking;
const endless=response(c=>{ticking=setInterval(()=>c.enqueue(encode(delta('x'))),2);});
try {await assert.rejects(ctx.readAIStream(endless,null,null,{idleMs:100,totalMs:20}),/AI_STREAM_TIMEOUT/);} finally {clearInterval(ticking);}
await assert.rejects(ctx.readAIStream(response(c=>{c.enqueue(encode(delta('partial')));c.close();})),/AI_STREAM_INCOMPLETE/);
console.log('PASS: completion without EOF, idle timeout, ping timeout, total timeout, incomplete stream');
