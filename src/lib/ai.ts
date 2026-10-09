import { z } from 'zod';
import type { Analysis } from './types';

export interface AIAnalysisProvider { explain(analysis: Analysis, context: unknown): Promise<{ reasoningSummary: string; whatToWaitFor: string }> }
const explanationSchema = z.object({ reasoningSummary: z.string().min(10).max(600), whatToWaitFor: z.string().min(5).max(300) }).strict();

class OpenAIProvider implements AIAnalysisProvider {
  async explain(analysis: Analysis, context: unknown) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4.1-mini', temperature: 0.2,
        response_format: { type: 'json_schema', json_schema: { name: 'analysis_explanation', strict: true, schema: { type: 'object', additionalProperties: false, properties: { reasoningSummary: { type: 'string' }, whatToWaitFor: { type: 'string' } }, required: ['reasoningSummary', 'whatToWaitFor'] } } },
        messages: [
          { role: 'system', content: 'Explain a deterministic XAUUSD strategy result concisely. Do not change the decision, risk rules, numbers, or claim a probability of profit. News risk is unknown unless supplied. The user decides whether to trade.' },
          { role: 'user', content: JSON.stringify({ analysis, context }) }
        ] })
    });
    if (!response.ok) throw new Error(`AI provider HTTP ${response.status}`);
    const data = await response.json();
    return explanationSchema.parse(JSON.parse(data.choices?.[0]?.message?.content ?? 'null'));
  }
}

export async function getExplanation(analysis: Analysis, context: unknown) {
  if (!process.env.OPENAI_API_KEY) return { status: 'RULE_BASED' as const, text: { reasoningSummary: analysis.reasoningSummary, whatToWaitFor: analysis.whatToWaitFor } };
  try { return { status: 'AI_READY' as const, text: await new OpenAIProvider().explain(analysis, context) }; }
  catch { return { status: 'AI_ANALYSIS_UNAVAILABLE' as const, text: null }; }
}
