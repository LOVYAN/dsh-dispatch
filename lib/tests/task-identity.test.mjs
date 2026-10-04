import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {taskIdentity} from '../task-identity.mjs'
test('retry identity persists and rejects changed payload',()=>{const dir=mkdtempSync(join(tmpdir(),'dsh-migration-id-'));try{const b={requestId:'migration-test-1234',text:'same'};const first=taskIdentity(dir,b);const retry=taskIdentity(dir,{...b});assert.equal(retry.sessionId,first.sessionId);assert.equal(retry.replay,true);assert.equal(retry.state,'reserved');first.markAdmitted();assert.equal(taskIdentity(dir,b).state,'admitted');assert.throws(()=>taskIdentity(dir,{...b,text:'other'}),e=>e.statusCode===409);assert.throws(()=>taskIdentity(dir,{...b,requestId:'../bad'}),e=>e.statusCode===400);assert.notEqual(taskIdentity(dir,{text:'same'}).requestId,taskIdentity(dir,{text:'same'}).requestId)}finally{rmSync(dir,{recursive:true,force:true})}})
