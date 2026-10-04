import test from 'node:test'
import assert from 'node:assert/strict'
import { DispatchService } from '../index.js'
test('uncertain approval transport does not erase local waiting evidence',async()=>{const receipt={accepted:false,submitted:false,reason:'transport-uncertain'};const h={pending:new Map([['e',{}]]),pendingByKey:new Map([['s/e','e']]),client:{respond:async()=>receipt},note(){},log(){}};assert.equal(await DispatchService.prototype.applyDecision.call(h,'e','rejected','s','e'),receipt);assert(h.pending.has('e'));assert.equal(h.pendingByKey.get('s/e'),'e')})
