import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qualityScore,growthScore } from './scoring';

const base={companyId:1,ticker:'TEST',company:'Test Corp',revenue:100,previousRevenue:85,yearAgoRevenue:70,netIncome:12,operatingIncome:15,operatingCashFlow:18,freeCashFlow:12,grossProfit:55,cash:80,debt:20,marketCap:800,financialEvidenceIds:[1]};
test('deterministic score weights total 100 and reports completeness separately',()=>{
  const q=qualityScore(base),g=growthScore(base);
  assert.equal(q.components.reduce((n,x)=>n+x.weight,0),100);assert.equal(g.components.reduce((n,x)=>n+x.weight,0),100);
  assert.ok(q.score!==null&&q.score>60);assert.ok(q.completeness<100,'missing qualitative evidence lowers completeness');
});
test('missing values remain unavailable instead of becoming zero',()=>{
  const q=qualityScore({companyId:2,ticker:'MISS',company:'Missing Inc'});
  assert.equal(q.score,null);assert.equal(q.rawPoints,0);assert.equal(q.completeness,0);assert.ok(q.components.every(x=>x.points===null));
});
