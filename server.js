const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json({limit:'10mb'}));
app.use(express.static(__dirname));

const DATA_FILE = path.join(__dirname, 'data.json');

// ── helpers ──
function readData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); }
  catch(e) { return {members:[],tickets:[]}; }
}
function writeData(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d,null,2));
}

// ══════════════════════════════════════
// EXISTING TEAM MAP ROUTES (unchanged)
// ══════════════════════════════════════
app.get('/api/members', (req,res) => {
  res.json(readData().members||[]);
});
app.post('/api/members', (req,res) => {
  const d=readData();
  const m=req.body;
  if(!m.name) return res.status(400).json({error:'name required'});
  const idx=d.members.findIndex(x=>x.name.toLowerCase()===m.name.toLowerCase());
  if(idx>=0) d.members[idx]={...d.members[idx],...m,updatedAt:Date.now()};
  else d.members.push({...m,updatedAt:Date.now()});
  writeData(d); res.json(m);
});
app.get('/api/tickets', (req,res) => {
  res.json(readData().tickets||[]);
});
app.post('/api/tickets', (req,res) => {
  const d=readData();
  d.tickets.push(req.body); writeData(d); res.json(req.body);
});
app.put('/api/tickets/:id', (req,res) => {
  const d=readData();
  const idx=d.tickets.findIndex(t=>t.id===req.params.id);
  if(idx>=0) d.tickets[idx]=req.body; else d.tickets.push(req.body);
  writeData(d); res.json(req.body);
});
app.get('/api/export', (req,res) => {
  const d=readData();
  res.json({members:d.members||[],tickets:d.tickets||[]});
});

// ══════════════════════════════════════
// SESSION STATE — in-memory, single session
// ══════════════════════════════════════
const CONTAINERS = [
  {id:"media",        name:"Media & content",     cost:{vision:2,lead:1.5,ops:1}},
  {id:"onsite",       name:"On-site experience",  cost:{vision:2,lead:1.5,ops:1}},
  {id:"creative_tech",name:"Creative tech",       cost:{vision:2,lead:1.5,ops:1}},
  {id:"comms",        name:"Comms & outreach",    cost:{vision:1.5,lead:1,ops:0.5}},
  {id:"turkish",      name:"Turkish group coord", cost:{vision:1.5,lead:1,ops:0.5}},
  {id:"ops_logistics",name:"Ops & logistics",     cost:{vision:1.5,lead:1,ops:0.5}}
];
const TIME_MAP = {"~2–3h":2.5,"2–3h":2.5,"4–6h":5,"7–10h":8.5,"10h+":12};

let session = {
  active: false,
  team: [],
  pending: [],
  step: 1,           // 1=room, 2=constraints, 3=claim, 4=teams
  claims: {},         // {containerId: {vision:[{name,hours}], lead:[...], ops:[...]}}
  surprises: [],
  claimedCount: 0,    // how many unique people have claimed anything
};

function resetClaims() {
  session.claims = {};
  CONTAINERS.forEach(c => {
    session.claims[c.id] = {vision:[],lead:[],ops:[]};
  });
  session.claimedCount = 0;
}

function countClaimers() {
  const names = new Set();
  CONTAINERS.forEach(c => {
    ['vision','lead','ops'].forEach(r => {
      (session.claims[c.id]?.[r]||[]).forEach(a => names.add(a.name));
    });
  });
  return names.size;
}

function budgetFor(name) {
  const p = session.team.find(t=>t.name===name);
  if(!p) return 5;
  return TIME_MAP[p.timePerWeek] || 5;
}
function usedHours(name) {
  return CONTAINERS.reduce((s,c) =>
    s+['vision','lead','ops'].reduce((s2,r) =>
      s2+(session.claims[c.id]?.[r]?.find(a=>a.name===name)?.hours||0),0),0);
}

// ── SSE clients ──
let clients = [];
function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  clients = clients.filter(c => {
    try { c.write(msg); return true; } catch(e) { return false; }
  });
}
function publicState() {
  return {
    active: session.active,
    step: session.step,
    teamCount: session.team.length,
    claimedCount: session.claimedCount,
    // Step 4 only: full assignments
    claims: session.step >= 4 ? session.claims : null,
    team: session.step >= 4 ? session.team : null,
    surprises: session.step >= 4 ? session.surprises : null,
    pending: session.pending,
  };
}

// ══════════════════════════════════════
// SESSION ROUTES
// ══════════════════════════════════════

// SSE stream
app.get('/api/session/events', (req,res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.flushHeaders();
  clients.push(res);
  res.write(`data: ${JSON.stringify(publicState())}\n\n`);
  req.on('close', () => { clients = clients.filter(c=>c!==res); });
});

// Load team JSON and start session
app.post('/api/session/init', (req,res) => {
  const {members, pending} = req.body;
  if(!members?.length) return res.status(400).json({error:'members required'});
  session.team = members;
  session.pending = (pending||[]).map(p=>({name:p.name,phone:p.phone||''}));
  session.surprises = [];
  session.step = 1;
  session.active = true;
  resetClaims();
  broadcast(publicState());
  res.json({ok:true, memberCount: members.length});
});

// Get current state
app.get('/api/session/state', (req,res) => {
  res.json(publicState());
});

// Get full team (for steps 1+2 rendering)
app.get('/api/session/team', (req,res) => {
  if(!session.active) return res.status(404).json({error:'no active session'});
  res.json({team: session.team, pending: session.pending});
});

// Set step
app.post('/api/session/step', (req,res) => {
  const {step} = req.body;
  if(![1,2,3,4].includes(step)) return res.status(400).json({error:'invalid step'});
  session.step = step;
  broadcast(publicState());
  res.json({ok:true, step});
});

// Claim a role
app.post('/api/session/claim', (req,res) => {
  const {name, cid, role} = req.body;
  if(!name||!cid||!role) return res.status(400).json({error:'missing fields'});
  const c = CONTAINERS.find(x=>x.id===cid);
  if(!c) return res.status(400).json({error:'invalid container'});
  const cost = c.cost[role];
  const budget = budgetFor(name);
  const used = usedHours(name);
  if(used + cost > budget) return res.status(400).json({error:'over budget', remaining: budget-used, cost});
  // Remove from any other role in this container
  ['vision','lead','ops'].forEach(r => {
    session.claims[cid][r] = session.claims[cid][r].filter(a=>a.name!==name);
  });
  session.claims[cid][role].push({name, hours: cost});
  session.claimedCount = countClaimers();
  broadcast(publicState());
  res.json({ok:true});
});

// Unclaim
app.post('/api/session/unclaim', (req,res) => {
  const {name, cid, role} = req.body;
  if(!session.claims[cid]) return res.status(400).json({error:'invalid container'});
  session.claims[cid][role] = session.claims[cid][role].filter(a=>a.name!==name);
  session.claimedCount = countClaimers();
  broadcast(publicState());
  res.json({ok:true});
});

// Step 4: hire someone into a slot
app.post('/api/session/hire', (req,res) => {
  const {name, cid, role} = req.body;
  const c = CONTAINERS.find(x=>x.id===cid);
  if(!c) return res.status(400).json({error:'invalid container'});
  const cost = c.cost[role];
  if(!session.claims[cid][role].find(a=>a.name===name)) {
    session.claims[cid][role].push({name, hours: cost});
  }
  session.claimedCount = countClaimers();
  broadcast(publicState());
  res.json({ok:true});
});

// Step 4: remove from slot
app.post('/api/session/remove', (req,res) => {
  const {name, cid, role} = req.body;
  if(!session.claims[cid]) return res.status(400).json({error:'invalid container'});
  session.claims[cid][role] = session.claims[cid][role].filter(a=>a.name!==name);
  session.claimedCount = countClaimers();
  broadcast(publicState());
  res.json({ok:true});
});

// Add surprise pick
app.post('/api/session/surprise', (req,res) => {
  const {name,phone} = req.body;
  if(!name) return res.status(400).json({error:'name required'});
  if(!session.surprises.find(s=>s.name===name)) session.surprises.push({name,phone:phone||''});
  broadcast(publicState());
  res.json({ok:true});
});

// Remove surprise pick
app.delete('/api/session/surprise/:name', (req,res) => {
  session.surprises = session.surprises.filter(s=>s.name!==decodeURIComponent(req.params.name));
  broadcast(publicState());
  res.json({ok:true});
});

// Serve session page
app.get('/session', (req,res) => {
  res.sendFile(path.join(__dirname,'session.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`YETI × HoBB running on ${PORT}`));
