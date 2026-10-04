import test from 'node:test'
import assert from 'node:assert/strict'
import { DispatchService } from '../index.js'
test('approval replay reconstructs pending but does not duplicate push', () => {
 const seen=new Set();let pushes=0
 const host={pending:new Map(),pendingByKey:new Map(),config:{pushEnabled:true},markSeen(k){if(seen.has(k))return false;seen.add(k);return true},note(){},log(){},notify(){pushes++}}
 const request={sessionId:'s',approvalId:'e',toolName:'mock'}
 DispatchService.prototype.onApprovalRequested.call(host,'e',request)
 assert.equal(pushes,1);host.pending.clear();host.pendingByKey.clear()
 DispatchService.prototype.onApprovalRequested.call(host,'e',request)
 assert.equal(host.pending.get('e').sessionId,'s');assert.equal(host.pendingByKey.get('s/e'),'e');assert.equal(pushes,1)
})
