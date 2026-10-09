import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runResearchTask } from '@/research/jobs';
const tasks=z.enum(['financials','discover','research','alerts','briefing']);
const body=z.object({tickers:z.array(z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/)).max(25).optional(),limit:z.number().int().min(1).max(250).optional()}).strict();
function authorized(request:Request){const secret=process.env.CRON_SECRET;return !secret&&process.env.NODE_ENV!=='production'||Boolean(secret&&request.headers.get('authorization')===`Bearer ${secret}`);}
async function execute(request:Request,params:Promise<{task:string}>,input:unknown){if(!authorized(request))return NextResponse.json({error:'Unauthorized'},{status:401});const t=tasks.safeParse((await params).task),b=body.safeParse(input);if(!t.success||!b.success)return NextResponse.json({error:'Invalid task or options'},{status:400});try{return NextResponse.json(await runResearchTask(t.data,b.data));}catch(error){return NextResponse.json({error:error instanceof Error?error.message:'Task failed'},{status:500});}}
export async function POST(request:Request,{params}:{params:Promise<{task:string}>}){return execute(request,params,await request.json().catch(()=>({})));}
export async function GET(request:Request,{params}:{params:Promise<{task:string}>}){const u=new URL(request.url),tickers=u.searchParams.get('tickers')?.split(',').map(x=>x.toUpperCase()),limit=u.searchParams.get('limit');return execute(request,params,{tickers,limit:limit?Number(limit):undefined});}
