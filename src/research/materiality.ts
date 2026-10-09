import type Database from 'better-sqlite3';
import { z } from 'zod';

const resultSchema=z.object({items:z.array(z.object({changeId:z.number().int().positive(),isMaterial:z.boolean(),category:z.enum(['FINANCIAL_PERFORMANCE','BALANCE_SHEET_RISK','DILUTION','CASH_FLOW','OTHER']),rationale:z.string().min(3).max(500),evidenceIds:z.array(z.number().int().positive())}).strict()).max(20)}).strict();

export async function classifyMaterialChanges(db:Database.Database){
  if(!process.env.OPENAI_API_KEY)return {processed:0,created:0,status:'SKIPPED_NO_AI_KEY'};
  const changes=db.prepare(`SELECT f.id AS changeId,f.metric,f.comparison,f.old_value AS oldValue,f.new_value AS newValue,f.percent_change AS percentChange,f.direction,f.materiality,f.evidence_ids_json AS evidenceIdsJson,c.ticker
    FROM research_financial_changes f JOIN stock_companies c ON c.id=f.company_id LEFT JOIN research_change_classifications a ON a.change_id=f.id
    WHERE a.id IS NULL AND f.materiality IN ('MEDIUM','HIGH') ORDER BY f.id LIMIT 20`).all() as any[];
  if(!changes.length)return {processed:0,created:0,status:'NO_CHANGES'};
  const allowed=new Map<number,Set<number>>(changes.map(x=>[x.changeId,new Set(JSON.parse(x.evidenceIdsJson))]));
  const model=process.env.RESEARCH_CLASSIFIER_MODEL||process.env.RESEARCH_OPENAI_MODEL||process.env.OPENAI_MODEL||'gpt-4.1-mini';
  const response=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model,temperature:0,response_format:{type:'json_schema',json_schema:{name:'material_changes',strict:true,schema:{type:'object',additionalProperties:false,properties:{items:{type:'array',items:{type:'object',additionalProperties:false,properties:{changeId:{type:'integer'},isMaterial:{type:'boolean'},category:{type:'string',enum:['FINANCIAL_PERFORMANCE','BALANCE_SHEET_RISK','DILUTION','CASH_FLOW','OTHER']},rationale:{type:'string'},evidenceIds:{type:'array',items:{type:'integer'}}},required:['changeId','isMaterial','category','rationale','evidenceIds']}}},required:['items']}}},messages:[{role:'system',content:'Classify whether each deterministic financial change is material for research prioritization. Use only the supplied values and evidence IDs. Do not recalculate values, predict returns, or add facts.'},{role:'user',content:JSON.stringify(changes)}]})});
  if(!response.ok)throw new Error(`AI materiality classifier HTTP ${response.status}`);const data=await response.json(),parsed=resultSchema.parse(JSON.parse(data.choices?.[0]?.message?.content??'null'));
  for(const item of parsed.items){const ids=allowed.get(item.changeId);if(!ids)throw new Error(`Classifier returned unknown change ${item.changeId}`);for(const id of item.evidenceIds)if(!ids.has(id))throw new Error(`Classifier returned unsupported evidence ${id}`);}
  const prompt=Number(data.usage?.prompt_tokens??0),completion=Number(data.usage?.completion_tokens??0),cost=prompt/1e6*Number(process.env.RESEARCH_INPUT_USD_PER_MILLION??0)+completion/1e6*Number(process.env.RESEARCH_OUTPUT_USD_PER_MILLION??0),now=new Date().toISOString();
  const insert=db.prepare(`INSERT OR IGNORE INTO research_change_classifications(change_id,is_material,category,rationale,evidence_ids_json,model,prompt_tokens,completion_tokens,estimated_cost,status,classified_at) VALUES(?,?,?,?,?,?,?,?,?,'DONE',?)`);let created=0;for(const item of parsed.items)created+=insert.run(item.changeId,Number(item.isMaterial),item.category,item.rationale,JSON.stringify(item.evidenceIds),model,prompt,completion,cost,now).changes;
  return {processed:changes.length,created,status:'DONE'};
}
