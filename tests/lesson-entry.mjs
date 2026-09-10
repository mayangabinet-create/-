// Run the shipping entry functions; replace only DOM/network boundaries.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
function fn(name) {
  const start = src.search(new RegExp('        (?:async )?function ' + name + '\\('));
  assert.ok(start >= 0);
  return src.slice(start, src.indexOf('\n        }', start) + 10);
}
const lesson = { cards: [{title:'One'}, {title:'Two'}], quiz: [] };
function setup() {
  const events = [];
  const noop = () => {};
  const ctx = {
    console: { error: noop, warn: noop },
    courseData: { concepts: [{name:'Topic'}] }, progress: {},
    lessonLoading:false, lessonState:null, watchingIndex:null, currentLessonIndex:0,
    prefetching:new Map(),
    showMessage: () => events.push('loading'), hideMessage: () => events.push('hide'),
    showProgress:noop, showError: () => events.push('error'),
    normaliseLesson:x=>x, recordCacheHit:noop, saveProgress:noop,
    generateLesson:async()=>lesson, pickWarmUp:()=>null,
    openPartialLesson:noop, applyFinishedLesson:noop,
    document:{getElementById:()=>({classList:{add:noop},value:''})},
    setLessonChrome:noop, applyContentDirection:noop, buildStepSegments:noop,
    displayLearningPath:noop, openLessonScreen:()=>events.push('open'),
    closeLessonScreen:()=>events.push('close'), renderStep:()=>events.push('render'),
    currentUser:{id:'fixture'}, activeSourceText:'', activeStructure:null, activeCourseId:null,
    buildStage:noop, assessMaterial:()=>null, saveCourse:async()=> 'fixture-course',
    localStorage:{setItem:noop}, ACTIVE_STORAGE:'fixture', cleanTitle:x=>x,
  };
  vm.createContext(ctx);
  vm.runInContext(['interleavedCount','buildLessonSteps','loadLesson','processLearningMaterial'].map(fn).join('\n'),ctx);
  return {ctx,events};
}
for (const cached of [false,true]) {
  const {ctx,events}=setup(); if(cached) ctx.progress[0]={lesson};
  await ctx.loadLesson(0);
  assert.ok(events.includes('render')); assert.equal(ctx.lessonLoading,false);
}
{
  const {ctx,events}=setup(); ctx.generateLesson=async()=>{throw Error('prompt failure');};
  await ctx.loadLesson(0);
  assert.ok(events.includes('error')); assert.equal(ctx.lessonLoading,false);
  ctx.generateLesson=async()=>lesson; await ctx.loadLesson(0);
  assert.ok(events.includes('render'));
}
{
  const {ctx,events}=setup(); ctx.renderStep=()=>{throw Error('render failure');};
  await ctx.loadLesson(0); assert.ok(events.includes('error')); assert.equal(ctx.lessonState,null);
}
{
  const {ctx,events}=setup(); await ctx.loadLesson(99);
  assert.ok(events.includes('error')); assert.equal(ctx.lessonLoading,false);
}
{
  const {ctx,events}=setup(); let finish;
  ctx.prefetching.set(0,new Promise(r=>{finish=r;}));
  const pending=ctx.loadLesson(0);
  ctx.generateLessonPath=async()=>({concepts:[{name:'Topic'}]});
  await ctx.processLearningMaterial('fixture text','','Fixture');
  assert.equal(events.includes('hide'),false,'course completion must not erase lesson loading');
  finish(lesson); await pending; assert.ok(events.includes('render')); assert.equal(events.at(-1),'hide');
}
console.log('PASS: cached, generated, prompt failure/retry, render failure, missing concept, concurrent course save');
