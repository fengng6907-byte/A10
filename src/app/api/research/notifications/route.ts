import { NextResponse } from 'next/server';
import { z } from 'zod';
import { researchDb } from '@/research/store';
import { updatePreferences } from '@/research/notifications';
const schema=z.union([z.object({notificationId:z.number().int().positive(),read:z.boolean()}),z.object({preferences:z.object({enabledCategories:z.array(z.string()).optional(),minimumPriority:z.enum(['LOW','MEDIUM','HIGH','CRITICAL']).optional(),inAppEnabled:z.boolean().optional(),emailEnabled:z.boolean().optional(),emailAddress:z.string().email().nullable().optional(),cooldownMinutes:z.number().int().min(0).max(10080).optional()})})]);
export async function PATCH(request:Request){const parsed=schema.safeParse(await request.json().catch(()=>null));if(!parsed.success)return NextResponse.json({error:'Invalid notification update'},{status:400});const db=researchDb();if('notificationId'in parsed.data)db.prepare('UPDATE research_notifications SET read_at=? WHERE id=?').run(parsed.data.read?new Date().toISOString():null,parsed.data.notificationId);else updatePreferences(db,parsed.data.preferences);return NextResponse.json({ok:true});}
