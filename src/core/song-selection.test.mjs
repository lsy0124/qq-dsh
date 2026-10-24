import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDuration,scoreItem} from './song-selection.mjs';

test('duration parser supports seconds, minute and hour formats',()=>{
  assert.equal(parseDuration('42'),42);assert.equal(parseDuration('3:12'),192);assert.equal(parseDuration('1:02:03'),3723);
});
test('invalid durations cannot become negative or non-finite scores',()=>{
  for(const input of ['-1','Infinity','NaN','1:99','1:2:60','1:2:3:4','9'.repeat(30),'',null]) assert.equal(parseDuration(input),0);
});
test('unaccompanied vocals are not misclassified by the substring accompaniment',()=>{
  const vocal=scoreItem({title:'示例歌曲 无伴奏 清唱',duration:'1:00'});
  const backing=scoreItem({title:'示例歌曲 纯伴奏',duration:'1:00'});
  assert.ok(vocal.score>100); assert.equal(vocal.isVocalOnly,true);assert.equal(backing.isVocalOnly,false);assert.ok(backing.score<0);
});
test('tutorial exclusion takes priority and acoustic material remains eligible',()=>{
  assert.equal(scoreItem({title:'清唱教学',duration:'1:00'}).isVocalOnly,false);
  assert.equal(scoreItem({title:'吉他伴奏 自弹自唱',duration:'1:00'}).isVocalOnly,true);
});
test('invalid view counts cannot poison candidate ranking',()=>{
  for(const play of [-1,Infinity,NaN,'not a number']) assert.ok(Number.isFinite(scoreItem({title:'清唱',duration:'1:00',play}).score));
});
