import test from 'node:test'
import assert from 'node:assert/strict'
import { DispatchService } from '../index.js'
test('isolated voice origin never routes to production8443',()=>{const js=DispatchService.prototype.voiceJs.call({config:{voiceBaseUrl:'http://127.0.0.1:3191/'}});assert(js.includes('http://127.0.0.1:3191/'));assert(!js.includes('8443'));new Function(js.replace('<script>','').replace('</script>',''))})
test('unsafe voice URL rejected',()=>{for(const url of ['javascript:alert(1)','https://user:pass@example.com/'])assert.throws(()=>DispatchService.prototype.voiceJs.call({config:{voiceBaseUrl:url}}))})
