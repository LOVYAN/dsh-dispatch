import test from 'node:test';import assert from 'node:assert/strict';import {latestTurnResult} from '../turn-result.mjs';
const rows=[{seq:2,role:'assistant',text:'OLD SUCCESS'},{seq:5,role:'user',text:'new request'}];
test('latest failed turn never borrows previous assistant',()=>{const x=latestTurnResult([{seq:4,type:'turn/start'},{seq:8,type:'turn/end',data:{reason:{kind:'error',error:{message:'410 status code'}}}}],rows);assert.equal(x.result,'410 status code');assert(x.isError);assert.equal(x.instruction,'new request')});
test('open turn cannot report old success',()=>assert.equal(latestTurnResult([{seq:4,type:'turn/start'}],rows).settled,false));
test('only committed current-turn answer becomes result',()=>{const x=latestTurnResult([{seq:4,type:'turn/start'},{seq:9,type:'turn/end',data:{reason:{kind:'complete'}}}],[...rows,{seq:7,role:'assistant',text:'NEW'}]);assert.equal(x.result,'NEW');assert.equal(x.sourceSeq,9)});
