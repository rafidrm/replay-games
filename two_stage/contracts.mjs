// Use the listed strikes immediately bracketing spot, not a broad percent band.
export function nearStrikes(contracts, spot) {
  if (!Number.isFinite(spot) || spot<=0) return new Set();
  const strikes=[...new Set(contracts.map(c=>c.strike))].sort((a,b)=>a-b);
  return new Set([strikes.findLast(k=>k<=spot),strikes.find(k=>k>=spot)].filter(k=>k!=null&&Math.abs(k/spot-1)<=.02+1e-10));
}

export function moneyness(contract, spot, near=new Set()) {
  if (!Number.isFinite(spot) || spot<=0) return {label:'Spot unavailable',preferred:false};
  const distance=Math.abs(contract.strike/spot-1);
  const itm=contract.right==='CALL'?contract.strike<spot:contract.strike>spot;
  const ntm=near.has(contract.strike);
  const label=distance<1e-8?'ATM':`${ntm?'NTM · ':''}${(100*distance).toFixed(1)}% ${itm?'ITM':'OTM'}`;
  return {distance,itm,near:ntm,preferred:ntm||!itm,label};
}

export function orderContracts(contracts, spot, {selected=''}={}) {
  if(!Number.isFinite(spot)||spot<=0)return contracts.filter(c=>c.id===selected);
  const near=nearStrikes(contracts,spot);
  const compare=(a,b)=>Math.abs(a.strike-spot)-Math.abs(b.strike-spot)||
    Number(moneyness(a,spot).itm)-Number(moneyness(b,spot).itm)||a.strike-b.strike;
  const otm=contracts.filter(c=>!moneyness(c,spot).itm).sort(compare).slice(0,4);
  const nearby=contracts.filter(c=>near.has(c.strike)||otm.includes(c)).sort(compare);
  // Eligibility is chosen before quote availability, so gaps never pull in deep ITM.
  const result=nearby.filter(c=>c.quote);
  const current=contracts.find(c=>c.id===selected);
  if(current&&!result.some(c=>c.id===current.id))result.push(current);
  return result.sort(compare);
}
