/** Standard text API equivalents, checked 2026-11-03. Never an account bill.
 * Sources: https://platform.claude.com/docs/en/about-claude/pricing
 * https://developers.openai.com/api/docs/models/gpt-5[.1/.2/.4]
 * https://developers.openai.com/api/docs/pricing (gpt-5.3-codex).
 * Cache write TTL is absent in normalized logs: Claude uses a 5m–1h range.
 * No source/provider-name fallback; unknown models stay unpriced.
 */
export interface ModelUsage { model:string; input:number; output:number; cacheRead:number; cacheWrite:number; reasoning:number }
export interface CostSource { source:string; total:number; model_usage?:ModelUsage[] }
interface Price { input:number; output:number; read:number; writeMin:number; writeMax:number }
function priceFor(model:string):Price|undefined {
 const m=model.toLowerCase().replace(/-\d{8}$/,'').replace(/-\d{4}-\d{2}-\d{2}$/,'');
 const claude:Record<string,[number,number,number,number,number]>={
  'claude-opus-4':[15,75,1.5,18.75,30], 'claude-opus-4-1':[15,75,1.5,18.75,30],
  'claude-opus-4-5':[5,25,.5,6.25,10], 'claude-opus-4-6':[5,25,.5,6.25,10],
  'claude-sonnet-4':[3,15,.3,3.75,6], 'claude-sonnet-4-5':[3,15,.3,3.75,6], 'claude-sonnet-4-6':[3,15,.3,3.75,6],
  'claude-haiku-4-5':[1,5,.1,1.25,2], 'claude-3-5-haiku':[.8,4,.08,1,1.6],
 };
 const openai:Record<string,[number,number,number]>={
  'gpt-5':[1.25,10,.125], 'gpt-5.1':[1.25,10,.125], 'gpt-5.2':[1.75,14,.175],
  'gpt-5.3-codex':[1.75,14,.175], 'gpt-5.4':[2.5,15,.25],
 };
 if(claude[m]){const [input,output,read,writeMin,writeMax]=claude[m];return {input,output,read,writeMin,writeMax};}
 if(openai[m]){const [input,output,read]=openai[m];return {input,output,read,writeMin:0,writeMax:0};}
 return undefined;
}
export function estimateUsageCost(sources:CostSource[]) {
 let lower=0,upper=0,pricedTokens=0,totalTokens=0,valid=true;
 for(const source of sources){
  if(!Number.isSafeInteger(source.total)||source.total<0){valid=false;continue;}
  totalTokens+=source.total;let normalized=0;
  for(const row of source.model_usage??[]){
   const values=[row.input,row.output,row.cacheRead,row.cacheWrite,row.reasoning];
   if(values.some(x=>!Number.isSafeInteger(x)||x<0)||row.reasoning>row.output){valid=false;continue;}
   const tokens=row.input+row.output+row.cacheRead+row.cacheWrite;normalized+=tokens;
   const p=priceFor(row.model);
   if(!p||(row.cacheWrite>0&&p.writeMax===0))continue;
   pricedTokens+=tokens;
   const base=row.input*p.input+row.output*p.output+row.cacheRead*p.read;
   lower+=(base+row.cacheWrite*p.writeMin)/1e6;upper+=(base+row.cacheWrite*p.writeMax)/1e6;
  }
  if(normalized>source.total)valid=false;
 }
 if(!Number.isSafeInteger(totalTokens)||!Number.isSafeInteger(pricedTokens))valid=false;
 const complete=valid&&pricedTokens===totalTokens;
 return {lower,upper,pricedTokens,totalTokens,complete,valid};
}
export function costDisplay(sources:CostSource[]):{label:string;value:string;note:string}{
 const e=estimateUsageCost(sources);
 const note='按已识别模型的标准文本 API 牌价估算（2026-11-03），不是订阅或实际账单；不含长上下文、加速、工具及渠道附加费。缓存写入按 5 分钟至 1 小时价格范围。';
 if(!e.valid||(!e.pricedTokens&&e.totalTokens))return {label:'API 等值估算',value:'暂不可估',note};
 const amount=Math.abs(e.upper-e.lower)<.005?`$${e.lower.toFixed(2)}`:`$${e.lower.toFixed(2)}–${e.upper.toFixed(2)}`;
 return {label:e.complete?'API 等值估算':'已识别部分估算',value:amount,note:note+(!e.complete?` 已覆盖 ${Math.floor(e.pricedTokens/e.totalTokens*100)}% Token，其余模型未计价。`:'')};
}
