import {createDay as stageDay,createGame as stageGame} from './stage2.mjs';
import {WealthsimpleDay} from './ws-replay.mjs';
import {WealthsimpleGame} from './ws-game.mjs';
export const createDay=(data,manifest)=>manifest.setups?.some(s=>s.execution==='wealthsimple')?new WealthsimpleDay(data,manifest):stageDay(data,manifest);
export const createGame=(day,options={})=>day instanceof WealthsimpleDay?new WealthsimpleGame(day,options):stageGame(day,options);
