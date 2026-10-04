import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
export function taskIdentity(home, body) {
 const supplied=body.requestId
 if(supplied===undefined)return {requestId:randomUUID(),sessionId:body.sessionId}
 if(typeof supplied!=='string'||! /^[A-Za-z0-9_-]{8,128}$/.test(supplied))throw Object.assign(new Error('invalid requestId'),{statusCode:400})
 const key=createHash('sha256').update(supplied).digest('hex')
 const signature=createHash('sha256').update(JSON.stringify({text:body.text,mode:body.mode==='steer'?'steer':'queue',sessionId:body.sessionId||null,cwd:body.cwd||null,workspaceId:body.workspaceId||null,agentPreset:body.agentPreset||null})).digest('hex')
 const dir=join(home,'dispatch-request-identities');mkdirSync(dir,{recursive:true})
 const file=join(dir,key+'.json');let record
 try{record=JSON.parse(readFileSync(file,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
 if(record&&record.signature!==signature)throw Object.assign(new Error('requestId reused with different payload'),{statusCode:409})
 const sessionId=body.sessionId||'session-'+key.slice(0,8)+'-'+key.slice(8,12)+'-4'+key.slice(13,16)+'-a'+key.slice(17,20)+'-'+key.slice(20,32)
 if(!record)writeFileSync(file,JSON.stringify({signature,sessionId,state:'reserved'}),{flag:'wx',mode:0o600})
 return {requestId:supplied,sessionId:record?.sessionId||sessionId,replay:Boolean(record),state:record?.state||'reserved',markAdmitted(){writeFileSync(file,JSON.stringify({signature,sessionId,state:'admitted'}),{mode:0o600})}}
}
