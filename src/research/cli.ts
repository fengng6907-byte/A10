import { runResearchTask,type ResearchTask } from './jobs';

const task=process.argv[2] as ResearchTask;
if(!['financials','discover','research','alerts','briefing'].includes(task)){console.error('Usage: tsx src/research/cli.ts <financials|discover|research|alerts|briefing> [--tickers=AAPL,MSFT] [--limit=5]');process.exit(1);}
const arg=(name:string)=>process.argv.find(x=>x.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const tickers=arg('tickers')?.split(',').map(x=>x.trim().toUpperCase()).filter(Boolean),limitValue=arg('limit'),limit=limitValue?Number(limitValue):undefined;
runResearchTask(task,{tickers,limit:Number.isFinite(limit)?limit:undefined}).then(result=>{console.log(JSON.stringify(result,null,2));}).catch(error=>{console.error(error instanceof Error?error.stack:error);process.exitCode=1;});
